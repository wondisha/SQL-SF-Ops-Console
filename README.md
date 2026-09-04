Set-Content -Path .\README.md -Value (Get-Clipboard) -Encoding utf8
Write-Host "README.md updated successfully." -ForegroundColor Green
