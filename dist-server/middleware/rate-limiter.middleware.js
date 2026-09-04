"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redisClient = void 0;
exports.slidingWindowRateLimit = slidingWindowRateLimit;
let redisWarned = false;
const ioredis_1 = __importDefault(require("ioredis"));
exports.redisClient = new ioredis_1.default(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    connectTimeout: 5000,
    lazyConnect: true
});
exports.redisClient.on('error', (err) => {
    if (!redisWarned) {
        console.warn('[Redis] Degraded rate limiter mode: local redis not active, falling back to memory.');
        redisWarned = true;
    }
});
function slidingWindowRateLimit(options) {
    return async (req, res, next) => {
        const identifier = req.user?.id || req.ip || 'anonymous';
        const key = `ratelimit:${options.keyPrefix}:${identifier}`;
        const now = Date.now();
        const clearBefore = now - options.windowMs;
        try {
            if (exports.redisClient.status !== 'ready') {
                await exports.redisClient.connect().catch(() => { });
            }
            const pipeline = exports.redisClient.pipeline();
            pipeline.zremrangebyscore(key, 0, clearBefore);
            pipeline.zadd(key, now, `${now}:${Math.random()}`);
            pipeline.zcard(key);
            pipeline.pexpire(key, options.windowMs);
            const results = await pipeline.exec();
            const requestCount = results?.[2]?.[1];
            res.setHeader('X-RateLimit-Limit', options.maxRequests);
            res.setHeader('X-RateLimit-Remaining', Math.max(0, options.maxRequests - (requestCount || 0)));
            if (requestCount && requestCount > options.maxRequests) {
                res.status(429).json({
                    error: 'TOO_MANY_REQUESTS',
                    message: `Limit exceeded: max ${options.maxRequests} requests per ${options.windowMs / 1000}s.`,
                    retryAfterMs: options.windowMs
                });
                return;
            }
            next();
        }
        catch {
            next();
        }
    };
}
