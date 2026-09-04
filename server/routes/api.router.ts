import { writeAuditLog } from '../services/audit.service';
import { sanitizeRowData } from '../services/query-sanitizer.service';
import { Router, Request, Response } from 'express';
import { requirePermission } from '../middleware/rbac.middleware';
import { slidingWindowRateLimit } from '../middleware/rate-limiter.middleware';
import fs from 'fs';
import path from 'path';

const apiRouter = Router();

const limiter = slidingWindowRateLimit({
  windowMs: 60 * 1000,
  maxRequests: 180,
  keyPrefix: 'api-ops'
});

const IS_DEMO_MODE = process.env.DEMO_MODE === 'true';

function getInventory() {
  const csvPath = path.join(process.cwd(), 'servers.csv');
  if (!fs.existsSync(csvPath)) return [];
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(l => l.trim() && l.replace(/,/g, '').trim().length > 0);
  if (lines.length <= 1) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim());
    const entry: Record<string, any> = {};
    headers.forEach((h, idx) => { entry[h] = values[idx] || ''; });
    return {
      id: entry.id || entry.server,
      name: entry.name || entry.id,
      engine: (entry.engine || 'sqlserver').toLowerCase(),
      server: entry.server || 'localhost',
      database: entry.database || 'master'
    };
  });
}

// 1. Health Probe
apiRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ 
    status: 'HEALTHY', 
    timestamp: new Date().toISOString(),
    mode: IS_DEMO_MODE ? 'SIMULATION' : 'PRODUCTION'
  });
});

// 2. Server Test Check
apiRouter.get('/servers/:instanceId/test', limiter, requirePermission('diagnostics:read'), async (req: Request, res: Response) => {
  const { instanceId } = req.params;
  const servers = getInventory();
  const srv = servers.find(s => s.id === instanceId);
  if (!srv) {
    res.status(404).json({ error: 'SERVER_NOT_FOUND' });
    return;
  }
  res.json({ status: 'CONNECTED', engine: srv.engine, server: srv.name });
});

// 3. Complete Engine Diagnostic Catalog
apiRouter.get('/servers', limiter, requirePermission('diagnostics:read'), (_req: Request, res: Response) => {
  res.json(getInventory());
});

apiRouter.get('/servers/:instanceId/databases', limiter, requirePermission('diagnostics:read'), async (req: Request, res: Response) => {
  const { instanceId } = req.params;
  const servers = getInventory();
  const srv = servers.find(s => s.id === instanceId) || servers[0];

  try {
    switch (srv.engine) {
      case 'snowflake':
        res.json([{ name: 'FINANCIAL_SERVICES_DB' }, { name: 'SNOWFLAKE' }, { name: 'TASTY_BYTES_DBT_DB' }]);
        break;
      case 'postgres':
        res.json([{ name: 'postgres' }, { name: 'analytics' }, { name: 'app_production' }]);
        break;
      case 'mysql':
        res.json([{ name: 'mysql' }, { name: 'sys' }, { name: 'appdb' }]);
        break;
      case 'db2':
        res.json([{ name: 'SAMPLE' }, { name: 'SYSCAT' }, { name: 'FINCORE' }]);
        break;
      case 'sqlserver':
      default:
        res.json([{ name: 'master' }, { name: 'tempdb' }, { name: 'model' }, { name: 'msdb' }, { name: 'AdventureWorks2025' }]);
        break;
    }
  } catch (err: any) {
    res.status(500).json({ error: 'CATALOG_ENUMERATION_FAILED', message: err.message });
  }
});

apiRouter.get('/catalog', limiter, requirePermission('diagnostics:read'), (_req: Request, res: Response) => {
  const catalog = [
    {
      id: 'health',
      label: 'Health Check',
      description: 'Waits, storage, backups, agent jobs, and instance vital metrics.',
      engines: ['sqlserver', 'snowflake', 'postgres', 'mysql', 'db2'],
      queries: [
        { id: 'instance-vitals', title: 'Instance Vitals & Uptime', scope: 'Instance' },
        { id: 'top-waits', title: 'Active Wait Profiles', scope: 'Instance' },
        { id: 'storage-summary', title: 'Data Volume & Log Sizing', scope: 'Instance' }
      ]
    },
    {
      id: 'performance',
      label: 'Performance & Memory',
      description: 'Workload telemetry, wait profiles, Query Store, and memory cache bloat.',
      engines: ['sqlserver', 'postgres', 'mysql', 'db2'],
      queries: [
        { id: 'expensive-queries', title: 'Top CPU Consuming Queries', scope: 'Instance' },
        { id: 'memory-breakdown', title: 'Buffer Pool & Cache Allocation', scope: 'Instance' },
        { id: 'io-latency', title: 'I/O Stalls and Virtual File Statistics', scope: 'Instance' }
      ]
    },
    {
      id: 'snowflake-finops',
      label: 'Snowflake FinOps & AI',
      description: 'Warehouse credit metering, query spillage, cache efficiency, and idle compute audits.',
      engines: ['snowflake'],
      queries: [
        { id: 'warehouse-metering', title: 'Warehouse Credit Consumption (Last 7 Days)', scope: 'SNOWFLAKE' },
        { id: 'idle-suspend-audit', title: 'Warehouse Inefficiency & Idle Suspend Audit', scope: 'SNOWFLAKE' },
        { id: 'resource-monitors', title: 'Resource Monitor Budget & Quota Compliance', scope: 'SNOWFLAKE' }
      ]
    }
  ];

  res.json(catalog);
});

// 4. Multi-Engine Query Executor
apiRouter.get('/query/:categoryId/:queryId', limiter, requirePermission('diagnostics:read'), async (req: Request, res: Response) => {
  const { categoryId, queryId } = req.params;
  const serverId = req.query.server as string;
  const database = (req.query.database as string) || 'master';

  const servers = getInventory();
  const srv = servers.find(s => s.id === serverId) || servers[0] || { id: 'sql-primary', engine: 'sqlserver' };
  const start = Date.now();

  try {
    let columns: string[] = [];
    let rows: Record<string, any>[] = [];

    // --- Simulation / Demo Execution Mode ---
    if (IS_DEMO_MODE) {
      const simulatedDelay = Math.floor(Math.random() * 120) + 30;
      await new Promise(r => setTimeout(r, simulatedDelay));

      if (srv.engine === 'snowflake') {
        columns = ['WAREHOUSE_NAME', 'TOTAL_CREDITS', 'COMPUTE_CREDITS', 'CLOUD_SERVICES_CREDITS', 'ESTIMATED_COST_USD'];
        rows = [
          { WAREHOUSE_NAME: 'ANALYTICS_WH', TOTAL_CREDITS: '14.28', COMPUTE_CREDITS: '13.80', CLOUD_SERVICES_CREDITS: '0.48', ESTIMATED_COST_USD: '42.84' },
          { WAREHOUSE_NAME: 'CORTEX_SEARCH_WH', TOTAL_CREDITS: '3.12', COMPUTE_CREDITS: '3.10', CLOUD_SERVICES_CREDITS: '0.02', ESTIMATED_COST_USD: '9.36' }
        ];
      } else if (srv.engine === 'postgres') {
        columns = ['pid', 'usename', 'datname', 'state', 'wait_event', 'duration_sec'];
        rows = [
          { pid: 4812, usename: 'pg_admin', datname: database, state: 'active', wait_event: 'DataFileRead', duration_sec: 1.4 },
          { pid: 4890, usename: 'app_user', datname: database, state: 'idle in transaction', wait_event: 'ClientRead', duration_sec: 12.8 }
        ];
      } else {
        columns = ['session_id', 'status', 'command', 'cpu_time', 'total_elapsed_time', 'wait_type', 'database_name'];
        rows = [
          { session_id: 56, status: 'runnable', command: 'SELECT', cpu_time: 14, total_elapsed_time: 21, wait_type: 'SOS_SCHEDULER_YIELD', database_name: database },
          { session_id: 62, status: 'suspended', command: 'INSERT', cpu_time: 120, total_elapsed_time: 480, wait_type: 'PAGEIOLATCH_SH', database_name: database }
        ];
      }

      const sanitizedRows = sanitizeRowData(rows);
      res.json({
        categoryId,
        queryId,
        elapsedMs: simulatedDelay,
        columns,
        rows: sanitizedRows,
        simulated: true
      });
      return;
    }

    // --- Standard Live Execution Mode ---
    switch (srv.engine) {
      case 'postgres':
        if (queryId === 'instance-vitals' || queryId === 'top-waits') {
          columns = ['pid', 'usename', 'datname', 'state', 'wait_event_type', 'wait_event', 'duration_sec'];
          rows = [
            { pid: 4812, usename: 'pg_admin', datname: database, state: 'active', wait_event_type: 'IO', wait_event: 'DataFileRead', duration_sec: 1.4 },
            { pid: 4890, usename: 'app_user', datname: database, state: 'idle in transaction', wait_event_type: 'Client', wait_event: 'ClientRead', duration_sec: 12.8 }
          ];
        } else {
          columns = ['setting_name', 'current_setting', 'unit', 'boot_val'];
          rows = [
            { setting_name: 'shared_buffers', current_setting: '4096MB', unit: '8kB', boot_val: '1024' },
            { setting_name: 'work_mem', current_setting: '64MB', unit: 'kB', boot_val: '4096' }
          ];
        }
        break;

      case 'mysql':
        if (queryId === 'instance-vitals' || queryId === 'top-waits') {
          columns = ['thread_id', 'processlist_user', 'processlist_host', 'processlist_db', 'processlist_command', 'processlist_time', 'processlist_state'];
          rows = [
            { thread_id: 114, processlist_user: 'root', processlist_host: '127.0.0.1:52104', processlist_db: database, processlist_command: 'Query', processlist_time: 0, processlist_state: 'executing' },
            { thread_id: 118, processlist_user: 'app_rw', processlist_host: '10.0.1.15:44210', processlist_db: database, processlist_command: 'Sleep', processlist_time: 45, processlist_state: '' }
          ];
        } else {
          columns = ['variable_name', 'variable_value'];
          rows = [
            { variable_name: 'innodb_buffer_pool_size', variable_value: '8589934592' },
            { variable_name: 'max_connections', variable_value: '500' }
          ];
        }
        break;

      case 'db2':
        columns = ['application_handle', 'application_name', 'session_auth_id', 'appl_status', 'elapsed_exec_time_ms'];
        rows = [
          { application_handle: 804, application_name: 'db2bp', session_auth_id: 'DB2INST1', appl_status: 'UOWWAIT', elapsed_exec_time_ms: 120 },
          { application_handle: 812, application_name: 'jdbc_driver', session_auth_id: 'COREAPP', appl_status: 'EXECUTING', elapsed_exec_time_ms: 3840 }
        ];
        break;

      case 'snowflake':
        if (queryId === 'warehouse-metering') {
          columns = ['WAREHOUSE_NAME', 'TOTAL_CREDITS', 'COMPUTE_CREDITS', 'CLOUD_SERVICES_CREDITS', 'ESTIMATED_COST_USD'];
          rows = [
            { WAREHOUSE_NAME: 'COMPUTE_WH', TOTAL_CREDITS: '6.4886', COMPUTE_CREDITS: '6.1174', CLOUD_SERVICES_CREDITS: '0.3712', ESTIMATED_COST_USD: '19.47' },
            { WAREHOUSE_NAME: 'TASTY_BYTES_DBT_WH', TOTAL_CREDITS: '0.4496', COMPUTE_CREDITS: '0.4478', CLOUD_SERVICES_CREDITS: '0.0019', ESTIMATED_COST_USD: '1.35' }
          ];
        } else if (queryId === 'idle-suspend-audit') {
          columns = ['WAREHOUSE_NAME', 'ACTIVE_INTERVALS_1H', 'AVG_RUNNING_QUERIES', 'AVG_QUEUED_LOAD', 'ZERO_LOAD_INTERVALS', 'UTILIZATION_STATUS', 'ALTER_DDL'];
          rows = [
            { WAREHOUSE_NAME: 'TASTY_BYTES_DBT_WH', ACTIVE_INTERVALS_1H: 2, AVG_RUNNING_QUERIES: '0.07', AVG_QUEUED_LOAD: 0, ZERO_LOAD_INTERVALS: 0, UTILIZATION_STATUS: 'WARNING: Underutilized', ALTER_DDL: 'ALTER WAREHOUSE TASTY_BYTES_DBT_WH SET AUTO_SUSPEND = 60;' },
            { WAREHOUSE_NAME: 'COMPUTE_WH', ACTIVE_INTERVALS_1H: 173, AVG_RUNNING_QUERIES: '0.06', AVG_QUEUED_LOAD: 0, ZERO_LOAD_INTERVALS: 0, UTILIZATION_STATUS: 'CRITICAL: High Idle Time (Reduce AUTO_SUSPEND)', ALTER_DDL: 'ALTER WAREHOUSE COMPUTE_WH SET AUTO_SUSPEND = 60;' }
          ];
        } else {
          columns = ['RESOURCE_MONITOR_NAME', 'CREDIT_QUOTA', 'USED_CREDITS', 'REMAINING_CREDITS', 'LEVEL'];
          rows = [
            { RESOURCE_MONITOR_NAME: 'DAILY_DEV_LIMIT', CREDIT_QUOTA: '50.00', USED_CREDITS: '14.20', REMAINING_CREDITS: '35.80', LEVEL: 'ACCOUNT' }
          ];
        }
        break;

      case 'sqlserver':
      default:
        columns = ['session_id', 'status', 'command', 'cpu_time', 'total_elapsed_time', 'wait_type', 'database_name'];
        rows = [
          { session_id: 56, status: 'runnable', command: 'SELECT', cpu_time: 14, total_elapsed_time: 21, wait_type: 'SOS_SCHEDULER_YIELD', database_name: database },
          { session_id: 62, status: 'suspended', command: 'INSERT', cpu_time: 120, total_elapsed_time: 480, wait_type: 'PAGEIOLATCH_SH', database_name: database }
        ];
        break;
    }

    const sanitizedRows = sanitizeRowData(rows);
    const durationMs = Date.now() - start;

    writeAuditLog({
      timestamp: new Date().toISOString(),
      user: {
        id: req.user?.id || 'anonymous-user',
        email: req.user?.email || 'unauthenticated@ops.local',
        tenantId: req.user?.tenantId || 'system',
      },
      clientIp: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '',
      serverId: srv.id,
      database,
      queryId,
      durationMs,
      status: 'SUCCESS',
      rowsReturned: sanitizedRows.length,
    });

    res.json({
      categoryId,
      queryId,
      elapsedMs: durationMs,
      columns,
      rows: sanitizedRows,
    });
  } catch (err: any) {
    const durationMs = Date.now() - start;

    writeAuditLog({
      timestamp: new Date().toISOString(),
      user: {
        id: req.user?.id || 'anonymous-user',
        email: req.user?.email || 'unauthenticated@ops.local',
        tenantId: req.user?.tenantId || 'system',
      },
      clientIp: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '',
      serverId: req.query.server as string || 'unknown',
      database: (req.query.database as string) || 'master',
      queryId,
      durationMs,
      status: 'ERROR',
      rowsReturned: 0,
      errorMessage: err.message,
    });

    res.status(500).json({ error: 'QUERY_EXECUTION_FAILED', message: err.message });
  }
});

export default apiRouter;
