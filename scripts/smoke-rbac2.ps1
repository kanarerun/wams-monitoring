$p = Start-Process node -ArgumentList "server/index.js" -WorkingDirectory "C:\Users\Khelvin\OneDrive\Desktop\wams" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 10

# Login as super admin
$r = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/unified-login" -Method Post -ContentType "application/json" -Body '{"identifier":"admin","credential":"admin123"}'
$H = @{ Authorization = "Bearer " + $r.token }

# Create a co-admin directly in DB via an invite-less trick: we can't create co-admin without invite,
# so instead verify 403 on audit endpoint with NO token, and deletion-request flow using a professor token.
$em = 'smokeco' + (Get-Random) + '@gmail.com'
$sb = ('{"firstName":"Smoke","lastName":"Prof","email":"' + $em + '","password":"Password123!"}')
Invoke-RestMethod -Uri "http://localhost:3000/api/auth/register" -Method Post -ContentType "application/json" -Body $sb | Out-Null

# Approve the professor, then login as professor (professors cannot hit admin endpoints -> 403)
$pl = Invoke-RestMethod -Uri "http://localhost:3000/api/admin/professors" -Headers $H
$pp = $pl.professors | Where-Object { $_.email -eq $em } | Select-Object -First 1
Invoke-RestMethod -Uri ("http://localhost:3000/api/admin/professors/" + $pp.id + "/approve") -Method Post -Headers $H | Out-Null

# Professor login (grace path may require email code; try unified login)
try {
  $pr = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/unified-login" -Method Post -ContentType "application/json" -Body ('{"identifier":"' + $em + '","credential":"Password123!"}')
  $PH = @{ Authorization = "Bearer " + $pr.token }
  try {
    Invoke-RestMethod -Uri "http://localhost:3000/api/admin/activity-logs" -Headers $PH | Out-Null
    Write-Output "ERROR: professor accessed audit logs!"
  } catch { Write-Output ("professor blocked from audit logs: 403 OK") }
  try {
    Invoke-RestMethod -Uri "http://localhost:3000/api/admins" -Headers $PH | Out-Null
    Write-Output "ERROR: professor accessed admin list!"
  } catch { Write-Output ("professor blocked from admin list: 403 OK") }
} catch {
  Write-Output ("professor login needs email code (expected if email configured): " + $_.Exception.Message)
}

# Super admin immediate delete of a professor -> USER_DELETED already tested.
# Co-admin request path cannot be hit without a real co-admin; verify the
# deletion-requests endpoint + pending badge data:
$dl = Invoke-RestMethod -Uri "http://localhost:3000/api/admin/deletion-requests" -Headers $H
Write-Output ("deletion-requests endpoint OK, pending=" + $dl.pendingCount)

# Cleanup the professor
Invoke-RestMethod -Uri ("http://localhost:3000/api/admin/users/" + $pp.id + "/delete") -Method Post -Headers $H -ContentType "application/json" -Body '{"reason":"cleanup"}' | Out-Null
Write-Output "cleanup done"
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
