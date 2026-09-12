param(
    [switch]$InstallDependencies
)

$ErrorActionPreference = "Stop"

$releaseName = "SQL-SF-Ops-Console-Demo"
$stagingFolder = Join-Path $PSScriptRoot "dist-release"
$zipFile = Join-Path $PSScriptRoot "$releaseName.zip"

Write-Host "Building release: $releaseName" -ForegroundColor Cyan

if (Test-Path $stagingFolder) { Remove-Item $stagingFolder -Recurse -Force }
if (Test-Path $zipFile) { Remove-Item $zipFile -Force }
New-Item -ItemType Directory -Path $stagingFolder -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stagingFolder "src") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stagingFolder "public") -Force | Out-Null

Write-Host "[1/5] Copying application files..." -ForegroundColor Yellow
Copy-Item (Join-Path $PSScriptRoot "src\server.js") (Join-Path $stagingFolder "src\server.js") -Force
Copy-Item (Join-Path $PSScriptRoot "public\*") (Join-Path $stagingFolder "public") -Recurse -Force
Copy-Item (Join-Path $PSScriptRoot "package.json") (Join-Path $stagingFolder "package.json") -Force
Copy-Item (Join-Path $PSScriptRoot "package-lock.json") (Join-Path $stagingFolder "package-lock.json") -Force
Copy-Item (Join-Path $PSScriptRoot "README.md") (Join-Path $stagingFolder "README.md") -Force
Copy-Item (Join-Path $PSScriptRoot "INSTRUCTIONS.md") (Join-Path $stagingFolder "INSTRUCTIONS.md") -Force
Copy-Item (Join-Path $PSScriptRoot "LICENSE") (Join-Path $stagingFolder "LICENSE") -Force
Copy-Item (Join-Path $PSScriptRoot "SHARING-POST.md") (Join-Path $stagingFolder "SHARING-POST.md") -Force

Write-Host "[2/5] Writing demo-safe configuration..." -ForegroundColor Yellow
@"
PORT=4000
AUTO_OPEN_BROWSER=false
DEMO_MODE=true
MYSQL_HOST=localhost

# Required for live API access. Configure these before using start-console.bat.
AUTH_JWKS_URL=
AUTH_ISSUER=
AUTH_AUDIENCE=

# Inject these from a secret manager or an untracked local .env file.
OMNIDB_SQL_DEMO_USER=
OMNIDB_SQL_DEMO_PASSWORD=
OMNIDB_SNOWFLAKE_DEMO_USER=
OMNIDB_SNOWFLAKE_DEMO_PASSWORD=
OMNIDB_POSTGRES_DEMO_USER=
OMNIDB_POSTGRES_DEMO_PASSWORD=
OMNIDB_MYSQL_DEMO_USER=
OMNIDB_MYSQL_DEMO_PASSWORD=
OMNIDB_DB2_DEMO_USER=
OMNIDB_DB2_DEMO_PASSWORD=
"@ | Set-Content (Join-Path $stagingFolder ".env.example") -Encoding ASCII

@"
id,name,server,database,engine,warehouse,role,user,password,encrypt
sql-demo,SQL Server Demo,localhost,master,sqlserver,,,,,false
snowflake-demo,Snowflake Demo,account.snowflakecomputing.com,SNOWFLAKE,snowflake,COMPUTE_WH,MONITOR_ROLE,,,true
postgres-demo,PostgreSQL Demo,localhost,postgres,postgres,,,,,false
mysql-demo,MySQL Demo,localhost,appdb,mysql,,,,,false
db2-demo,IBM DB2 Demo,localhost,SAMPLE,db2,,,,,false
"@ | Set-Content (Join-Path $stagingFolder "servers.example.csv") -Encoding ASCII

Write-Host "[3/5] Writing launchers..." -ForegroundColor Yellow
@"
@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules call npm ci --omit=dev
if not exist .env copy .env.example .env >nul
if not exist servers.csv copy servers.example.csv servers.csv >nul
set "PORT=4000"
netstat -aon | findstr ":4000 .*LISTENING" >nul
if not errorlevel 1 (
    set "PORT=4001"
    echo Port 4000 is already in use. Using port 4001 instead.
)
echo Starting OmniDB Console demo at http://localhost:%PORT%
set DEMO_MODE=true
node src/server.js
pause
"@ | Set-Content (Join-Path $stagingFolder "start-demo.bat") -Encoding ASCII

@"
@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules call npm ci --omit=dev
if not exist .env copy .env.example .env >nul
if not exist servers.csv copy servers.example.csv servers.csv >nul
set "PORT=4000"
netstat -aon | findstr ":4000 .*LISTENING" >nul
if not errorlevel 1 (
    set "PORT=4001"
    echo Port 4000 is already in use. Using port 4001 instead.
)
echo Starting OmniDB Console at http://localhost:%PORT%
set DEMO_MODE=false
node src/server.js
pause
"@ | Set-Content (Join-Path $stagingFolder "start-console.bat") -Encoding ASCII

Write-Host "[4/5] Installing production dependencies..." -ForegroundColor Yellow
if ($InstallDependencies) {
    Push-Location $stagingFolder
    try { npm ci --omit=dev } finally { Pop-Location }
} else {
    Write-Host "Skipped. The launchers install dependencies on first run." -ForegroundColor DarkYellow
}

Write-Host "[5/5] Creating ZIP archive..." -ForegroundColor Yellow
Compress-Archive -Path (Join-Path $stagingFolder "*") -DestinationPath $zipFile -CompressionLevel Optimal

Write-Host "Release ready: $zipFile" -ForegroundColor Green
if (-not $InstallDependencies) {
    Write-Host "Recipients need Node.js 20+ and network access for the first npm install." -ForegroundColor Yellow
}
