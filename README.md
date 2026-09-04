# OmniDB Console (formerly SQLDB-Toolkit)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/wondisha/SQL-SF-Ops-Console?quickstart=1)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A unified database reliability engineering, performance monitoring, and FinOps audit console for heterogeneous database estates: **Microsoft SQL Server**, **Snowflake**, **PostgreSQL**, **MySQL**, and **IBM DB2**.

---

## ⚡ Try the Interactive Simulation (No Credentials Required)

Test-drive the full UI, engine switching, diagnostic query packs, and FinOps telemetry without needing live database connections or an identity provider:

### Option A: One-Click in the Cloud
Click the **[Open in GitHub Codespaces](https://codespaces.new/wondisha/SQL-SF-Ops-Console?quickstart=1)** badge above. Codespaces will build the environment and automatically launch the console on port 4000.

### Option B: Local Simulation
```bash
# 1. Clone & install
git clone https://github.com/wondisha/SQL-SF-Ops-Console.git
cd SQL-SF-Ops-Console
npm install

# 2. Build TypeScript backend
npm run build:server

# 3. Launch in Simulation Mode
npm run demo
```
Open **`http://localhost:4000`** in your browser.

---

## 🚀 Quick Start (Production / Live Mode)

1. Extract or clone this bundle on your host machine.
2. Configure your target database instances in `servers.csv` (or `.env`).
3. Launch the console:
   - **Windows:** Double-click `start-console.bat`.
   - **Linux / Mac / Containers:** Run `npm start` (or `docker compose up -d`).
4. The dashboard will clear port conflicts and serve the console at **`http://localhost:4000`**.

---

## ⚙️ Configuration Reference

### 1. `servers.csv` (Multi-Engine Fleet Inventory)

Map your heterogeneous database targets in `servers.csv`:

```csv
id,name,server,database,engine,warehouse,role,user,password,encrypt
sql-primary,Production SQL Server,localhost,master,sqlserver,,,svc_omnidb_monitor,StrongSecret123!,false
snowflake-prod,Snowflake Analytics,xy12345.us-east-1,SNOWFLAKE,snowflake,COMPUTE_WH,OMNIDB_MONITOR_ROLE,SVC_OMNIDB_OPS,StrongSecret123!,true
postgres-prod,PostgreSQL Primary,pg-host.internal,app_production,postgres,,,svc_omnidb_monitor,StrongSecret123!,true
mysql-prod,MySQL Core,mysql-host.internal,appdb,mysql,,,svc_omnidb_monitor,StrongSecret123!,true
db2-prod,IBM DB2 Enterprise,db2-host.internal,SAMPLE,db2,,,svc_omnidb_monitor,StrongSecret123!,true
```

---

## 🛡️ Enterprise Security & Hardening

* **Zero-Trust OIDC / Entra ID:** Token validation backed by enterprise JWKS keys.
* **Sensitive Telemetry Sanitization:** The built-in output sanitizer automatically strips internal server paths (e.g., `D:\...`) and service account names (`NT Service\...`) before diagnostic rows reach the client.
* **Immutable Structured Audit Trail:** Every query execution, duration, user context, client IP, and authorization error is logged in structured JSON to `logs/audit.log`.
* **Rate Limiting:** Sliding-window rate limiter (Redis-backed in cluster mode, in-memory fallback for standalone dev).
* **Least-Privilege Roles:** Operates entirely against monitoring views and metadata (`VIEW SERVER STATE` on SQL Server, `pg_monitor` on PostgreSQL, imported metadata roles on Snowflake).

---

## 🐳 Docker Deployment

To deploy in an isolated container environment with Redis:

```bash
# Build and run with Docker Compose
docker compose up -d --build

# Inspect running services
docker compose ps

# View audit logs
docker compose logs -f omnidb-app
```

---

## 📊 Feature Matrix

| Engine | Diagnostic Capabilities |
| :--- | :--- |
| **SQL Server** | Uptime vitals, active wait stats, backup RPO history, transaction log VLF fragmentation, blocking trees, missing indexes, SQL Agent failure monitoring. |
| **Snowflake** | Real-time warehouse credit metering, idle compute & auto-suspend audits, resource monitor thresholds, dynamic data masking coverage, and RBAC inheritance. |
| **PostgreSQL** | Active user sessions, lock wait graphs, buffer pool allocation, `pg_stat_statements` latency. |
| **MySQL** | InnoDB buffer pool sizing, thread connection pools, long-running queries. |
| **IBM DB2** | Application handles, lock waits, unit-of-work status tracking. |
