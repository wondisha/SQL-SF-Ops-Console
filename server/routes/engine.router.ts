import { Router } from 'express';
import { requirePermission } from '../middleware/rbac.middleware';
import { slidingWindowRateLimit } from '../middleware/rate-limiter.middleware';
import { poolManager } from '../services/connection-pool';
import { vaultService } from '../services/vault.service';

const engineRouter = Router();

const diagnosticsLimiter = slidingWindowRateLimit({
  windowMs: 60 * 1000,
  maxRequests: 60,
  keyPrefix: 'diagnostics'
});

engineRouter.get(
  '/sql/:instanceId/top-queries',
  diagnosticsLimiter,
  requirePermission('diagnostics:read'),
  async (req, res) => {
    const { instanceId } = req.params;

    try {
      const secret = await vaultService.getSecret(`${instanceId}-password`);

      const result = await poolManager.executeSafeQuery(instanceId, secret, async (pool) => {
        const queryReq = pool.request();
        return (
          await queryReq.query`
            SELECT TOP 10
              session_id, status, cpu_time, total_elapsed_time, command
            FROM sys.dm_exec_requests
            ORDER BY total_elapsed_time DESC
          `
        ).recordset;
      });

      res.json({ instanceId, data: result });
    } catch (err: any) {
      const status = err.message?.includes('Circuit is OPEN') ? 503 : 500;
      res.status(status).json({ error: 'QUERY_EXECUTION_ERROR', message: err.message });
    }
  }
);

export default engineRouter;
