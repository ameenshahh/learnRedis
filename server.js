const express = require("express");
const axios = require("axios");
const { performance } = require('perf_hooks');
const redis = require("redis");

const app = express();
const port = process.env.PORT || 3000;

// redis setup
let redisClient;

(async () => {
    redisClient = redis.createClient();

    redisClient.on("error", (error) => console.error(`Error : ${error}`));

    await redisClient.connect();
})();

async function fetchApiData(species) {
    let start = performance.now();
    const apiResponse = await axios.get(`https://www.fishwatch.gov/api/species/${species}`);
    console.log(`Request sent to API and took ${(performance.now() - start) / 1000} seconds`)
    return apiResponse.data
}

// caching middleware
async function cacheData(req, res, next) {
    const species = req.params.species;
    let results;
    try {
        const cacheResults = await redisClient.get(species);
        if (cacheResults) {
            results = JSON.parse(cacheResults);
            res.send({
                fromCache: true,
                data: results,
            });
        } else {
            next();
        }
    } catch (error) {
        console.error(error);
        res.status(404);
    }
}

// rate limiting middleware
function rateLimiter(rule) {
    const { endpoint, rate_limit } = rule;

    return async (request, response, next) => {
        const ipAddress = request.ip;
        const redisId = `${endpoint}/${ipAddress}`;
        const requests = await redisClient.incr(redisId);

        if (requests === 1) {
            await redisClient.expire(redisId, rate_limit.time);
        }

        if (requests > rate_limit.limit) {
            return response.status(429).send({ message: 'too much requests' });
        }

        next();
    };
}

async function getSpeciesData(req, res) {
    const species = req.params.species;
    let results;

    try {

        results = await fetchApiData(species);
        if (results.length === 0) {
            throw "API returned an empty array";
        }
        await redisClient.set(species, JSON.stringify(results), {
            EX: 5,
            NX: true,
        });

        res.send({
            fromCache: false,
            data: results,
        });
    } catch (error) {
        console.error(error);
        res.status(404).send("Data unavailable");
    }
}
const USER_RATE_LIMIT_RULE = {
    endpoint: '/fish/:species',
    rate_limit: {
        time: 60,
        limit: 3
    },
};

app.get("/fish/:species", rateLimiter(USER_RATE_LIMIT_RULE), cacheData, getSpeciesData);


app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});