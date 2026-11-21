$files = Get-ChildItem -Path WAMS\admin -Filter *.html | Where-Object { $_.Name -ne 'wams-admin-audit-logs.html' -and $_.Name -ne 'wams-admin-log-in.html' }
foreach ($f in $files) {
  $c = Get-Content $f.FullName -Raw
  if ($c -match 'sbAuditLogs') { continue }
  # Insert the Audit Logs link right after the Admin List link (if present)
  # or before the closing of the Account Management group.
  $adminListPattern = '(?s)(<a class="sb-item"[^>]*wams-admin-admin-list\.html[^>]*>.*?</a>\s*</div>)'
  if ($c -match $adminListPattern) {
    $link = @'
      <a class="sb-item" href="wams-admin-audit-logs.html" data-tip="Audit Logs" id="sbAuditLogs">
        <span class="sb-ico">
          <svg viewBox="0 0 24 24">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        </span>
        <span class="sb-txt">Audit Logs</span>
      </a>
    </div>
'@
    $c = $c -replace $adminListPattern, ("`$1`n" + $link)
    Set-Content -Path $f.FullName -Value $c -NoNewline
    Write-Output ("added audit link: " + $f.Name)
  } else {
    Write-Output ("SKIPPED (no admin-list anchor): " + $f.Name)
  }
}
