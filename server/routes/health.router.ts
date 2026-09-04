import { Router } from 'express';
import { redisClient } from '../middleware/rate-limiter.middleware';

const healthRouter = Router();

// Liveness Probe: Verifies process responsiveness
healthRouter.get('/live', (_req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

// Readiness Probe: Verifies dependent backing services (Redis cache, etc.)
healthRouter.get('/ready', async (_req, res) => {
  const checks: Record<string, string> = {
    server: 'UP'
  };

  try {
    if (redisClient.status === 'ready' || redisClient.status === 'connecting') {
      await redisClient.ping();
      checks.redis = 'UP';
    } else {
      checks.redis = 'DEGRADED';
    }
  } catch (err: any) {
    checks.redis = `DOWN: ${err.message}`;
  }

  const isHealthy = !Object.values(checks).some(val => val.startsWith('DOWN'));
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'READY' : 'NOT_READY',
    checks,
    timestamp: new Date().toISOString()
  });
});

export default healthRouter;
