"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const rbac_middleware_1 = require("../middleware/rbac.middleware");
const rate_limiter_middleware_1 = require("../middleware/rate-limiter.middleware");
const connection_pool_1 = require("../services/connection-pool");
const vault_service_1 = require("../services/vault.service");
const engineRouter = (0, express_1.Router)();
const diagnosticsLimiter = (0, rate_limiter_middleware_1.slidingWindowRateLimit)({
    windowMs: 60 * 1000,
    maxRequests: 60,
    keyPrefix: 'diagnostics'
});
engineRouter.get('/sql/:instanceId/top-queries', diagnosticsLimiter, (0, rbac_middleware_1.requirePermission)('diagnostics:read'), async (req, res) => {
    const { instanceId } = req.params;
    try {
        const secret = await vault_service_1.vaultService.getSecret(`${instanceId}-password`);
        const result = await connection_pool_1.poolManager.executeSafeQuery(instanceId, secret, async (pool) => {
            const queryReq = pool.request();
            return (await queryReq.query `
            SELECT TOP 10
              session_id, status, cpu_time, total_elapsed_time, command
            FROM sys.dm_exec_requests
            ORDER BY total_elapsed_time DESC
          `).recordset;
        });
        res.json({ instanceId, data: result });
    }
    catch (err) {
        const status = err.message?.includes('Circuit is OPEN') ? 503 : 500;
        res.status(status).json({ error: 'QUERY_EXECUTION_ERROR', message: err.message });
    }
});
exports.default = engineRouter;
