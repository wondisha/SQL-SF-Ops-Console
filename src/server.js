const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
require('dotenv').config();

let snowflake = null;
try {
    snowflake = require('snowflake-sdk');
} catch (e) {
    console.warn('snowflake-sdk not installed. Snowflake telemetry requires npm install snowflake-sdk.');
}

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------- static folder auto-resolution
const frontendPath = [
    path.join(__dirname, '../public'),
    path.join(process.cwd(), 'public'),
    path.join(__dirname, '../../frontend'),
    path.join(process.cwd(), 'frontend'),
    path.join(__dirname, '../frontend')
].find(p => fs.existsSync(path.join(p, 'index.html'))) || path.join(process.cwd(), 'public');

console.log(`Serving static UI from: ${frontendPath}`);
app.use(express.static(frontendPath));

const auditLogPath = path.join(process.cwd(), 'audit_log.json');
const csvConfigPath = path.join(process.cwd(), 'servers.csv');
const jsonConfigPath = path.join(process.cwd(), 'servers.json');

// ---------------------------------------------------------------- helpers & security utilities

function quoteIdentifier(identifier) {
    if (!identifier || typeof identifier !== 'string') {
        throw new Error('Invalid database identifier.');
    }
    return `[${identifier.replace(/]/g, ']]')}]`;
}

async function getAuditLogs() {
    try {
        const data = await fsPromises.readFile(auditLogPath, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

async function logAuditEvent(actionName, targetDb, details) {
    try {
        const logs = await getAuditLogs();
        logs.unshift({
            timestamp: new Date().toISOString(),
            action: actionName,
            database: targetDb || 'Instance-Wide',
            details: details || 'Executed via Dashboard Console'
        });
        await fsPromises.writeFile(auditLogPath, JSON.stringify(logs.slice(0, 1000), null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to persist audit log:', err.message);
    }
}

function parseCsvServers(content) {
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length <= 1) return [];

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    return lines.slice(1).filter(l => l.trim() && l.replace(/,/g, '').trim().length > 0).map(line => {
        const values = line.split(',').map(v => v.trim());
        const entry = {};
        headers.forEach((h, idx) => {
            entry[h] = values[idx] || '';
        });
        return {
            id: entry.id || entry.server || 'unnamed',
            name: entry.name || entry.id || entry.server,
            server: entry.server || 'localhost',
            database: entry.database || 'master',
            engine: (entry.engine || entry.auth || 'sqlserver').toLowerCase(),
            warehouse: entry.warehouse || process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH',
            schema: entry.schema || 'PUBLIC',
            role: entry.role || process.env.SNOWFLAKE_ROLE || 'ACCOUNTADMIN',
            user: entry.user || process.env.DB_USER || process.env.SNOWFLAKE_USER,
            password: entry.password || process.env.DB_PASSWORD || process.env.SNOWFLAKE_PASSWORD,
            encrypt: String(entry.encrypt).toLowerCase() === 'true'
        };
    });
}

function getServersList() {
    try {
        if (fs.existsSync(csvConfigPath)) {
            const data = fs.readFileSync(csvConfigPath, 'utf8');
            const parsed = parseCsvServers(data);
            if (parsed.length > 0) return parsed;
        }
    } catch (e) {
        console.error('Error reading servers.csv:', e.message);
    }

    try {
        if (fs.existsSync(jsonConfigPath)) {
            const data = fs.readFileSync(jsonConfigPath, 'utf8');
            const parsed = jsonConfigPath ? JSON.parse(data) : [];
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch (e) {}

    return [
        {
            id: process.env.DB_SERVER || 'Local',
            name: process.env.DB_SERVER || 'Local SQL Server',
            server: process.env.DB_SERVER || 'localhost',
            database: process.env.DB_NAME || 'master',
            engine: 'sqlserver',
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            encrypt: process.env.DB_ENCRYPT === 'true' || false
        }
    ];
}

// ---------------------------------------------------------------- connection pool registry (MSSQL & Snowflake)
const connectionPools = new Map();
const snowflakePools = new Map();

async function getPool(serverId) {
    const servers = getServersList();
    const srv = servers.find(s => s.id === serverId || s.name === serverId) || servers[0];
    const key = `mssql_${srv.id}`;

    let pool = connectionPools.get(key);
    if (pool && pool.connected) {
        return pool;
    }

    if (pool) {
        try {
            await pool.close();
        } catch (_) {}
    }

    const hasSqlAuth = Boolean(srv.user && srv.user.trim() !== '' && srv.password && srv.password.trim() !== '');

    const config = {
        server: srv.server || 'localhost',
        database: srv.database || 'master',
        options: {
            encrypt: srv.encrypt ?? (process.env.DB_ENCRYPT === 'true'),
            trustServerCertificate: true,
            connectTimeout: 10000,
            requestTimeout: 45000,
            enableArithAbort: true
        },
        pool: {
            max: 10,
            min: 1,
            idleTimeoutMillis: 30000
        }
    };

    if (hasSqlAuth) {
        config.user = srv.user;
        config.password = srv.password;
    } else {
        config.options.trustedConnection = true;
    }

    pool = new sql.ConnectionPool(config);
    await pool.connect();
    connectionPools.set(key, pool);
    return pool;
}

function getSnowflakePool(serverId) {
    if (!snowflake) {
        throw new Error('snowflake-sdk is not installed. Run "npm install snowflake-sdk".');
    }

    const servers = getServersList();
    const srv = servers.find(s => (s.id === serverId || s.name === serverId) && s.engine === 'snowflake') 
             || servers.find(s => s.engine === 'snowflake') 
             || {};

    const account = srv.server || process.env.SNOWFLAKE_ACCOUNT;
    const username = srv.user || process.env.SNOWFLAKE_USER;
    const password = srv.password || process.env.SNOWFLAKE_PASSWORD;

    if (!username || !account) {
        throw new Error('Valid Snowflake credentials missing. Configure a Snowflake instance in servers.csv or set SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, and SNOWFLAKE_PASSWORD in .env.');
    }

    const key = `sf_${srv.id || account}`;
    if (snowflakePools.has(key)) {
        return snowflakePools.get(key);
    }

    const pool = snowflake.createPool(
        {
            account: account,
            username: username,
            password: password,
            warehouse: srv.warehouse || process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH',
            database: srv.database || process.env.SNOWFLAKE_DATABASE || 'SNOWFLAKE',
            schema: srv.schema || 'ACCOUNT_USAGE',
            role: srv.role || process.env.SNOWFLAKE_ROLE || 'ACCOUNTADMIN',
            clientSessionKeepAlive: true,
            clientSessionKeepAliveHeartbeatFrequency: 1800
        },
        {
            max: 5,
            min: 1,
            evictionRunIntervalMillis: 60000,
            idleTimeoutMillis: 120000
        }
    );

    snowflakePools.set(key, pool);
    return pool;
}

function executeSnowflakeQuery(serverId, sqlText, binds = []) {
    return new Promise((resolve, reject) => {
        try {
            const pool = getSnowflakePool(serverId);
            pool.use(async (connection) => {
                return new Promise((innerResolve, innerReject) => {
                    connection.execute({
                        sqlText,
                        binds,
                        complete: (err, stmt, rows) => {
                            if (err) return innerReject(err);
                            innerResolve(rows);
                        }
                    });
                });
            }).then(resolve).catch(reject);
        } catch (err) {
            reject(err);
        }
    });
}

// ==========================================
// CONFIGURATION & CATALOG ENDPOINTS
// ==========================================
app.get('/api/servers', (req, res) => {
    const list = getServersList().map(s => ({
        id: s.id,
        name: s.name || s.id,
        database: s.database || (s.engine === 'snowflake' ? 'SNOWFLAKE' : 'master'),
        engine: s.engine || 'sqlserver'
    }));
    res.json(list);
});

app.get('/api/servers/:serverId/databases', async (req, res) => {
    const servers = getServersList();
    const serverId = req.params.serverId;
    const srv = servers.find(s => s.id === serverId || s.name === serverId) || servers[0];

    try {
        if (srv.engine === 'snowflake') {
            try {
                const rows = await executeSnowflakeQuery(srv.id, 'SHOW DATABASES;');
                const dbs = rows.map(r => ({ name: r.name || r.DATABASE_NAME || r.NAME }));
                if (dbs.length > 0) return res.json(dbs);
            } catch (sfErr) {
                console.warn('Snowflake dynamic DB fetch fallback:', sfErr.message);
            }
            return res.json([
                { name: 'SNOWFLAKE' },
                { name: 'SNOWFLAKE_SAMPLE_DATA' },
                { name: srv.database || 'SNOWFLAKE' }
            ]);
        }

        const pool = await getPool(srv.id);
        const result = await pool.request().query("SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name;");
        res.json(result.recordset);
    } catch (err) {
        console.error(`Database list fetch error for ${serverId}:`, err.message);
        res.json([{ name: srv.database || 'master' }]);
    }
});

app.get('/api/servers/:serverId/test', async (req, res) => {
    const servers = getServersList();
    const srv = servers.find(s => s.id === req.params.serverId || s.name === req.params.serverId) || servers[0];

    try {
        if (srv.engine === 'snowflake') {
            await executeSnowflakeQuery(req.params.serverId, 'SELECT CURRENT_VERSION();');
            return res.json({ success: true, engine: 'snowflake' });
        }

        const pool = await getPool(req.params.serverId);
        await pool.request().query('SELECT 1 AS status');
        res.json({ success: true, engine: 'sqlserver' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/catalog', (req, res) => {
    res.json([
        {
            id: "health-check",
            label: "Health Check",
            description: "Daily DBA query pack — waits, storage, backups, agent jobs, and instance health.",
            queries: [
                {
                    id: "server-uptime",
                    label: "SQL Server Uptime & Version",
                    script: "Health Telemetry",
                    description: "Checks underlying engine version and last startup time."
                },
                {
                    id: "backup-history",
                    label: "Database Backup RPO History",
                    script: "Backup Compliance",
                    description: "Tracks the last successful full backup timestamp for disaster recovery."
                },
                {
                    id: "agent-job-failures",
                    label: "SQL Server Agent Job Failures (Last 24h)",
                    script: "Job Monitoring",
                    description: "Audits failed SQL Agent jobs and step execution messages across the instance."
                },
                {
                    id: "drive-space",
                    label: "Host Storage Volume Capacity",
                    script: "Disk Utilization",
                    description: "Monitors free storage capacity across all mounted database drive volumes."
                }
            ]
        },
        {
            id: "performance",
            label: "Performance & Memory",
            description: "Workload telemetry, wait profiles, Query Store metrics, buffer pool health, and plan cache bloat.",
            queries: [
                {
                    id: "wait-stats-summary",
                    label: "Top 15 Wait Statistics Profile",
                    script: "Wait Telemetry",
                    description: "Surfaces active resource bottlenecks (CPU, Disk I/O, Lock Contention, Network)."
                },
                {
                    id: "query-store-waits",
                    label: "Query Store Top Wait Statistics (24h)",
                    script: "Query Store Waits",
                    description: "Aggregates top wait categories and impact across all Query Store queries."
                },
                {
                    id: "memory-buffer-health",
                    label: "Buffer Pool & PLE Memory Health",
                    script: "Memory Subsystem",
                    description: "Audits Page Life Expectancy and memory workspace grant pressure."
                },
                {
                    id: "plan-cache-bloat",
                    label: "Plan Cache Size & Ad-Hoc Bloat",
                    script: "Cache Telemetry",
                    description: "Measures single-use cached plans polluting instance memory."
                },
                {
                    id: "query-store-insights",
                    label: "Query Store Top CPU Consumers",
                    script: "Query Store Telemetry",
                    description: "Analyzes active Query Store runtime stats for high CPU usage queries.",
                    actions: [
                        {
                            label: "Download .sqlplan",
                            variant: "primary",
                            endpoint: "/api/actions/download-plan",
                            isDownload: true,
                            paramKeys: { plan_id: "plan_id", query_id: "query_id" }
                        }
                    ]
                }
            ]
        },
        {
            id: "index-maintenance",
            label: "Index Maintenance",
            description: "Index health, missing index suggestions, and physical fragmentation remediation.",
            queries: [
                {
                    id: "missing-indexes",
                    label: "Missing Index Recommendations",
                    script: "Performance Tuning",
                    description: "High-impact index recommendations surfaced by SQL Server query optimizer with auto-generated DDL.",
                    actions: [
                        {
                            label: "Create Index",
                            variant: "primary",
                            endpoint: "/api/actions/execute-ddl",
                            confirmPrompt: "Execute CREATE INDEX DDL on {database_name}?",
                            paramKeys: { database: "database_name", sql: "CREATE_INDEX_DDL" }
                        }
                    ]
                },
                {
                    id: "index-fragmentation",
                    label: "High Fragmentation Indexes (>10%)",
                    script: "Index Health",
                    description: "Scans physical fragmentation levels across database indexes with Rebuild/Reorganize actions.",
                    actions: [
                        {
                            label: "Rebuild / Reorg Index",
                            variant: "warning",
                            endpoint: "/api/actions/execute-ddl",
                            confirmPrompt: "Execute index maintenance on {table_name} ([{index_name}]) in {database_name}?\n\nCommand: {REMEDIATION_SQL}",
                            paramKeys: { database: "database_name", sql: "REMEDIATION_SQL" }
                        }
                    ]
                }
            ]
        },
        {
            id: "blocking-deadlocks",
            label: "Blocking & Deadlocks",
            description: "Real-time active workload, blocking chains, and session termination controls.",
            queries: [
                {
                    id: "active-blockers",
                    label: "Active Blocking Sessions",
                    script: "Blocking Chains",
                    description: "Identifies active sessions currently blocking other worker requests.",
                    actions: [
                        {
                            label: "Kill SPID",
                            variant: "danger",
                            endpoint: "/api/actions/kill-session",
                            confirmPrompt: "WARNING: Terminate blocking session SPID {blocking_session_id}?",
                            paramKeys: { spid: "blocking_session_id" }
                        }
                    ]
                },
                {
                    id: "long-running-transactions",
                    label: "Active Running Queries & Workload",
                    script: "Request Monitor",
                    description: "Tracks active executing queries, elapsed times, statement text, and session controls.",
                    actions: [
                        {
                            label: "Kill Session",
                            variant: "danger",
                            endpoint: "/api/actions/kill-session",
                            confirmPrompt: "WARNING: Terminate running SPID {session_id}?",
                            paramKeys: { spid: "session_id" }
                        }
                    ]
                },
                {
                    id: "deadlock-history",
                    label: "Recent Deadlock Events (system_health)",
                    script: "Extended Events Deadlock Audit",
                    description: "Extracts recent deadlock graphs captured by the default system_health session with direct .xdl file export.",
                    actions: [
                        {
                            label: "Download .xdl Graph",
                            variant: "danger",
                            endpoint: "/api/actions/download-deadlock",
                            isDownload: true,
                            paramKeys: { event_time: "deadlock_time" }
                        }
                    ]
                }
            ]
        },
        {
            id: "storage-vlf",
            label: "Storage & VLF Health",
            description: "Transaction log fragmentation, file sizing, and tempdb allocation contention.",
            queries: [
                {
                    id: "vlf-health",
                    label: "Virtual Log File (VLF) Fragmentation",
                    script: "Log Fragmentation",
                    description: "Audits transaction log VLF counts to detect log performance degradation."
                },
                {
                    id: "tempdb-contention",
                    label: "TempDB Allocation Contention (PFS / GAM / SGAM)",
                    script: "TempDB Latch Audit",
                    description: "Monitors active page latch wait contention on TempDB allocation bitmap pages."
                },
                {
                    id: "file-growth-config",
                    label: "Detailed File Growth & Autogrowth Config",
                    script: "Storage Audit",
                    description: "Audits file properties, sizes, max sizes, and growth configurations."
                },
                {
                    id: "tempdb-config",
                    label: "TempDB Configuration & File Sizing",
                    script: "TempDB Baseline",
                    description: "Audits TempDB file counts and equal sizing allocation compliance."
                }
            ]
        },
        {
            id: "ag-health",
            label: "AG Health",
            description: "Always On Availability Group replica and sync status checks.",
            queries: [
                {
                    id: "ag-replica-states",
                    label: "Availability Group Replica Status & Sync Health",
                    script: "sys.dm_hadr_replica_states",
                    description: "Monitors synchronization, operational states, and commit timestamps for Availability Groups."
                }
            ]
        },
        {
            id: "snowflake-finops",
            label: "Snowflake FinOps & AI",
            description: "Warehouse credit metering, query spillage, cache efficiency, and idle compute audits.",
            queries: [
                {
                    id: "warehouse-metering",
                    label: "Warehouse Credit Consumption (Last 7 Days)",
                    script: "SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY",
                    description: "Tracks compute and cloud service credits consumed per virtual warehouse."
                },
                {
                    id: "idle-warehouse-costs",
                    label: "Warehouse Inefficiency & Idle Suspend Audit",
                    script: "SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY",
                    description: "Surfaces underutilized warehouses running with zero execution load.",
                    actions: [
                        {
                            label: "Set AUTO_SUSPEND = 60s",
                            variant: "warning",
                            endpoint: "/api/actions/execute-ddl",
                            confirmPrompt: "Optimize {WAREHOUSE_NAME} to auto-suspend after 60 seconds of idle time?",
                            paramKeys: { 
                                server: "server", 
                                sql: "ALTER_DDL",
                                warehouse: "WAREHOUSE_NAME"
                            }
                        }
                    ]
                },
                {
                    id: "resource-monitors",
                    label: "Resource Monitor Budget & Quota Compliance",
                    script: "SNOWFLAKE.ACCOUNT_USAGE.RESOURCE_MONITORS",
                    description: "Audits virtual warehouse credit limits, current period consumption, and threshold actions."
                },
                {
                    id: "spilling-analysis",
                    label: "Query Memory Spilling to Local/Remote Disk",
                    script: "SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY",
                    description: "Identifies memory-constrained queries causing disk offloading."
                },
                {
                    id: "query-cache-efficiency",
                    label: "Result Cache Hit Ratio (Last 24h)",
                    script: "SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY",
                    description: "Measures query performance gains from result cache vs compute warehouse scanning."
                },
                {
                    id: "warehouse-queueing",
                    label: "Warehouse Concurrency & Queueing Bottlenecks",
                    script: "SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY",
                    description: "Monitors queued load and cluster concurrency pressure."
                },
                {
                    id: "cortex-ai-costs",
                    label: "Cortex AI Token Usage & Credit Spend (30 Days)",
                    script: "SNOWFLAKE.ACCOUNT_USAGE.CORTEX_FUNCTIONS_USAGE_HISTORY",
                    description: "Audits credit and token consumption across Cortex LLM/embedding functions."
                },
                {
                    id: "expensive-queries",
                    label: "Expensive Queries & Remote Spillage (>60s)",
                    script: "SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY",
                    description: "Surfaces long-running queries spilling data to local/remote storage.",
                    actions: [
                        {
                            label: "Cancel Query",
                            variant: "danger",
                            endpoint: "/api/actions/cancel-query",
                            confirmPrompt: "Terminate running Snowflake Query ID: {QUERY_ID}?",
                            paramKeys: { server: "server", query_id: "QUERY_ID" }
                        }
                    ]
                }
            ]
        },
        {
            id: "snowflake-governance",
            label: "Snowflake Governance & Security",
            description: "Data classification, masking policies, row-access enforcement, RBAC audit, and MFA compliance.",
            queries: [
                {
                    id: "policy-coverage",
                    label: "Column Masking & Row Access Policy Coverage",
                    script: "SNOWFLAKE.ACCOUNT_USAGE.POLICY_REFERENCES",
                    description: "Surfaces tables, views, and columns actively protected by data governance policies."
                },
                {
                    id: "mfa-compliance",
                    label: "User Authentication & MFA Compliance Audit",
                    script: "SNOWFLAKE.ACCOUNT_USAGE.USERS & LOGIN_HISTORY",
                    description: "Identifies human users logging in via password without second-factor authentication (MFA).",
                    actions: [
                        {
                            label: "Enforce MFA Policy",
                            variant: "primary",
                            endpoint: "/api/actions/execute-ddl",
                            confirmPrompt: "Disable MFA bypass for user {USER_NAME}?",
                            paramKeys: { 
                                server: "server", 
                                sql: "ENFORCE_MFA_SQL",
                                user: "USER_NAME"
                            }
                        }
                    ]
                },
                {
                    id: "admin-privileges",
                    label: "Privileged Role Assignments (ACCOUNTADMIN / SECURITYADMIN)",
                    script: "SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_USERS",
                    description: "Audits users assigned superuser and administrative roles."
                },
                {
                    id: "network-policies",
                    label: "Active Network Policies & IP Whitelist Audit",
                    script: "SNOWFLAKE.ACCOUNT_USAGE.NETWORK_POLICIES",
                    description: "Verifies account-level and user-level ingress IP restrictions."
                },
                {
                    id: "unused-objects",
                    label: "Stale / Orphaned Tables (No Reads >90 Days)",
                    script: "SNOWFLAKE.ACCOUNT_USAGE.TABLE_STORAGE_METRICS",
                    description: "Surfaces zero-access storage consumption for lifecycle cleanup."
                }
            ]
        },
        {
            id: "security-audit",
            label: "Security & Audit",
            description: "Login and user SID mismatches with remediation.",
            queries: [
                {
                    id: "orphan-users",
                    label: "Orphaned Database Users",
                    script: "Security Audit",
                    description: "Finds database users that no longer map cleanly to a server login."
                }
            ]
        },
        {
            id: "best-practices",
            label: "Best Practices & Compliance",
            description: "Audits instance and database configurations against Microsoft recommended baselines.",
            queries: [
                {
                    id: "db-configurations",
                    label: "Database Configuration Baselines",
                    script: "Compliance Audit",
                    description: "Audits Auto-Close, Auto-Shrink, Page Verify, and Statistics settings.",
                    actions: [
                        {
                            label: "Disable Auto-Shrink",
                            variant: "warning",
                            endpoint: "/api/actions/disable-autoshrink",
                            confirmPrompt: "Disable AUTO_SHRINK on database {name}?",
                            paramKeys: { database: "name", sql: "SQL_ACTION" }
                        }
                    ]
                },
                {
                    id: "compatibility-level",
                    label: "Database Compatibility Level",
                    script: "Version Audit",
                    description: "Audits current database compatibility target versus engine version."
                },
                {
                    id: "isolation-levels",
                    label: "Database Isolation Level Settings",
                    script: "Concurrency Audit",
                    description: "Checks Read Committed Snapshot and Snapshot Isolation options."
                }
            ]
        },
        {
            id: "remediation-audit-log",
            label: "Remediation Audit Log",
            description: "Permanent log of all DDL and configuration changes executed through the console.",
            queries: [
                {
                    id: "audit-history",
                    label: "Console Action Log",
                    script: "Audit Log",
                    description: "Tracks executed configuration actions and remediation changes."
                }
            ]
        }
    ]);
});

// ==========================================
// REMEDIATION & ADMINISTRATIVE ENDPOINTS
// ==========================================

app.post('/api/actions/execute-ddl', async (req, res) => {
    const { server, database, sql: ddlSql } = req.body;
    if (!ddlSql || typeof ddlSql !== 'string') {
        return res.status(400).json({ error: "No valid DDL statement supplied." });
    }

    const cleanSql = ddlSql.trim().toUpperCase();
    const isAllowed = cleanSql.startsWith('CREATE NONCLUSTERED INDEX') || 
                      cleanSql.startsWith('CREATE INDEX') || 
                      cleanSql.startsWith('ALTER INDEX') ||
                      cleanSql.startsWith('ALTER WAREHOUSE') ||
                      cleanSql.startsWith('ALTER USER');

    if (!isAllowed) {
        return res.status(403).json({ error: "Statement rejected: only verified index/warehouse/user maintenance commands are allowed." });
    }

    try {
        const servers = getServersList();
        const srv = servers.find(s => s.id === server || s.name === server) || servers[0];

        if (srv.engine === 'snowflake') {
            await executeSnowflakeQuery(srv.id, ddlSql);
            await logAuditEvent('EXECUTE_DDL_SNOWFLAKE', srv.warehouse || 'Account-Wide', ddlSql);
            return res.json({ success: true, message: `Snowflake command executed successfully.` });
        }

        const pool = await getPool(server);
        const request = pool.request();
        const batchSql = database ? `USE ${quoteIdentifier(database)};\n${ddlSql}` : ddlSql;

        request.timeout = 120000;
        await request.query(batchSql);

        await logAuditEvent('EXECUTE_DDL', database, ddlSql);
        res.json({ success: true, message: `Command executed successfully on ${database || 'target'}.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/actions/cancel-query', async (req, res) => {
    const { server, query_id } = req.body;
    if (!query_id) {
        return res.status(400).json({ error: "Query ID is required." });
    }

    try {
        const servers = getServersList();
        const srv = servers.find(s => s.id === server || s.name === server) || servers[0];

        if (srv.engine === 'snowflake') {
            await executeSnowflakeQuery(srv.id, `SELECT SYSTEM$CANCEL_QUERY('${query_id.replace(/'/g, "''")}');`);
            await logAuditEvent('CANCEL_QUERY_SNOWFLAKE', 'Snowflake-Account', `Cancelled running query ID: ${query_id}`);
            return res.json({ success: true, message: `Query ${query_id} cancelled successfully.` });
        }

        res.status(400).json({ error: "Action only supported on Snowflake targets." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/actions/kill-session', async (req, res) => {
    const { server, spid } = req.body;
    const sessionInt = parseInt(spid, 10);
    if (isNaN(sessionInt) || sessionInt <= 50) {
        return res.status(400).json({ error: "Invalid SPID. System sessions (<= 50) cannot be terminated." });
    }

    try {
        const pool = await getPool(server);
        const request = pool.request();
        await request.query(`KILL ${sessionInt};`);
        await logAuditEvent('KILL_SESSION', 'Instance-Wide', `Terminated SPID ${sessionInt}`);
        res.json({ success: true, message: `Session SPID ${sessionInt} was successfully terminated.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/actions/disable-autoshrink', async (req, res) => {
    const { server, database } = req.body;
    if (!database) return res.status(400).json({ error: "Database name required." });

    try {
        const pool = await getPool(server);
        const request = pool.request();
        await request.query(`ALTER DATABASE ${quoteIdentifier(database)} SET AUTO_SHRINK OFF;`);
        await logAuditEvent('DISABLE_AUTO_SHRINK', database, 'Disabled AUTO_SHRINK successfully.');
        res.json({ success: true, message: `AUTO_SHRINK disabled on ${database}.` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/actions/download-plan', async (req, res) => {
    const { server, database, plan_id } = req.body;
    const planIdInt = parseInt(plan_id, 10);
    if (isNaN(planIdInt)) {
        return res.status(400).json({ error: "Invalid Plan ID." });
    }

    try {
        const pool = await getPool(server);
        const request = pool.request();
        const dbPrefix = database ? `USE ${quoteIdentifier(database)};\n` : '';
        
        request.input('planId', sql.BigInt, planIdInt);
        const r = await request.query(`
            ${dbPrefix}
            SELECT query_plan 
            FROM sys.query_store_plan 
            WHERE plan_id = @planId;
        `);

        const records = Array.isArray(r.recordset) ? r.recordset : (r.recordsets && r.recordsets[r.recordsets.length - 1]);
        if (records && records.length && records[0].query_plan) {
            res.json({ success: true, planXml: records[0].query_plan });
        } else {
            res.status(404).json({ error: "Execution plan not found or not in Query Store." });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/actions/download-deadlock', async (req, res) => {
    const { server, event_time } = req.body;
    try {
        const pool = await getPool(server);
        const request = pool.request();
        request.input('eventTime', sql.VarChar, event_time);

        const r = await request.query(`
            WITH DeadlockData AS (
                SELECT CAST(target_data AS XML) AS target_data
                FROM sys.dm_xe_session_targets st
                JOIN sys.dm_xe_sessions s ON s.address = st.event_session_address
                WHERE s.name = 'system_health' AND st.target_name = 'ring_buffer'
            )
            SELECT TOP 1
                e.event_data.query('data[@name="xml_report"]/value/deadlock') AS deadlock_graph
            FROM DeadlockData
            CROSS APPLY target_data.nodes('//RingBufferTarget/event[@name="xml_deadlock_report"]') AS e(event_data)
            WHERE CONVERT(VARCHAR(19), e.event_data.value('(@timestamp)[1]', 'datetime2'), 120) = @eventTime;
        `);

        const records = Array.isArray(r.recordset) ? r.recordset : (r.recordsets && r.recordsets[r.recordsets.length - 1]);
        if (records && records.length && records[0].deadlock_graph) {
            res.json({ success: true, deadlockXml: records[0].deadlock_graph });
        } else {
            res.status(404).json({ error: "Deadlock graph not found or expired from ring buffer." });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// DIAGNOSTIC & TELEMETRY REPORT GENERATOR
// ==========================================
app.get('/api/reports/health-summary', async (req, res) => {
    const server = req.query.server || 'localhost';
    const database = req.query.database || 'master';
    try {
        const pool = await getPool(server);
        const [uptime, backups, space, waits] = await Promise.all([
            pool.request().query(`SELECT sqlserver_start_time, @@VERSION AS version FROM sys.dm_os_sys_info;`),
            pool.request().query(`SELECT TOP 5 database_name, MAX(backup_finish_date) AS last_backup FROM msdb.dbo.backupset GROUP BY database_name;`),
            pool.request().query(`SELECT DISTINCT vs.volume_mount_point, CAST(vs.available_bytes/1073741824.0 AS DECIMAL(10,2)) AS free_gb FROM sys.master_files f CROSS APPLY sys.dm_os_volume_stats(f.database_id, f.file_id) vs;`),
            pool.request().query(`SELECT TOP 5 wait_type, wait_time_ms FROM sys.dm_os_wait_stats WHERE wait_time_ms > 0 ORDER BY wait_time_ms DESC;`)
        ]);

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>SQLDB Diagnostic Report - ${server}</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 32px; }
                h1 { color: #38bdf8; border-bottom: 2px solid #1e293b; padding-bottom: 12px; }
                h3 { color: #94a3b8; margin-top: 24px; }
                table { width: 100%; border-collapse: collapse; margin-bottom: 24px; background: #1e293b; border-radius: 6px; overflow: hidden; }
                th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #334155; }
                th { background: #0f172a; color: #94a3b8; font-size: 12px; text-transform: uppercase; }
            </style>
        </head>
        <body>
            <h1>SQL Server Health Audit: ${server}</h1>
            <p><strong>Generated:</strong> ${new Date().toUTCString()} | <strong>Target DB:</strong> ${database}</p>
            <h3>Instance Overview</h3>
            <p><strong>Version:</strong> ${uptime.recordset[0]?.version || 'N/A'}</p>
            <p><strong>Start Time:</strong> ${uptime.recordset[0]?.sqlserver_start_time || 'N/A'}</p>
            <h3>Storage Volumes</h3>
            <table>
                <thead><tr><th>Mount Point</th><th>Free Space</th></tr></thead>
                <tbody>${space.recordset.map(s => `<tr><td>${s.volume_mount_point}</td><td>${s.free_gb} GB Free</td></tr>`).join('')}</tbody>
            </table>
            <h3>Top Wait Contention</h3>
            <table>
                <thead><tr><th>Wait Type</th><th>Wait Time (ms)</th></tr></thead>
                <tbody>${waits.recordset.map(w => `<tr><td>${w.wait_type}</td><td>${w.wait_time_ms} ms</td></tr>`).join('')}</tbody>
            </table>
        </body>
        </html>`;

        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Disposition', `attachment; filename=SQL_Health_Report_${server}_${Date.now()}.html`);
        res.send(html);
    } catch (err) {
        res.status(500).send(`Failed to generate report: ${err.message}`);
    }
});

app.get('/api/reports/snowflake-summary', async (req, res) => {
    const server = req.query.server || 'Snowflake Analytics';
    const startTime = Date.now();

    try {
        const servers = getServersList();
        const srv = servers.find(s => s.id === server || s.name === server) || servers.find(s => s.engine === 'snowflake');

        if (!srv || srv.engine !== 'snowflake') {
            return res.status(400).send('Selected server is not a Snowflake instance.');
        }

        const [metering, idle, mfa, admins, monitors] = await Promise.all([
            executeSnowflakeQuery(srv.id, `
                SELECT WAREHOUSE_NAME, ROUND(SUM(CREDITS_USED), 2) AS CREDITS, ROUND(SUM(CREDITS_USED) * 3.0, 2) AS EST_COST_USD 
                FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY 
                WHERE START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP()) 
                GROUP BY WAREHOUSE_NAME ORDER BY CREDITS DESC;
            `),
            executeSnowflakeQuery(srv.id, `
                SELECT WAREHOUSE_NAME, ROUND(AVG(AVG_RUNNING), 2) AS AVG_LOAD, 
                       SUM(CASE WHEN AVG_RUNNING = 0 THEN 1 ELSE 0 END) AS ZERO_LOAD_HOURS
                FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY 
                WHERE START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP()) 
                GROUP BY WAREHOUSE_NAME ORDER BY ZERO_LOAD_HOURS DESC;
            `),
            executeSnowflakeQuery(srv.id, `
                SELECT NAME, HAS_MFA, DISABLED 
                FROM SNOWFLAKE.ACCOUNT_USAGE.USERS 
                WHERE DELETED_ON IS NULL AND DISABLED = FALSE AND HAS_MFA = FALSE;
            `),
            executeSnowflakeQuery(srv.id, `
                SELECT GRANTEE_NAME, ROLE, GRANTED_BY 
                FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_USERS 
                WHERE ROLE IN ('ACCOUNTADMIN', 'SECURITYADMIN') AND DELETED_ON IS NULL;
            `),
            executeSnowflakeQuery(srv.id, `
                SELECT NAME, CREDIT_QUOTA, USED_CREDITS, ROUND((USED_CREDITS / NULLIF(CREDIT_QUOTA, 0)) * 100, 2) AS PCT_USED 
                FROM SNOWFLAKE.ACCOUNT_USAGE.RESOURCE_MONITORS;
            `)
        ]);

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <title>Snowflake FinOps & Governance Audit - ${srv.name || srv.id}</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f1f5f9; padding: 32px; }
                h1 { color: #38bdf8; border-bottom: 2px solid #1e293b; padding-bottom: 12px; }
                h3 { color: #94a3b8; margin-top: 28px; }
                table { width: 100%; border-collapse: collapse; margin-bottom: 24px; background: #111827; border-radius: 8px; overflow: hidden; }
                th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 14px; }
                th { background: #1e293b; color: #38bdf8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
                .badge-danger { color: #f87171; font-weight: bold; }
                .badge-warning { color: #facc15; font-weight: bold; }
            </style>
        </head>
        <body>
            <h1>Snowflake FinOps & Security Audit: ${srv.name || srv.id}</h1>
            <p><strong>Generated:</strong> ${new Date().toUTCString()} | <strong>Execution Time:</strong> ${Date.now() - startTime}ms</p>
            
            <h3>Warehouse 7-Day Credit Consumption</h3>
            <table>
                <thead><tr><th>Warehouse</th><th>Credits Consumed</th><th>Estimated Cost (USD)</th></tr></thead>
                <tbody>${metering.map(m => `<tr><td>${m.WAREHOUSE_NAME}</td><td>${m.CREDITS}</td><td>$${m.EST_COST_USD}</td></tr>`).join('')}</tbody>
            </table>

            <h3>Compute Inefficiency & Idle Suspend Audit</h3>
            <table>
                <thead><tr><th>Warehouse</th><th>Avg Running Load</th><th>Zero Load Intervals (Hours)</th></tr></thead>
                <tbody>${idle.map(i => `<tr><td>${i.WAREHOUSE_NAME}</td><td>${i.AVG_LOAD}</td><td class="${i.ZERO_LOAD_HOURS > 10 ? 'badge-danger' : ''}">${i.ZERO_LOAD_HOURS} hrs</td></tr>`).join('')}</tbody>
            </table>

            <h3>Critical Security: Active Users Without MFA</h3>
            <table>
                <thead><tr><th>User</th><th>Has MFA</th><th>Status</th></tr></thead>
                <tbody>${mfa.length ? mfa.map(u => `<tr><td>${u.NAME}</td><td class="badge-danger">FALSE</td><td>CRITICAL: Non-Compliant</td></tr>`).join('') : `<tr><td colspan="3">All active users have MFA enforced.</td></tr>`}</tbody>
            </table>

            <h3>Privileged Access (Superusers)</h3>
            <table>
                <thead><tr><th>User</th><th>Role</th><th>Granted By</th></tr></thead>
                <tbody>${admins.map(a => `<tr><td>${a.GRANTEE_NAME}</td><td class="badge-warning">${a.ROLE}</td><td>${a.GRANTED_BY}</td></tr>`).join('')}</tbody>
            </table>

            <h3>Resource Monitor Quota Burn</h3>
            <table>
                <thead><tr><th>Monitor</th><th>Quota</th><th>Used Credits</th><th>% Burned</th></tr></thead>
                <tbody>${monitors.length ? monitors.map(r => `<tr><td>${r.NAME}</td><td>${r.CREDIT_QUOTA}</td><td>${r.USED_CREDITS}</td><td>${r.PCT_USED}%</td></tr>`).join('') : `<tr><td colspan="4">No active resource monitors configured.</td></tr>`}</tbody>
            </table>
        </body>
        </html>`;

        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Disposition', `attachment; filename=Snowflake_Audit_Report_${Date.now()}.html`);
        res.send(html);
    } catch (err) {
        res.status(500).send(`Failed to generate report: ${err.message}`);
    }
});

// ==========================================
// DYNAMIC QUERY DISPATCHER
// ==========================================
app.get('/api/query/:categoryId/:queryId', async (req, res) => {
    const { categoryId, queryId } = req.params;
    const serverId = req.query.server || 'Local';
    const targetDb = req.query.database || 'master';
    const startTime = Date.now();

    try {
        const servers = getServersList();
        const srv = servers.find(s => s.id === serverId || s.name === serverId) || servers[0];

        // ------------------------------------------------ Snowflake FinOps Telemetry
        if (categoryId === 'snowflake-finops') {
            if (srv.engine !== 'snowflake') {
                return res.json({
                    success: true,
                    elapsedMs: 0,
                    recordsets: [[{
                        STATUS: 'ENGINE_MISMATCH',
                        MESSAGE: `Snowflake FinOps telemetry is only available when a Snowflake instance is selected. Current target '${srv.name || serverId}' is a SQL Server instance.`
                    }]]
                });
            }

            let sfQuery = '';

            if (queryId === 'warehouse-metering') {
                sfQuery = `
                    SELECT 
                        WAREHOUSE_NAME,
                        ROUND(SUM(CREDITS_USED), 4) AS TOTAL_CREDITS,
                        ROUND(SUM(CREDITS_USED_COMPUTE), 4) AS COMPUTE_CREDITS,
                        ROUND(SUM(CREDITS_USED_CLOUD_SERVICES), 4) AS CLOUD_SERVICES_CREDITS,
                        ROUND(SUM(CREDITS_USED) * 3.00, 2) AS ESTIMATED_COST_USD
                    FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
                    WHERE START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())
                    GROUP BY WAREHOUSE_NAME
                    ORDER BY TOTAL_CREDITS DESC;
                `;
            } else if (queryId === 'idle-warehouse-costs') {
                sfQuery = `
                    SELECT 
                        WAREHOUSE_NAME,
                        COUNT(*) AS ACTIVE_INTERVALS_1H,
                        ROUND(AVG(AVG_RUNNING), 2) AS AVG_RUNNING_QUERIES,
                        ROUND(AVG(AVG_QUEUED_LOAD), 2) AS AVG_QUEUED_LOAD,
                        SUM(CASE WHEN AVG_RUNNING = 0 AND AVG_QUEUED_LOAD = 0 THEN 1 ELSE 0 END) AS ZERO_LOAD_INTERVALS,
                        CASE 
                            WHEN AVG(AVG_RUNNING) < 0.1 AND COUNT(*) > 10 THEN 'CRITICAL: High Idle Time (Reduce AUTO_SUSPEND)'
                            WHEN AVG(AVG_RUNNING) < 0.3 THEN 'WARNING: Underutilized'
                            ELSE 'OPTIMAL'
                        END AS UTILIZATION_STATUS,
                        'ALTER WAREHOUSE ' || WAREHOUSE_NAME || ' SET AUTO_SUSPEND = 60;' AS ALTER_DDL
                    FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY
                    WHERE START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())
                    GROUP BY WAREHOUSE_NAME
                    ORDER BY ZERO_LOAD_INTERVALS DESC;
                `;
            } else if (queryId === 'resource-monitors') {
                sfQuery = `
                    SELECT 
                        NAME AS MONITOR_NAME,
                        CREDIT_QUOTA,
                        USED_CREDITS,
                        ROUND((USED_CREDITS / NULLIF(CREDIT_QUOTA, 0)) * 100, 2) AS PERCENT_USED,
                        CASE 
                            WHEN USED_CREDITS >= CREDIT_QUOTA THEN 'CRITICAL: Quota Limit Exceeded (100%+)'
                            WHEN USED_CREDITS >= (CREDIT_QUOTA * 0.90) THEN 'WARNING: Over 90% Quota Burn'
                            WHEN USED_CREDITS >= (CREDIT_QUOTA * 0.75) THEN 'ALERT: Over 75% Quota Burn'
                            ELSE 'OK: Normal Consumption'
                        END AS MONITOR_STATUS
                    FROM SNOWFLAKE.ACCOUNT_USAGE.RESOURCE_MONITORS
                    ORDER BY PERCENT_USED DESC;
                `;
            } else if (queryId === 'spilling-analysis') {
                sfQuery = `
                    SELECT TOP 25
                        QUERY_ID,
                        USER_NAME,
                        WAREHOUSE_NAME,
                        WAREHOUSE_SIZE,
                        ROUND(TOTAL_ELAPSED_TIME / 1000.0, 2) AS ELAPSED_SEC,
                        ROUND(BYTES_SPILLED_TO_LOCAL_STORAGE / (1024 * 1024 * 1024.0), 2) AS SPILLED_LOCAL_GB,
                        ROUND(BYTES_SPILLED_TO_REMOTE_STORAGE / (1024 * 1024 * 1024.0), 2) AS SPILLED_REMOTE_GB,
                        CASE 
                            WHEN BYTES_SPILLED_TO_REMOTE_STORAGE > 0 THEN 'CRITICAL: Remote Spilling (Upsize Warehouse)'
                            WHEN BYTES_SPILLED_TO_LOCAL_STORAGE > 0 THEN 'WARNING: Local Spilling (Tune Joins/Aggregations)'
                            ELSE 'HEALTHY'
                        END AS SPILL_SEVERITY,
                        SUBSTRING(QUERY_TEXT, 1, 120) AS QUERY_SNIPPET
                    FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
                    WHERE START_TIME >= DATEADD(day, -7, CURRENT_TIMESTAMP())
                      AND (BYTES_SPILLED_TO_LOCAL_STORAGE > 0 OR BYTES_SPILLED_TO_REMOTE_STORAGE > 0)
                    ORDER BY BYTES_SPILLED_TO_REMOTE_STORAGE DESC, BYTES_SPILLED_TO_LOCAL_STORAGE DESC;
                `;
            } else if (queryId === 'query-cache-efficiency') {
                sfQuery = `
                    SELECT 
                        WAREHOUSE_NAME,
                        COUNT(*) AS TOTAL_QUERIES,
                        SUM(CASE WHEN PERCENTAGE_SCANNED_FROM_CACHE = 1 THEN 1 ELSE 0 END) AS FULL_CACHE_HITS,
                        SUM(CASE WHEN PERCENTAGE_SCANNED_FROM_CACHE > 0 AND PERCENTAGE_SCANNED_FROM_CACHE < 1 THEN 1 ELSE 0 END) AS PARTIAL_CACHE_HITS,
                        SUM(CASE WHEN PERCENTAGE_SCANNED_FROM_CACHE = 0 OR PERCENTAGE_SCANNED_FROM_CACHE IS NULL THEN 1 ELSE 0 END) AS WAREHOUSE_SCANS,
                        ROUND(100.0 * SUM(CASE WHEN PERCENTAGE_SCANNED_FROM_CACHE = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 2) AS CACHE_HIT_PERCENTAGE
                    FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
                    WHERE START_TIME >= DATEADD(hour, -24, CURRENT_TIMESTAMP())
                      AND QUERY_TYPE IN ('SELECT', 'MERGE', 'INSERT', 'UPDATE')
                    GROUP BY WAREHOUSE_NAME
                    ORDER BY TOTAL_QUERIES DESC;
                `;
            } else if (queryId === 'warehouse-queueing') {
                sfQuery = `
                    SELECT TOP 20
                        WAREHOUSE_NAME,
                        START_TIME,
                        ROUND(AVG_RUNNING, 2) AS RUNNING_LOAD,
                        ROUND(AVG_QUEUED_LOAD, 2) AS QUEUED_LOAD,
                        ROUND(AVG_BLOCKED, 2) AS BLOCKED_LOAD,
                        CASE 
                            WHEN AVG_QUEUED_LOAD > 2.0 THEN 'CRITICAL: Sustained Queueing (Add Cluster / Auto-scale)'
                            WHEN AVG_QUEUED_LOAD > 0.5 THEN 'WARNING: Moderate Queueing'
                            ELSE 'HEALTHY'
                        END AS QUEUE_STATUS
                    FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY
                    WHERE START_TIME >= DATEADD(day, -1, CURRENT_TIMESTAMP())
                      AND AVG_QUEUED_LOAD > 0
                    ORDER BY AVG_QUEUED_LOAD DESC;
                `;
            } else if (queryId === 'cortex-ai-costs') {
                sfQuery = `
                    SELECT 
                        FUNCTION_NAME,
                        MODEL_NAME,
                        ROUND(SUM(TOKEN_CREDITS), 4) AS TOTAL_CREDITS,
                        ROUND(SUM(TOKEN_CREDITS) * 3.00, 2) AS ESTIMATED_COST_USD,
                        SUM(TOKENS) AS TOTAL_TOKENS_BILLED,
                        COUNT(*) AS CALL_COUNT
                    FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_FUNCTIONS_USAGE_HISTORY
                    WHERE START_TIME >= DATEADD(day, -30, CURRENT_TIMESTAMP())
                    GROUP BY FUNCTION_NAME, MODEL_NAME
                    ORDER BY TOTAL_CREDITS DESC;
                `;
            } else if (queryId === 'expensive-queries') {
                sfQuery = `
                    SELECT TOP 25
                        QUERY_ID,
                        USER_NAME,
                        WAREHOUSE_NAME,
                        EXECUTION_STATUS,
                        ROUND(TOTAL_ELAPSED_TIME / 1000.0, 2) AS ELAPSED_SEC,
                        ROUND(COMPILATION_TIME / 1000.0, 2) AS COMPILE_SEC,
                        ROUND(EXECUTION_TIME / 1000.0, 2) AS EXEC_SEC,
                        ROUND(BYTES_SPILLED_TO_LOCAL_STORAGE / (1024 * 1024.0), 2) AS LOCAL_SPILL_MB,
                        ROUND(BYTES_SPILLED_TO_REMOTE_STORAGE / (1024 * 1024.0), 2) AS REMOTE_SPILL_MB,
                        SUBSTRING(QUERY_TEXT, 1, 150) AS QUERY_TEXT
                    FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY
                    WHERE START_TIME >= DATEADD(day, -1, CURRENT_TIMESTAMP())
                      AND TOTAL_ELAPSED_TIME > 60000
                    ORDER BY TOTAL_ELAPSED_TIME DESC;
                `;
            } else {
                throw new Error(`Unknown Snowflake query ID: ${queryId}`);
            }

            const rows = await executeSnowflakeQuery(srv.id, sfQuery);
            return res.json({
                success: true,
                elapsedMs: Date.now() - startTime,
                recordsets: [rows]
            });
        }

        // ------------------------------------------------ Snowflake Governance & Security Telemetry
        if (categoryId === 'snowflake-governance') {
            if (srv.engine !== 'snowflake') {
                return res.json({
                    success: true,
                    elapsedMs: 0,
                    recordsets: [[{
                        STATUS: 'ENGINE_MISMATCH',
                        MESSAGE: `Governance telemetry is only available when a Snowflake instance is selected. Current target '${srv.name || serverId}' is a SQL Server instance.`
                    }]]
                });
            }

            let govSql = '';

            if (queryId === 'policy-coverage') {
                govSql = `
                    SELECT 
                        POLICY_DB || '.' || POLICY_SCHEMA || '.' || POLICY_NAME AS POLICY_FULL_NAME,
                        POLICY_KIND,
                        REF_DATABASE_NAME || '.' || REF_SCHEMA_NAME || '.' || REF_ENTITY_NAME AS TARGET_OBJECT,
                        REF_ENTITY_DOMAIN,
                        COALESCE(REF_COLUMN_NAME, '(Table/Row Level)') AS TARGET_COLUMN,
                        POLICY_STATUS
                    FROM SNOWFLAKE.ACCOUNT_USAGE.POLICY_REFERENCES
                    WHERE POLICY_STATUS = 'ACTIVE'
                    ORDER BY POLICY_KIND, TARGET_OBJECT;
                `;
            } else if (queryId === 'mfa-compliance') {
                govSql = `
                    SELECT 
                        u.NAME AS USER_NAME,
                        u.DISPLAY_NAME,
                        u.HAS_MFA,
                        u.DISABLED,
                        CASE WHEN u.LOCKED_UNTIL_TIME > CURRENT_TIMESTAMP() THEN TRUE ELSE FALSE END AS IS_LOCKED,
                        MAX(l.EVENT_TIMESTAMP) AS LAST_LOGIN,
                        CASE 
                            WHEN u.HAS_MFA = FALSE AND u.DISABLED = FALSE THEN 'CRITICAL: Active User Without MFA'
                            WHEN u.HAS_MFA = TRUE THEN 'COMPLIANT'
                            ELSE 'DISABLED_USER'
                        END AS MFA_STATUS,
                        'ALTER USER ' || u.NAME || ' SET MINS_TO_BYPASS_MFA = 0;' AS ENFORCE_MFA_SQL
                    FROM SNOWFLAKE.ACCOUNT_USAGE.USERS u
                    LEFT JOIN SNOWFLAKE.ACCOUNT_USAGE.LOGIN_HISTORY l ON u.NAME = l.USER_NAME
                    WHERE u.DELETED_ON IS NULL
                    GROUP BY u.NAME, u.DISPLAY_NAME, u.HAS_MFA, u.DISABLED, u.LOCKED_UNTIL_TIME
                    ORDER BY u.HAS_MFA ASC, LAST_LOGIN DESC;
                `;
            } else if (queryId === 'admin-privileges') {
                govSql = `
                    SELECT 
                        GRANTEE_NAME AS USER_NAME,
                        ROLE,
                        GRANTED_BY,
                        CREATED_ON AS GRANTED_DATE,
                        CASE 
                            WHEN ROLE = 'ACCOUNTADMIN' THEN 'CRITICAL: Account Admin Access'
                            WHEN ROLE = 'SECURITYADMIN' THEN 'HIGH: Security Admin Access'
                            WHEN ROLE = 'SYSADMIN' THEN 'MEDIUM: System Admin Access'
                            ELSE 'STANDARD'
                        END AS PRIVILEGE_TIER
                    FROM SNOWFLAKE.ACCOUNT_USAGE.GRANTS_TO_USERS
                    WHERE ROLE IN ('ACCOUNTADMIN', 'SECURITYADMIN', 'SYSADMIN')
                      AND DELETED_ON IS NULL
                    ORDER BY PRIVILEGE_TIER, USER_NAME;
                `;
            } else if (queryId === 'network-policies') {
                govSql = `
                    SELECT 
                        NAME AS POLICY_NAME,
                        ALLOWED_IP_LIST,
                        BLOCKED_IP_LIST,
                        COMMENT,
                        CREATED AS CREATED_ON
                    FROM SNOWFLAKE.ACCOUNT_USAGE.NETWORK_POLICIES
                    ORDER BY CREATED DESC;
                `;
            } else if (queryId === 'unused-objects') {
                govSql = `
                    SELECT TOP 30
                        TABLE_CATALOG AS DATABASE_NAME,
                        TABLE_SCHEMA AS SCHEMA_NAME,
                        TABLE_NAME,
                        ROUND(ACTIVE_BYTES / (1024 * 1024 * 1024.0), 2) AS STORAGE_GB,
                        ROUND(TIME_TRAVEL_BYTES / (1024 * 1024 * 1024.0), 2) AS TIME_TRAVEL_GB,
                        ROUND(FAILSAFE_BYTES / (1024 * 1024 * 1024.0), 2) AS FAILSAFE_GB,
                        TABLE_CREATED,
                        COMMENT
                    FROM SNOWFLAKE.ACCOUNT_USAGE.TABLE_STORAGE_METRICS
                    WHERE ACTIVE_BYTES > 1073741824
                      AND DELETED = FALSE
                    ORDER BY ACTIVE_BYTES DESC;
                `;
            } else {
                throw new Error(`Unknown Governance query ID: ${queryId}`);
            }

            const rows = await executeSnowflakeQuery(srv.id, govSql);
            return res.json({
                success: true,
                elapsedMs: Date.now() - startTime,
                recordsets: [rows.length ? rows : [{ STATUS: 'NO_RECORDS', MESSAGE: 'No records found matching policy criteria.' }]]
            });
        }

        // ------------------------------------------------ Audit Log
        if (categoryId === 'remediation-audit-log' && queryId === 'audit-history') {
            const logs = await getAuditLogs();
            return res.json({
                success: true,
                elapsedMs: Date.now() - startTime,
                recordsets: [logs.length ? logs : [{ status: 'No remediation actions logged to audit_log.json yet.' }]]
            });
        }

        // ------------------------------------------------ SQL Server Telemetry
        if (srv.engine === 'snowflake') {
            return res.json({
                success: true,
                elapsedMs: 0,
                recordsets: [[{
                    STATUS: 'ENGINE_MISMATCH',
                    MESSAGE: `SQL Server diagnostic queries cannot run against Snowflake target '${srv.name || serverId}'. Select 'Snowflake FinOps & AI' or 'Snowflake Governance & Security' from the left navigation.`
                }]]
            });
        }

        const pool = await getPool(srv.id);
        const request = pool.request();
        request.input('targetDb', sql.NVarChar, targetDb);

        const dbPrefix = (targetDb && categoryId !== 'remediation-audit-log') 
            ? `USE ${quoteIdentifier(targetDb)};\n` 
            : '';

        let sqlText = '';

        if (categoryId === 'health-check' && queryId === 'server-uptime') {
            sqlText = `SELECT sqlserver_start_time, @@VERSION AS version FROM sys.dm_os_sys_info;`;
        } else if (categoryId === 'health-check' && queryId === 'backup-history') {
            sqlText = `${dbPrefix}
                SELECT 
                    d.name AS database_name,
                    MAX(b.backup_finish_date) AS last_backup_date,
                    DATEDIFF(hour, MAX(b.backup_finish_date), GETDATE()) AS hours_since_last_backup,
                    CASE 
                        WHEN MAX(b.backup_finish_date) IS NULL THEN 'CRITICAL: Never Backed Up'
                        WHEN DATEDIFF(hour, MAX(b.backup_finish_date), GETDATE()) > 24 THEN 'WARNING: Backup older than 24 hours'
                        ELSE 'OK: Recent Backup Found'
                    END AS backup_health
                FROM sys.databases d
                LEFT JOIN msdb.dbo.backupset b ON d.name = b.database_name AND b.type = 'D'
                WHERE d.state_desc = 'ONLINE' AND d.name <> 'tempdb' AND d.name = @targetDb
                GROUP BY d.name;`;
        } else if (categoryId === 'health-check' && queryId === 'agent-job-failures') {
            sqlText = `
                SELECT TOP 25
                    j.name AS job_name,
                    s.step_name,
                    msdb.dbo.agent_datetime(h.run_date, h.run_time) AS failure_time,
                    h.run_duration,
                    h.message AS error_message,
                    'CRITICAL' AS status
                FROM msdb.dbo.sysjobhistory h
                JOIN msdb.dbo.sysjobs j ON h.job_id = j.job_id
                JOIN msdb.dbo.sysjobsteps s ON h.job_id = s.job_id AND h.step_id = s.step_id
                WHERE h.run_status = 0
                  AND msdb.dbo.agent_datetime(h.run_date, h.run_time) >= DATEADD(hour, -24, GETDATE())
                ORDER BY failure_time DESC;`;
        } else if (categoryId === 'health-check' && queryId === 'drive-space') {
            sqlText = `
                SELECT DISTINCT 
                    vs.volume_mount_point, 
                    vs.logical_volume_name,
                    CAST(vs.total_bytes / 1073741824.0 AS DECIMAL(10,2)) AS total_gb,
                    CAST(vs.available_bytes / 1073741824.0 AS DECIMAL(10,2)) AS free_gb,
                    CAST((CAST(vs.available_bytes AS FLOAT) / vs.total_bytes) * 100 AS DECIMAL(5,2)) AS pct_free,
                    CASE 
                        WHEN (CAST(vs.available_bytes AS FLOAT) / vs.total_bytes) * 100 < 10 THEN 'CRITICAL: Under 10% Free Space'
                        WHEN (CAST(vs.available_bytes AS FLOAT) / vs.total_bytes) * 100 < 20 THEN 'WARNING: Under 20% Free Space'
                        ELSE 'HEALTHY'
                    END AS volume_health
                FROM sys.master_files f
                CROSS APPLY sys.dm_os_volume_stats(f.database_id, f.file_id) vs;`;
        } else if (categoryId === 'performance' && queryId === 'wait-stats-summary') {
            sqlText = `
                WITH FilteredWaits AS (
                    SELECT 
                        wait_type, 
                        wait_time_ms / 1000.0 AS wait_time_s,
                        100.0 * wait_time_ms / NULLIF(SUM(wait_time_ms) OVER(), 0) AS pct,
                        ROW_NUMBER() OVER(ORDER BY wait_time_ms DESC) AS rn
                    FROM sys.dm_os_wait_stats
                    WHERE wait_type NOT IN (
                        'CLR_SEMAPHORE','LAZYWRITER_SLEEP','RESOURCE_QUEUE','SLEEP_TASK',
                        'SLEEP_SYSTEMTASK','SQLTRACE_BUFFER_FLUSH','WAITFOR', 'LOGMGR_QUEUE',
                        'CHECKPOINT_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH','XE_TIMER_EVENT',
                        'BROKER_TO_FLUSH','BROKER_TASK_STOP','CLR_MANUAL_EVENT','CLR_AUTO_EVENT',
                        'DIRTY_PAGE_POLL','HADR_FILESTREAM_IOMGR_IOCOMPLETION','SP_SERVER_DIAGNOSTICS_SLEEP',
                        'SOS_WORK_DISPATCHER','XE_DISPATCHER_WAIT','XE_DISPATCHER_JOIN','FT_IFTS_SCHEDULER_IDLE_WAIT',
                        'PREEMPTIVE_XE_DISPATCHER','DISPATCHER_QUEUE_SEMAPHORE','SQLTRACE_INCREMENTAL_FLUSH_SLEEP',
                        'PWAIT_EXTENSIBILITY_CLEANUP_TASK','QDS_ASYNC_QUEUE','ONDEMAND_TASK_QUEUE',
                        'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP','PVS_PREALLOCATE','MEMORY_ALLOCATION_EXT',
                        'BROKER_EVENTHANDLER','BROKER_RECEIVE_WAITFOR','BROKER_TRANSMITTER'
                    ) AND wait_time_ms > 0
                )
                SELECT 
                    wait_type, 
                    CAST(wait_time_s AS DECIMAL(12,2)) AS wait_time_seconds,
                    CAST(pct AS DECIMAL(5,2)) AS pct_total_wait,
                    CASE 
                        WHEN wait_type LIKE 'PAGEIOLATCH%' OR wait_type = 'WRITELOG' OR wait_type LIKE 'IO_COMPLETION%' THEN 'Disk / Storage I/O'
                        WHEN wait_type LIKE 'LCK%' THEN 'Locking & Concurrency'
                        WHEN wait_type LIKE 'LATCH%' THEN 'Internal Latch Contention (Memory/TempDB)'
                        WHEN wait_type IN ('SOS_SCHEDULER_YIELD', 'THREADPOOL', 'CXPACKET', 'CXCONSUMER') THEN 'CPU & Parallelism'
                        WHEN wait_type LIKE 'ASYNC_NETWORK_IO' THEN 'Client Fetch / Network Latency'
                        ELSE 'General Engine Wait'
                    END AS wait_category
                FROM FilteredWaits
                WHERE rn <= 15;`;
        } else if (categoryId === 'performance' && queryId === 'query-store-waits') {
            sqlText = `${dbPrefix}
                SELECT TOP 10
                    ws.wait_category_desc,
                    SUM(ws.total_query_wait_time_ms) / 1000.0 AS total_wait_s,
                    SUM(ws.total_query_wait_time_ms) AS total_wait_ms,
                    AVG(ws.avg_query_wait_time_ms) AS avg_wait_ms,
                    COUNT(DISTINCT q.query_id) AS distinct_queries
                FROM sys.query_store_wait_stats ws
                JOIN sys.query_store_plan p ON ws.plan_id = p.plan_id
                JOIN sys.query_store_query q ON p.query_id = q.query_id
                JOIN sys.query_store_runtime_stats_interval rsi ON ws.runtime_stats_interval_id = rsi.runtime_stats_interval_id
                WHERE rsi.start_time >= DATEADD(HOUR, -24, GETUTCDATE())
                GROUP BY ws.wait_category_desc
                ORDER BY total_wait_ms DESC;`;
        } else if (categoryId === 'performance' && queryId === 'memory-buffer-health') {
            sqlText = `
                SELECT 
                    counter_name, 
                    cntr_value AS raw_value,
                    CASE 
                        WHEN counter_name = 'Page life expectancy' AND cntr_value < 300 THEN 'CRITICAL: Severe Buffer Pool Pressure (< 300s)'
                        WHEN counter_name = 'Page life expectancy' AND cntr_value < 600 THEN 'WARNING: Moderate Memory Churn (< 600s)'
                        WHEN counter_name = 'Page life expectancy' THEN 'HEALTHY: Stable Buffer Life'
                        ELSE 'METRIC'
                    END AS evaluation
                FROM sys.dm_os_performance_counters
                WHERE object_name LIKE '%Buffer Manager%'
                  AND counter_name IN ('Page life expectancy', 'Buffer cache hit ratio', 'Page reads/sec', 'Page writes/sec')
                UNION ALL
                SELECT 
                    'Active Memory Grants Outstanding' AS counter_name,
                    COUNT(*) AS raw_value,
                    CASE WHEN COUNT(*) > 5 THEN 'WARNING: High Concurrent Grants' ELSE 'HEALTHY' END AS evaluation
                FROM sys.dm_exec_query_memory_grants;`;
        } else if (categoryId === 'performance' && queryId === 'plan-cache-bloat') {
            sqlText = `
                SELECT 
                    objtype AS cache_object_type,
                    COUNT_BIG(*) AS total_plans,
                    CAST(SUM(CAST(size_in_bytes AS BIGINT)) / 1048576.0 AS DECIMAL(10,2)) AS total_size_mb,
                    AVG(usecounts) AS avg_execution_count,
                    CASE 
                        WHEN objtype = 'Adhoc' AND SUM(CAST(size_in_bytes AS BIGINT)) / 1048576.0 > 500 
                            THEN 'CRITICAL: High Ad-Hoc Plan Bloat (Enable optimize for ad hoc workloads)'
                        ELSE 'OK'
                    END AS cache_health
                FROM sys.dm_exec_cached_plans
                GROUP BY objtype
                ORDER BY total_size_mb DESC;`;
        } else if (categoryId === 'performance' && queryId === 'query-store-insights') {
            sqlText = `${dbPrefix}
                SELECT TOP 20
                    q.query_id,
                    p.plan_id,
                    qt.query_sql_text AS query_text,
                    SUM(rs.count_executions) AS total_executions,
                    SUM(rs.avg_cpu_time * rs.count_executions) / 1000.0 AS total_cpu_ms,
                    (SUM(rs.avg_cpu_time * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0)) / 1000.0 AS avg_cpu_ms,
                    MAX(rs.max_cpu_time) / 1000.0 AS max_cpu_ms,
                    SUM(rs.avg_logical_io_reads * rs.count_executions) AS total_logical_reads,
                    @targetDb AS database_name
                FROM sys.query_store_query_text AS qt
                JOIN sys.query_store_query AS q ON qt.query_text_id = q.query_text_id
                JOIN sys.query_store_plan AS p ON q.query_id = p.query_id
                JOIN sys.query_store_runtime_stats AS rs ON p.plan_id = rs.plan_id
                GROUP BY q.query_id, p.plan_id, qt.query_sql_text
                ORDER BY total_cpu_ms DESC;`;
        } else if (categoryId === 'index-maintenance' && queryId === 'missing-indexes') {
            sqlText = `${dbPrefix}
                SELECT TOP 20
                    CAST(migs.avg_user_impact AS DECIMAL(5,2)) AS avg_user_impact_pct,
                    migs.user_seeks,
                    migs.user_scans,
                    @targetDb AS database_name,
                    OBJECT_NAME(mid.object_id, mid.database_id) AS table_name,
                    'CREATE NONCLUSTERED INDEX [IX_' + REPLACE(REPLACE(REPLACE(ISNULL(OBJECT_NAME(mid.object_id, mid.database_id),''), '[', ''), ']', ''), ' ', '_') 
                     + '_' + CAST(mid.index_handle AS VARCHAR(10)) + '] ON ' + mid.statement + ' (' + ISNULL(mid.equality_columns, '') 
                     + CASE WHEN mid.equality_columns IS NOT NULL AND mid.inequality_columns IS NOT NULL THEN ', ' ELSE '' END 
                     + ISNULL(mid.inequality_columns, '') + ')' 
                     + ISNULL(' INCLUDE (' + mid.included_columns + ')', '') + ';' AS CREATE_INDEX_DDL
                FROM sys.dm_db_missing_index_group_stats migs
                JOIN sys.dm_db_missing_index_groups mig ON migs.group_handle = mig.index_group_handle
                JOIN sys.dm_db_missing_index_details mid ON mig.index_handle = mid.index_handle
                WHERE mid.database_id = DB_ID(@targetDb)
                ORDER BY migs.avg_user_impact * (migs.user_seeks + migs.user_scans) DESC;`;
        } else if (categoryId === 'index-maintenance' && queryId === 'index-fragmentation') {
            sqlText = `${dbPrefix}
                SELECT TOP 25
                    @targetDb AS database_name,
                    OBJECT_SCHEMA_NAME(ips.object_id, ips.database_id) + '.' + OBJECT_NAME(ips.object_id, ips.database_id) AS table_name,
                    ISNULL(i.name, '(Heap)') AS index_name,
                    CAST(ips.avg_fragmentation_in_percent AS DECIMAL(5,2)) AS avg_fragmentation_pct,
                    ips.page_count,
                    CASE 
                        WHEN i.index_id = 0 THEN 'HEAP: Table without clustered index'
                        WHEN ips.avg_fragmentation_in_percent > 30 THEN 'CRITICAL: Rebuild Recommended (>30%)'
                        WHEN ips.avg_fragmentation_in_percent >= 10 THEN 'WARNING: Reorganize Recommended (10-30%)'
                        ELSE 'HEALTHY'
                    END AS recommendation,
                    CASE 
                        WHEN i.index_id = 0 THEN NULL
                        WHEN ips.avg_fragmentation_in_percent > 30 
                            THEN 'ALTER INDEX [' + i.name + '] ON [' + OBJECT_SCHEMA_NAME(ips.object_id, ips.database_id) + '].[' + OBJECT_NAME(ips.object_id, ips.database_id) + '] REBUILD;'
                        WHEN ips.avg_fragmentation_in_percent >= 10 
                            THEN 'ALTER INDEX [' + i.name + '] ON [' + OBJECT_SCHEMA_NAME(ips.object_id, ips.database_id) + '].[' + OBJECT_NAME(ips.object_id, ips.database_id) + '] REORGANIZE;'
                        ELSE NULL 
                    END AS REMEDIATION_SQL
                FROM sys.dm_db_index_physical_stats(DB_ID(@targetDb), NULL, NULL, NULL, 'LIMITED') ips
                JOIN sys.indexes i ON ips.object_id = i.object_id AND ips.index_id = i.index_id
                WHERE ips.avg_fragmentation_in_percent > 10 
                  AND ips.page_count > 50
                  AND ips.index_id IS NOT NULL
                ORDER BY ips.avg_fragmentation_in_percent DESC;`;
        } else if (categoryId === 'blocking-deadlocks' && queryId === 'active-blockers') {
            sqlText = `
                SELECT 
                    r.session_id, 
                    r.blocking_session_id, 
                    r.wait_type, 
                    r.wait_time, 
                    r.status, 
                    r.cpu_time
                FROM sys.dm_exec_requests r
                WHERE r.blocking_session_id <> 0;`;
        } else if (categoryId === 'blocking-deadlocks' && queryId === 'long-running-transactions') {
            sqlText = `
                SELECT 
                    r.session_id,
                    s.login_name,
                    s.host_name,
                    s.program_name,
                    r.status,
                    r.command,
                    r.wait_type,
                    CAST(r.total_elapsed_time / 1000.0 AS DECIMAL(10,2)) AS elapsed_sec,
                    CAST(r.cpu_time / 1000.0 AS DECIMAL(10,2)) AS cpu_sec,
                    r.logical_reads,
                    SUBSTRING(
                        t.text, 
                        (r.statement_start_offset / 2) + 1,
                        ((CASE r.statement_end_offset 
                            WHEN -1 THEN DATALENGTH(t.text) 
                            ELSE r.statement_end_offset 
                          END - r.statement_start_offset) / 2) + 1
                    ) AS running_statement,
                    DB_NAME(r.database_id) AS database_name
                FROM sys.dm_exec_requests r
                JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
                CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
                WHERE s.is_user_process = 1
                  AND r.session_id <> @@SPID
                  AND (DB_NAME(r.database_id) = @targetDb OR DB_NAME(s.database_id) = @targetDb)
                ORDER BY r.total_elapsed_time DESC;`;
        } else if (categoryId === 'blocking-deadlocks' && queryId === 'deadlock-history') {
            sqlText = `
                WITH DeadlockData AS (
                    SELECT 
                        CAST(target_data AS XML) AS target_data
                    FROM sys.dm_xe_session_targets st
                    JOIN sys.dm_xe_sessions s ON s.address = st.event_session_address
                    WHERE s.name = 'system_health' AND st.target_name = 'ring_buffer'
                )
                SELECT TOP 10
                    CONVERT(VARCHAR(19), e.event_data.value('(@timestamp)[1]', 'datetime2'), 120) AS deadlock_time,
                    ISNULL(e.event_data.value('(data[@name="database_name"]/value)[1]', 'VARCHAR(128)'), @targetDb) AS database_name,
                    'DEADLOCK DETECTED' AS status
                FROM DeadlockData
                CROSS APPLY target_data.nodes('//RingBufferTarget/event[@name="xml_deadlock_report"]') AS e(event_data)
                ORDER BY deadlock_time DESC;`;
        } else if (categoryId === 'storage-vlf' && queryId === 'vlf-health') {
            sqlText = `${dbPrefix}
                SELECT 
                    DB_NAME(v.database_id) AS database_name,
                    COUNT(v.vlf_sequence_number) AS total_vlfs,
                    SUM(CAST(v.vlf_size_mb AS DECIMAL(10,2))) AS total_log_size_mb,
                    SUM(CASE WHEN v.vlf_active = 1 THEN 1 ELSE 0 END) AS active_vlfs,
                    CASE 
                        WHEN COUNT(v.vlf_sequence_number) > 1000 THEN 'CRITICAL: > 1000 VLFs (High Fragmentation)'
                        WHEN COUNT(v.vlf_sequence_number) > 500 THEN 'WARNING: > 500 VLFs'
                        ELSE 'HEALTHY'
                    END AS vlf_health
                FROM sys.databases d
                CROSS APPLY sys.dm_db_log_info(d.database_id) v
                WHERE d.name = @targetDb
                GROUP BY v.database_id;`;
        } else if (categoryId === 'storage-vlf' && queryId === 'tempdb-contention') {
            sqlText = `
                SELECT 
                    session_id, 
                    wait_type, 
                    wait_duration_ms, 
                    resource_description,
                    CASE 
                        WHEN resource_description LIKE '2:%:1' OR resource_description LIKE '2:%:3' THEN 'PFS Allocation Page Contention'
                        WHEN resource_description LIKE '2:%:2' THEN 'GAM Allocation Page Contention'
                        WHEN resource_description LIKE '2:%:6' THEN 'SGAM Allocation Page Contention'
                        ELSE 'Data Page Latch Contention'
                    END AS contention_type,
                    'CRITICAL: Add TempDB data files with equal sizing' AS recommendation
                FROM sys.dm_os_waiting_tasks
                WHERE wait_type LIKE 'PAGELATCH%' AND resource_description LIKE '2:%';`;
        } else if (categoryId === 'storage-vlf' && queryId === 'file-growth-config') {
            sqlText = `${dbPrefix}
                SELECT 
                    f.name AS logical_file_name,
                    f.type_desc AS file_type,
                    CAST(f.size * 8.0 / 1024 AS DECIMAL(10,2)) AS current_size_mb,
                    CASE f.max_size 
                        WHEN -1 THEN 'Unrestricted' 
                        WHEN 0 THEN 'No Growth' 
                        ELSE CAST(CAST(f.max_size * 8.0 / 1024 AS DECIMAL(10,2)) AS VARCHAR(20)) + ' MB' 
                    END AS max_size_limit,
                    CASE 
                        WHEN f.is_percent_growth = 1 THEN CAST(f.growth AS VARCHAR(10)) + '%'
                        ELSE CAST(CAST(f.growth * 8.0 / 1024 AS DECIMAL(10,2)) AS VARCHAR(10)) + ' MB'
                    END AS growth_increment,
                    CASE 
                        WHEN f.is_percent_growth = 1 THEN 'CRITICAL: Change percent growth to fixed MB increments'
                        WHEN f.growth = 0 THEN 'WARNING: Autogrowth is disabled'
                        ELSE 'HEALTHY: Fixed MB growth'
                    END AS storage_recommendation,
                    f.physical_name
                FROM sys.database_files f;`;
        } else if (categoryId === 'storage-vlf' && queryId === 'tempdb-config') {
            sqlText = `
                SELECT 
                    f.name AS tempdb_file,
                    f.type_desc,
                    CAST(f.size * 8.0 / 1024 AS DECIMAL(10,2)) AS size_mb,
                    CASE 
                        WHEN f.is_percent_growth = 1 THEN CAST(f.growth AS VARCHAR(10)) + '%'
                        ELSE CAST(CAST(f.growth * 8.0 / 1024 AS DECIMAL(10,2)) AS VARCHAR(10)) + ' MB'
                    END AS growth_setting
                FROM sys.master_files f
                WHERE f.database_id = DB_ID('tempdb');`;
        } else if (categoryId === 'ag-health' && queryId === 'ag-replica-states') {
            sqlText = `
                IF CAST(SERVERPROPERTY('IsHadrEnabled') AS INT) = 1
                BEGIN
                    SELECT 
                        ISNULL(ag.name, 'N/A') AS ag_name,
                        ar.replica_server_name,
                        ars.role_desc,
                        ars.operational_state_desc,
                        ars.connected_state_desc,
                        ars.synchronization_health_desc,
                        ISNULL(hdrs.synchronization_state_desc, 'N/A') AS synchronization_state_desc,
                        CONVERT(VARCHAR(19), hdrs.last_sent_time, 120) AS last_sent_time,
                        CONVERT(VARCHAR(19), hdrs.last_received_time, 120) AS last_received_time,
                        CONVERT(VARCHAR(19), hdrs.last_hardened_time, 120) AS last_hardened_time,
                        CONVERT(VARCHAR(19), hdrs.last_redone_time, 120) AS last_redone_time
                    FROM sys.availability_groups ag
                    INNER JOIN sys.availability_replicas ar ON ag.group_id = ar.group_id
                    INNER JOIN sys.dm_hadr_availability_replica_states ars ON ar.replica_id = ars.replica_id
                    LEFT JOIN sys.dm_hadr_database_replica_states hdrs ON ar.replica_id = hdrs.replica_id;
                END
                ELSE
                BEGIN
                    SELECT 
                        '(None - Standalone)' AS ag_name,
                        CAST(SERVERPROPERTY('ServerName') AS VARCHAR(100)) AS replica_server_name,
                        'STANDALONE' AS role_desc,
                        'ONLINE' AS operational_state_desc,
                        'CONNECTED' AS connected_state_desc,
                        'HEALTHY' AS synchronization_health_desc,
                        'STANDALONE_INSTANCE' AS synchronization_state_desc;
                END`;
        } else if (categoryId === 'security-audit' && queryId === 'orphan-users') {
            sqlText = `${dbPrefix}SELECT name, principal_id, type_desc FROM sys.database_principals WHERE type IN ('S', 'U', 'G') AND sid NOT IN (SELECT sid FROM sys.server_principals);`;
        } else if (categoryId === 'best-practices' && queryId === 'db-configurations') {
            sqlText = `
                SELECT 
                    name,
                    recovery_model_desc,
                    page_verify_option_desc,
                    is_auto_close_on,
                    is_auto_shrink_on,
                    is_auto_create_stats_on,
                    is_auto_update_stats_on,
                    target_recovery_time_in_seconds,
                    CASE 
                        WHEN is_auto_close_on = 1 THEN 'CRITICAL: Disable AUTO_CLOSE'
                        WHEN is_auto_shrink_on = 1 THEN 'CRITICAL: Disable AUTO_SHRINK'
                        WHEN page_verify_option_desc <> 'CHECKSUM' THEN 'WARNING: Set Page Verify to CHECKSUM'
                        WHEN is_auto_create_stats_on = 0 THEN 'WARNING: Enable AUTO_CREATE_STATISTICS'
                        WHEN is_auto_update_stats_on = 0 THEN 'WARNING: Enable AUTO_UPDATE_STATISTICS'
                        ELSE 'HEALTHY: Follows MS Baselines'
                    END AS recommendation,
                    CASE 
                        WHEN is_auto_shrink_on = 1 THEN 'ALTER DATABASE [' + name + '] SET AUTO_SHRINK OFF;'
                        ELSE NULL 
                    END AS SQL_ACTION
                FROM sys.databases 
                WHERE name = @targetDb;`;
        } else if (categoryId === 'best-practices' && queryId === 'compatibility-level') {
            sqlText = `
                SELECT 
                    name,
                    compatibility_level,
                    CASE compatibility_level
                        WHEN 170 THEN 'SQL Server 2025 (v17.0)'
                        WHEN 160 THEN 'SQL Server 2022 (v16.0)'
                        WHEN 150 THEN 'SQL Server 2019 (v15.0)'
                        WHEN 140 THEN 'SQL Server 2017 (v14.0)'
                        WHEN 130 THEN 'SQL Server 2016 (v13.0)'
                        ELSE 'Legacy Compatibility Level'
                    END AS engine_target_version,
                    is_read_committed_snapshot_on,
                    snapshot_isolation_state_desc
                FROM sys.databases 
                WHERE name = @targetDb;`;
        } else if (categoryId === 'best-practices' && queryId === 'isolation-levels') {
            sqlText = `
                SELECT 
                    name AS database_name,
                    is_read_committed_snapshot_on AS rcsi_enabled,
                    snapshot_isolation_state_desc,
                    CASE 
                        WHEN is_read_committed_snapshot_on = 1 THEN 'RECOMMENDED: RCSI is Enabled (Reduces blocking)'
                        ELSE 'INFO: RCSI is Disabled (Standard locking behavior)'
                    END AS concurrency_recommendation
                FROM sys.databases 
                WHERE name = @targetDb;`;
        } else {
            throw new Error(`Unknown query definition: ${categoryId}/${queryId}`);
        }

        const result = await request.query(sqlText);
        const records = Array.isArray(result.recordset) 
            ? result.recordset 
            : (result.recordsets && result.recordsets.length ? result.recordsets[result.recordsets.length - 1] : []);

        res.json({
            success: true,
            elapsedMs: Date.now() - startTime,
            recordsets: [records]
        });
    } catch (err) {
        console.error(`Query Execution Error (${categoryId}/${queryId}):`, err.message);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`SQLDB Toolkit backend running on port ${PORT}`);
    console.log(`==================================================\n`);
    if (process.env.AUTO_OPEN_BROWSER === 'true') {
        exec(`start http://localhost:${PORT}`);
    }
});
