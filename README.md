# SQL & Snowflake Ops Console (SQLDB-Toolkit)

Unified database reliability engineering, performance monitoring, and FinOps audit console for Microsoft SQL Server and Snowflake.

---

## Quick Start

1. Extract this zip bundle into any directory on the host machine.
2. Edit `servers.csv` or `.env` with your database credentials.
3. Double-click `start-console.bat`.
4. The dashboard will automatically clear port conflicts and open at `http://localhost:4000`.

---

## Configuration Reference

### 1. `servers.csv` (Multi-Target Inventory)
```csv
id,name,server,database,engine,warehouse,role,user,password,encrypt
local-sql,Local Production SQL,localhost,master,sqlserver,,,sa,YourPasswordHere,false
snowflake-prod,Snowflake Analytics,account-identifier,SNOWFLAKE,snowflake,COMPUTE_WH,ACCOUNTADMIN,username,YourPasswordHere,true