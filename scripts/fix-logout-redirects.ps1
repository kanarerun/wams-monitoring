$files = Get-ChildItem -Path WAMS -Recurse -Include *.js,*.html | Where-Object { $_.FullName -notmatch 'log-in' }
foreach ($f in $files) {
  $c = Get-Content $f.FullName -Raw
  $orig = $c
  $c = $c -replace [regex]::Escape('"wams-admin-log-in.html"'), '"/"'
  $c = $c -replace [regex]::Escape("'wams-admin-log-in.html'"), "'/'"
  $c = $c -replace [regex]::Escape('"wams-professor-log-in.html"'), '"/"'
  $c = $c -replace [regex]::Escape("'wams-professor-log-in.html'"), "'/'"
  $c = $c -replace [regex]::Escape('"wams-student-log-in.html"'), '"/"'
  $c = $c -replace [regex]::Escape("'wams-student-log-in.html'"), "'/'"
  if ($c -ne $orig) {
    Set-Content -Path $f.FullName -Value $c -NoNewline
    Write-Output ("updated: " + $f.Name)
  }
}
