import mssql from 'mssql';
import { CircuitBreaker } from './circuit-breaker';
import { enterpriseSqlConfig } from '../config/database.config';

interface EnginePoolEntry {
  pool: mssql.ConnectionPool;
  breaker: CircuitBreaker;
  lastUsed: number;
}

class DatabaseConnectionPoolManager {
  private pools = new Map<string, EnginePoolEntry>();

  public getPool(instanceKey: string, secretPassword: string): EnginePoolEntry {
    let entry = this.pools.get(instanceKey);

    if (!entry) {
      const config = enterpriseSqlConfig(secretPassword);
      const pool = new mssql.ConnectionPool({
        ...config,
        pool: {
          min: 2,
          max: 15,
          idleTimeoutMillis: 30000,
          acquireTimeoutMillis: 5000
        }
      });

      pool.on('error', (err) => console.error(`[PoolError:${instanceKey}]`, err));

      const breaker = new CircuitBreaker(instanceKey, {
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

  public async executeSafeQuery<T>(
    instanceKey: string,
    secretPassword: string,
    queryFn: (connectedPool: mssql.ConnectionPool) => Promise<T>
  ): Promise<T> {
    const { pool, breaker } = this.getPool(instanceKey, secretPassword);

    return breaker.execute(async () => {
      if (!pool.connected && !pool.connecting) {
        await pool.connect();
      }
      return await queryFn(pool);
    });
  }

  public async drainAll(): Promise<void> {
    for (const [key, entry] of this.pools.entries()) {
      await entry.pool.close().catch(err => console.error(`Error closing pool ${key}:`, err));
    }
    this.pools.clear();
  }
}

export const poolManager = new DatabaseConnectionPoolManager();
