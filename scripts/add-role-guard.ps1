$files = Get-ChildItem -Path WAMS\admin -Filter *.html | Where-Object { $_.Name -ne 'wams-admin-log-in.html' -and $_.Name -ne 'wams-admin-audit-logs.html' -and $_.Name -ne 'wams-admin-list.html' }
foreach ($f in $files) {
  $c = Get-Content $f.FullName -Raw
  if ($c -match 'wams-role-guard') { continue }
  $guard = @'
<script id="wams-role-guard">
/* Runs before paint: hides Super-Admin-only sidebar links for Co-Admins
   using the role cached at sign-in, then re-checks against /api/me. */
(function(){
  function hide(){
    var role = localStorage.getItem('adminRole');
    if (role === 'super_admin') return true;
    ['sbAdminList','sbAuditLogs'].forEach(function(id){
      var el = document.getElementById(id);
      if (el) el.remove();
    });
    return role === 'admin';
  }
  if (!hide()) {
    document.addEventListener('DOMContentLoaded', function(){
      var t = localStorage.getItem('adminToken');
      if (!t) return;
      fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + t } })
        .then(function(r){ return r.json(); })
        .then(function(me){
          if (me && me.role) {
            localStorage.setItem('adminRole', me.role);
            hide();
          }
        }).catch(function(){});
    });
  }
})();
</script>
'@
  # Insert right after <body>
  $c = $c -replace '(?i)(<body[^>]*>)', ("`$1`n" + $guard)
  Set-Content -Path $f.FullName -Value $c -NoNewline
  Write-Output ("guard added: " + $f.Name)
}
