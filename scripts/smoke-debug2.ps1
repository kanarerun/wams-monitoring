$env:TURSO_DATABASE_URL = $env:TURSO_DATABASE_URL
$p = Start-Process node -ArgumentList "server/index.js" -WorkingDirectory "C:\Users\Khelvin\OneDrive\Desktop\wams" -PassThru -WindowStyle Hidden -RedirectStandardError "$env:TEMP\w-err3.log" -RedirectStandardOutput "$env:TEMP\w-out3.log"
Start-Sleep -Seconds 12
$em = 'smoketest' + (Get-Random) + '@gmail.com'
$sb = ('{"firstName":"Smoke","lastName":"Run","email":"' + $em + '","password":"Password123!"}')
try {
  $r2 = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/register" -Method Post -ContentType "application/json" -Body $sb
  Write-Output ("OK: " + ($r2 | ConvertTo-Json -Compress))
} catch {
  Write-Output "REGISTER ERR"
}
Write-Output "--- stderr tail ---"
Get-Content "$env:TEMP\w-err3.log" | Select-Object -Last 8
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
