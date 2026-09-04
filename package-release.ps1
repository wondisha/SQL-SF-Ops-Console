$ErrorActionPreference = "Stop"
$releaseName   = "SQL&SF-Ops-Console-v1.0.0-Production"
$stagingFolder = ".\dist-release"
$zipFile       = ".\$releaseName.zip"

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host " Building Production Release: $releaseName" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

if (Test-Path $stagingFolder) { Remove-Item -Recurse -Force $stagingFolder }
New-Item -ItemType Directory -Path "$stagingFolder\src" -Force | Out-Null
New-Item -ItemType Directory -Path "$stagingFolder\public" -Force | Out-Null

Write-Host "[1/5] Copying core server and static UI assets..." -ForegroundColor Yellow
Copy-Item -Force ".\src\server.js" "$stagingFolder\src\server.js"
Copy-Item -Recurse -Force ".\public\*" "$stagingFolder\public\"
Copy-Item -Force ".\package.json" "$stagingFolder\package.json"
if (Test-Path ".\package-lock.json") {
    Copy-Item -Force ".\package-lock.json" "$stagingFolder\package-lock.json"
}

Write-Host "[2/5] Creating configuration templates..." -ForegroundColor Yellow
@'
PORT=4000
AUTO_OPEN_BROWSER=true
SNOWFLAKE_ACCOUNT=FUYJNCR-VC67103
SNOWFLAKE_USER=SFSESSIONUSER
SNOWFLAKE_PASSWORD=YourPasswordHere
SNOWFLAKE_WAREHOUSE=COMPUTE_WH
SNOWFLAKE_DATABASE=SNOWFLAKE
SNOWFLAKE_ROLE=ACCOUNTADMIN
