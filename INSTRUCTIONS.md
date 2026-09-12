# OmniDB Console Demo Instructions

## Quick Demo

1. Extract `SQL-SF-Ops-Console-Demo.zip` to a local folder.
2. Install Node.js 20 or newer if it is not already installed.
3. Double-click `start-demo.bat`.
4. Open http://localhost:4000 in a browser.
5. Select an engine from the Instance menu and review its category panels.

Demo mode uses simulated responses and does not connect to SQL Server, Snowflake, PostgreSQL, MySQL, or DB2.

## Live Connections

Use `start-console.bat` only after replacing the sample entries in `servers.csv` with approved database hosts and credentials and configuring:

- `AUTH_JWKS_URL`: the OIDC/JWKS endpoint used to verify access tokens.
- `AUTH_ISSUER`: the expected token issuer.
- `AUTH_AUDIENCE`: the expected API audience.

Database credentials are not read from `servers.csv`. Supply them through secret-manager injection or an untracked `.env` using names such as `OMNIDB_SQL_PRIMARY_USER` and `OMNIDB_SQL_PRIMARY_PASSWORD`. Replace `SQL_PRIMARY` with the uppercase server ID and convert non-alphanumeric characters to underscores.

Live API requests without valid Bearer JWTs are rejected. Do not send real passwords, tokens, or private keys in email, chat, source control, or ZIP files.

The inventory supports these engines:

- SQL Server: port 1433
- Snowflake: account endpoint
- PostgreSQL: port 5432
- MySQL: port 3306
- IBM DB2: port 50000

## Troubleshooting

- If port 4000 is busy, close the existing OmniDB Console process and start the launcher again.
- For containers, check `/healthz/live` and `/healthz/ready` before investigating database connectivity.
- On first launch, the launcher installs production npm dependencies. Internet access is required.
- If a live connection fails, verify DNS, firewall rules, the database port, TLS settings, and the account permissions.
- Demo mode should not display connection errors because it does not contact external databases.

## Stop the Console

Close the console window or press `Ctrl+C` in the terminal running Node.js.
