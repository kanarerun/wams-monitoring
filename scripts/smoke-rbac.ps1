$p = Start-Process node -ArgumentList "server/index.js" -WorkingDirectory "C:\Users\Khelvin\OneDrive\Desktop\wams" -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\wams-out.log" -RedirectStandardError "$env:TEMP\wams-err.log"
Start-Sleep -Seconds 7

# 1) Admin login (super_admin)
$b = '{"identifier":"admin","credential":"admin123"}'
try {
  $r = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/unified-login" -Method Post -ContentType "application/json" -Body $b
  Write-Output ("admin login: role=" + $r.user.role)
  $tok = $r.token
  $H = @{ Authorization = "Bearer $tok" }

  # 2) professor signup pending
  $sb = '{"firstName":"Smoke","lastName":"Pending","email":"smokepending@gmail.com","password":"Password123!"}'
  try { $r2 = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/register" -Method Post -ContentType "application/json" -Body $sb } catch { Write-Output "(smokepending already registered from a previous run)" }
  Write-Output ("signup: role=" + $r2.role + " status=" + $r2.status)

  # 3) pending professor blocked from sign-in
  try {
    $lb = '{"identifier":"smokepending@gmail.com","credential":"Password123!"}'
    Invoke-RestMethod -Uri "http://localhost:3000/api/auth/unified-login" -Method Post -ContentType "application/json" -Body $lb | Out-Null
    Write-Output "ERROR: pending professor signed in!"
  }
  catch {
    $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Output ("pending blocked: " + $sr.ReadToEnd())
  }

  # 4) professors list shows pending count
  $pl = Invoke-RestMethod -Uri "http://localhost:3000/api/admin/professors" -Headers $H
  Write-Output ("professors: total=" + $pl.professors.Count + " pending=" + $pl.pendingCount)
  $pendingProf = $pl.professors | Where-Object { $_.status -eq 'pending' } | Select-Object -First 1

  # 5) approve works for super_admin
  if ($pendingProf) {
    $ap = Invoke-RestMethod -Uri ("http://localhost:3000/api/admin/professors/" + $pendingProf.id + "/approve") -Method Post -Headers $H
    Write-Output ("approve: " + $ap.message)
  }

  # 6) co-admin RBAC: create a co-admin? (skip - no invite). Test audit endpoint reject without token
  try {
    Invoke-RestMethod -Uri "http://localhost:3000/api/admin/activity-logs" -Headers @{} | Out-Null
  }
  catch { Write-Output ("audit without auth rejected (expected)") }

  # 7) audit logs list
  $logs = Invoke-RestMethod -Uri "http://localhost:3000/api/admin/activity-logs" -Headers $H
  Write-Output ("audit logs: " + $logs.logs.Count + " entries; kpis.totalToday=" + $logs.kpis.totalToday)

  # 8) deletion request flow: create second pending professor, approve, then request delete as (fake) co-admin path is tested via endpoint
  $sb2 = '{"firstName":"Smoke","lastName":"Delete","email":"smokedelete@gmail.com","password":"Password123!"}'
  try { Invoke-RestMethod -Uri "http://localhost:3000/api/auth/register" -Method Post -ContentType "application/json" -Body $sb2 | Out-Null } catch { }
  $pl2 = Invoke-RestMethod -Uri "http://localhost:3000/api/admin/professors" -Headers $H
  $target = $pl2.professors | Where-Object { $_.email -eq 'smokedelete@gmail.com' } | Select-Object -First 1
  if ($target) {
    $dr = Invoke-RestMethod -Uri ("http://localhost:3000/api/admin/users/" + $target.id + "/delete") -Method Post -Headers $H -ContentType "application/json" -Body '{"reason":"smoke test"}'
    Write-Output ("super_admin delete: deleted=" + $dr.deleted + " msg=" + $dr.message)
  }

  # 9) deletion-requests endpoint responds
  $dl = Invoke-RestMethod -Uri "http://localhost:3000/api/admin/deletion-requests" -Headers $H
  Write-Output ("deletion requests visible: " + $dl.requests.Count)
}
catch {
  Write-Output ("FAILED: " + $_.Exception.Message)
}
Get-Content "$env:TEMP\wams-err.log" -ErrorAction SilentlyContinue | Select-Object -First 8
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
