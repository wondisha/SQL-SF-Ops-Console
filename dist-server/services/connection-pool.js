"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.poolManager = void 0;
const mssql_1 = __importDefault(require("mssql"));
const circuit_breaker_1 = require("./circuit-breaker");
const database_config_1 = require("../config/database.config");
class DatabaseConnectionPoolManager {
    pools = new Map();
    getPool(instanceKey, secretPassword) {
        let entry = this.pools.get(instanceKey);
        if (!entry) {
            const config = (0, database_config_1.enterpriseSqlConfig)(secretPassword);
            const pool = new mssql_1.default.ConnectionPool({
                ...config,
                pool: {
                    min: 2,
                    max: 15,
                    idleTimeoutMillis: 30000,
                    acquireTimeoutMillis: 5000
                }
            });
            pool.on('error', (err) => console.error(`[PoolError:${instanceKey}]`, err));
            const breaker = new circuit_breaker_1.CircuitBreaker(instanceKey, {
                failureThreshold: 3,
                cooldownPeriodMs: 20000,
                requestTimeoutMs: 10000
            });
            entry = { pool, breaker, lastUsed: Date.now() };
            this.pools.set(instanceKey, entry);
        }
        entry.lastUsed = Date.now();
        return entry;
    }
    async executeSafeQuery(instanceKey, secretPassword, queryFn) {
        const { pool, breaker } = this.getPool(instanceKey, secretPassword);
        return breaker.execute(async () => {
            if (!pool.connected && !pool.connecting) {
                await pool.connect();
            }
            return await queryFn(pool);
        });
    }
    async drainAll() {
        for (const [key, entry] of this.pools.entries()) {
            await entry.pool.close().catch(err => console.error(`Error closing pool ${key}:`, err));
        }
        this.pools.clear();
    }
}
exports.poolManager = new DatabaseConnectionPoolManager();
