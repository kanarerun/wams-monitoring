$p = Start-Process node -ArgumentList "server/index.js" -WorkingDirectory "C:\Users\Khelvin\OneDrive\Desktop\wams" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 8
$em = 'smoketest' + (Get-Random) + '@gmail.com'
$sb = ('{"firstName":"Smoke","lastName":"Run","email":"' + $em + '","password":"Password123!"}')
try {
  $r2 = Invoke-RestMethod -Uri "http://localhost:3000/api/auth/register" -Method Post -ContentType "application/json" -Body $sb
  Write-Output ("signup OK: " + ($r2 | ConvertTo-Json -Compress))
} catch {
  Write-Output ("signup err status: " + $_.Exception.Response.StatusCode.value__)
  Write-Output ("signup err msg: " + $_.ErrorDetails.Message)
}
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
