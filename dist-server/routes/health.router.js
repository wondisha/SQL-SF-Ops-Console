"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const rate_limiter_middleware_1 = require("../middleware/rate-limiter.middleware");
const healthRouter = (0, express_1.Router)();
// Liveness Probe: Verifies process responsiveness
healthRouter.get('/live', (_req, res) => {
    res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});
// Readiness Probe: Verifies dependent backing services (Redis cache, etc.)
healthRouter.get('/ready', async (_req, res) => {
    const checks = {
        server: 'UP'
    };
    try {
        if (rate_limiter_middleware_1.redisClient.status === 'ready' || rate_limiter_middleware_1.redisClient.status === 'connecting') {
            await rate_limiter_middleware_1.redisClient.ping();
            checks.redis = 'UP';
        }
        else {
            checks.redis = 'DEGRADED';
        }
    }
    catch (err) {
        checks.redis = `DOWN: ${err.message}`;
    }
    const isHealthy = !Object.values(checks).some(val => val.startsWith('DOWN'));
    res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? 'READY' : 'NOT_READY',
        checks,
        timestamp: new Date().toISOString()
    });
});
exports.default = healthRouter;
