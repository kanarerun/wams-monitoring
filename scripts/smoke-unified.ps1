$p = Start-Process node -ArgumentList "server/index.js" -WorkingDirectory "C:\Users\Khelvin\OneDrive\Desktop\wams" -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\wams-out.log" -RedirectStandardError "$env:TEMP\wams-err.log"
Start-Sleep -Seconds 6
try {
  $r = Invoke-WebRequest -Uri "http://localhost:3000/" -UseBasicParsing -TimeoutSec 10
  Write-Output ("home: " + $r.StatusCode)
} catch { Write-Output ("home failed: " + $_.Exception.Message) }
try {
  $r2 = Invoke-WebRequest -Uri "http://localhost:3000/WAMS/student/wams-student-log-in.html" -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 10 -ErrorAction SilentlyContinue
} catch {
  Write-Output ("legacy student page redirect: " + [int]$_.Exception.Response.StatusCode + " -> " + $_.Exception.Response.Headers['Location'])
}
# Identify a real student number (with and without dashes)
foreach ($id in @('2026-001','2026001')) {
  $b = '{"identifier":"' + $id + '"}'
  try {
    $r3 = Invoke-WebRequest -Uri "http://localhost:3000/api/auth/identify" -Method Post -ContentType "application/json" -Body $b -UseBasicParsing
    Write-Output ("identify '$id': " + $r3.Content)
  } catch {
    $resp = $_.Exception.Response
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    Write-Output ("identify '$id' failed: " + [int]$resp.StatusCode + " " + $sr.ReadToEnd())
  }
}
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
