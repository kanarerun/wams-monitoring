$p = Start-Process node -ArgumentList "server/index.js" -WorkingDirectory "C:\Users\Khelvin\OneDrive\Desktop\wams" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 8
$b = '{"identifier":"admin","credential":"admin123"}'
try {
  $r = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/unified-login" -Method Post -ContentType "application/json" -Body $b
  Write-Output ("login role: " + $r.user.role)
  $H = @{ Authorization = "Bearer " + $r.token }
  $em = 'smoketest' + (Get-Random) + '@gmail.com'
  $sb = ('{"firstName":"Smoke","lastName":"Run","email":"' + $em + '","password":"Password123!"}')
  try {
    $r2 = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/register" -Method Post -ContentType "application/json" -Body $sb
    Write-Output ("signup: role=" + $r2.role + " status=" + $r2.status)
  }
  catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $errBody = $sr.ReadToEnd()
      $msg = "signup FAILED: " + [int]$resp.StatusCode + " + " + $errBody
      Write-Output $msg
    } else {
      Write-Output ("signup FAILED: " + $_.Exception.Message)
    }
  }
  try {
    $lb = ('{"identifier":"' + $em + '","credential":"Password123!"}')
    Invoke-RestMethod -Uri "http://localhost:3000/api/auth/unified-login" -Method Post -ContentType "application/json" -Body $lb | Out-Null
    Write-Output "ERROR pending signed in!"
  }
  catch { Write-Output "pending blocked OK" }
  $pl = Invoke-RestMethod -Uri "http://localhost:3000/api/admin/professors" -Headers $H
  $pp = $pl.professors | Where-Object { $_.email -eq $em } | Select-Object -First 1
  Write-Output ("pending count: " + $pl.pendingCount)
  if ($pp) {
    $ap = Invoke-RestMethod -Uri ("http://localhost:3000/api/admin/professors/" + $pp.id + "/approve") -Method Post -Headers $H
    Write-Output ("approve: " + $ap.message)
    $dr = Invoke-RestMethod -Uri ("http://localhost:3000/api/admin/users/" + $pp.id + "/delete") -Method Post -Headers $H -ContentType "application/json" -Body '{"reason":"cleanup"}'
    Write-Output ("delete: deleted=" + $dr.deleted + " msg=" + $dr.message)
  } else {
    Write-Output "no pending prof row found (signup failed earlier)"
  }
  $logs = Invoke-RestMethod -Uri "http://localhost:3000/api/admin/activity-logs" -Headers $H
  Write-Output ("audit: " + $logs.logs.Count + " entries, totalToday=" + $logs.kpis.totalToday)
  $acts = ($logs.logs | Select-Object -First 6 | ForEach-Object { $_.action }) -join ', '
  Write-Output ("recent actions: " + $acts)
}
catch {
  Write-Output ("FAILED: " + $_.Exception.Message)
}
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
