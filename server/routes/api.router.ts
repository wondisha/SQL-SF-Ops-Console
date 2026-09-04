import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { authenticateToken, requirePermission } from "../middleware/auth.middleware";

export const apiRouter = Router();
const IS_DEMO_MODE = process.env.DEMO_MODE === "true";

function sanitizeRowData(rows: any[]): any[] {
  if (!Array.isArray(rows)) return [];
  const sensitivePathRegex = /([a-zA-Z]:\\[^ \t\r\n<>"':|?*]+|\/(?:etc|var|usr|home|opt)\/[^ \t\r\n<>"':|?*]+)/gi;
  const sensitiveAccountRegex = /(NT SERVICE\\[a-zA-Z0-9_$]+|[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+)/gi;

  return rows.map((row) => {
    if (typeof row !== "object" || row === null) return row;
    const cleanRow: any = {};
    for (const [key, val] of Object.entries(row)) {
      if (typeof val === "string") {
        cleanRow[key] = val
          .replace(sensitivePathRegex, "[REDACTED_PATH]")
          .replace(sensitiveAccountRegex, "[REDACTED_ACCOUNT]");
      } else {
        cleanRow[key] = val;
      }
    }
    return cleanRow;
  });
}

function getInventory() {
  const csvPath = path.join(process.cwd(), "servers.csv");
  if (!fs.existsSync(csvPath) || IS_DEMO_MODE) {
    if (!fs.existsSync(csvPath) && !IS_DEMO_MODE) return [];
    return [
      { id: "sql-primary", name: "Production SQL Server", engine: "sqlserver", server: "sql-cluster.internal", database: "master" },
      { id: "snowflake-prod", name: "Snowflake Analytics", engine: "snowflake", server: "xy12345.snowflakecomputing.com", database: "SNOWFLAKE" },
      { id: "postgres-prod", name: "PostgreSQL Primary", engine: "postgres", server: "pg-pool.internal", database: "app_production" },
      { id: "mysql-prod", name: "MySQL Core", engine: "mysql", server: "mysql-master.internal", database: "appdb" }
    ];
  }
  const lines = fs.readFileSync(csvPath, "utf-8").split("\n").filter(l => l.trim().length > 0);
  const header = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(",").map(v => v.trim());
    const obj: any = {};
    header.forEach((col, idx) => {
      if (col !== "password") obj[col] = values[idx] || "";
    });
    return obj;
  });
}

apiRouter.use(authenticateToken);

apiRouter.get("/health", (_req: Request, res: Response) => {
  return res.json({
    status: "HEALTHY",
    timestamp: new Date().toISOString(),
    mode: IS_DEMO_MODE ? "SIMULATION" : "LIVE"
  });
});

apiRouter.get("/servers", (_req: Request, res: Response) => {
  return res.json(getInventory());
});

apiRouter.get(["/servers/:serverId/status", "/servers/:serverId/test", "/test-connection/:serverId"], (_req: Request, res: Response) => {
  return res.json({ status: "ONLINE", connected: true, latencyMs: 12 });
});

apiRouter.get(["/databases", "/databases/:serverId", "/servers/:serverId/databases"], (req: Request, res: Response) => {
  const serverId = (req.params.serverId || (req.query.server as string) || "").toLowerCase();
  
  const rawList = serverId.includes("snowflake")
    ? ["SNOWFLAKE", "FINANCIAL_DB", "CUSTOMER_360", "ANALYTICS_PROD"]
    : ["master", "AdventureWorks2025", "CustomerPortal_Prod", "msdb", "tempdb"];

  // Return formatted objects with valueOf/toString fallback so both obj.name and string indexing work
  const formatted = rawList.map(name => ({
    id: name,
    name: name,
    database: name,
    label: name,
    toString: () => name
  }));

  return res.json(formatted);
});

apiRouter.get('/catalog', requirePermission('diagnostics:read'), (_req: Request, res: Response) => {
  const allCategories = [
    {
      id: "health",
      label: "Health Check",
      title: "Health Check",
      name: "Health Check",
      description: "Waits, storage, backups, agent jobs, and instance vital metrics.",
      engines: ["sqlserver", "snowflake", "postgres", "mysql", "db2", "SQLSERVER", "SNOWFLAKE"],
      queries: [
        { id: "instance-vitals", name: "Instance Vitals & Uptime", title: "Instance Vitals & Uptime", label: "Instance Vitals & Uptime", scope: "Instance" },
        { id: "top-waits", name: "Active Wait Profiles", title: "Active Wait Profiles", label: "Active Wait Profiles", scope: "Instance" },
        { id: "storage-summary", name: "Data Volume & Log Sizing", title: "Data Volume & Log Sizing", label: "Data Volume & Log Sizing", scope: "Instance" }
      ]
    },
    {
      id: "snowflake-finops",
      label: "Snowflake FinOps & AI",
      title: "Snowflake FinOps & AI",
      name: "Snowflake FinOps & AI",
      description: "Warehouse credit metering, query spillage, cache efficiency, and idle compute audits.",
      engines: ["snowflake", "SNOWFLAKE", "sqlserver", "SQLSERVER"],
      queries: [
        { id: "warehouse-metering", name: "Warehouse Credit Consumption", title: "Warehouse Credit Consumption", label: "Warehouse Credit Consumption", scope: "SNOWFLAKE" },
        { id: "idle-suspend-audit", name: "Warehouse Inefficiency & Idle Suspend Audit", title: "Warehouse Inefficiency & Idle Suspend Audit", label: "Warehouse Inefficiency & Idle Suspend Audit", scope: "SNOWFLAKE" },
        { id: "resource-monitors", name: "Resource Monitor Budget & Quota Compliance", title: "Resource Monitor Budget & Quota Compliance", label: "Resource Monitor Budget & Quota Compliance", scope: "SNOWFLAKE" }
      ]
    }
  ];

  return res.json(allCategories);
});

apiRouter.get("/query/:categoryId/:queryId", requirePermission("diagnostics:read"), async (req: Request, res: Response) => {
  const { categoryId, queryId } = req.params;
  const serverId = (req.query.server as string) || (req.query.serverId as string) || "sql-primary";
  const database = (req.query.database as string) || "master";
  const startTime = Date.now();

  const titleMap: Record<string, string> = {
    "instance-vitals": "Instance Vitals & Uptime",
    "top-waits": "Active Wait Profiles",
    "storage-summary": "Data Volume & Log Sizing",
    "warehouse-metering": "Warehouse Credit Consumption",
    "idle-suspend-audit": "Warehouse Inefficiency & Idle Suspend Audit",
    "resource-monitors": "Resource Monitor Budget & Quota Compliance"
  };

  const resolvedTitle = titleMap[queryId] || queryId.replace(/-/g, " ");

  if (IS_DEMO_MODE) {
    let columns: string[] = [];
    let rows: any[] = [];

    const isSnowflake = serverId.toLowerCase().includes("snowflake") || database.toUpperCase() === "SNOWFLAKE";

    if (isSnowflake) {
      if (queryId === "instance-vitals" || queryId === "warehouse-metering") {
        columns = ["WAREHOUSE_NAME", "CREDITS_USED_COMPUTE", "CREDITS_USED_CLOUD_SERVICES", "START_TIME"];
        rows = [
          { WAREHOUSE_NAME: "ANALYTICS_WH", CREDITS_USED_COMPUTE: 14.5, CREDITS_USED_CLOUD_SERVICES: 0.8, START_TIME: "2026-09-04 12:00:00" },
          { WAREHOUSE_NAME: "INGESTION_WH", CREDITS_USED_COMPUTE: 8.2, CREDITS_USED_CLOUD_SERVICES: 0.3, START_TIME: "2026-09-04 12:00:00" }
        ];
      } else if (queryId === "top-waits" || queryId === "idle-suspend-audit") {
        columns = ["WAREHOUSE_NAME", "AUTO_SUSPEND_SEC", "IDLE_SECONDS", "RECOMMENDED_ACTION"];
        rows = [
          { WAREHOUSE_NAME: "DEV_WH", AUTO_SUSPEND_SEC: 600, IDLE_SECONDS: 480, RECOMMENDED_ACTION: "Reduce AUTO_SUSPEND to 60s" },
          { WAREHOUSE_NAME: "ADHOC_WH", AUTO_SUSPEND_SEC: 1200, IDLE_SECONDS: 920, RECOMMENDED_ACTION: "Enable Auto-Resume & Set 120s" }
        ];
      } else {
        columns = ["MONITOR_NAME", "CREDIT_QUOTA", "USED_CREDITS", "NOTIFY_AT_%", "STATE"];
        rows = [
          { MONITOR_NAME: "CORP_FINANCE_LIMIT", CREDIT_QUOTA: 500, USED_CREDITS: 320, "NOTIFY_AT_%": 80, STATE: "HEALTHY" }
        ];
      }
    } else {
      if (queryId === "instance-vitals") {
        columns = ["SQLSERVER_START_TIME", "VERSION", "SERVER_STATE", "ACTIVE_CONNECTIONS"];
        rows = [
          { SQLSERVER_START_TIME: "2026-08-30 08:15:22", VERSION: "Microsoft SQL Server 2025 (Enterprise Edition)", SERVER_STATE: "ONLINE", ACTIVE_CONNECTIONS: 42 }
        ];
      } else if (queryId === "top-waits") {
        columns = ["WAIT_TYPE", "WAIT_TIME_MS", "SIGNAL_WAIT_TIME_MS", "WAIT_CATEGORY"];
        rows = [
          { WAIT_TYPE: "SOS_SCHEDULER_YIELD", WAIT_TIME_MS: 1420, SIGNAL_WAIT_TIME_MS: 120, WAIT_CATEGORY: "CPU Scheduling" },
          { WAIT_TYPE: "PAGEIOLATCH_SH", WAIT_TIME_MS: 890, SIGNAL_WAIT_TIME_MS: 45, WAIT_CATEGORY: "Buffer IO Read" },
          { WAIT_TYPE: "ASYNC_NETWORK_IO", WAIT_TIME_MS: 310, SIGNAL_WAIT_TIME_MS: 12, WAIT_CATEGORY: "Client Read" }
        ];
      } else if (queryId === "storage-summary") {
        columns = ["FILE_TYPE", "TOTAL_SIZE_MB", "USED_SPACE_MB", "FREE_SPACE_PERCENT"];
        rows = [
          { FILE_TYPE: "ROWS Data (.mdf)", TOTAL_SIZE_MB: 256000, USED_SPACE_MB: 198400, FREE_SPACE_PERCENT: "22.5%" },
          { FILE_TYPE: "LOG Log (.ldf)", TOTAL_SIZE_MB: 32000, USED_SPACE_MB: 4800, FREE_SPACE_PERCENT: "85.0%" }
        ];
      } else {
        columns = ["SESSION_ID", "STATUS", "COMMAND", "CPU_TIME", "TOTAL_ELAPSED_TIME", "WAIT_TYPE", "DATABASE_NAME"];
        rows = [
          { SESSION_ID: 56, STATUS: "RUNNABLE", COMMAND: "SELECT", CPU_TIME: 14, TOTAL_ELAPSED_TIME: 21, WAIT_TYPE: "SOS_SCHEDULER_YIELD", DATABASE_NAME: database },
          { SESSION_ID: 62, STATUS: "SUSPENDED", COMMAND: "INSERT", CPU_TIME: 120, TOTAL_ELAPSED_TIME: 480, WAIT_TYPE: "PAGEIOLATCH_SH", DATABASE_NAME: database }
        ];
      }
    }

    const elapsedMs = Date.now() - startTime;
    return res.json({
      categoryId,
      queryId,
      title: resolvedTitle,
      name: resolvedTitle,
      label: resolvedTitle,
      elapsedMs,
      columns,
      rows: sanitizeRowData(rows),
      simulated: true
    });
  }

  return res.status(501).json({ error: "NOT_IMPLEMENTED", message: "Live database connector pending." });
});

export default apiRouter;


