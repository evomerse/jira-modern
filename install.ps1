# Installe Team-IT CDS en local : dépendances, build, raccourci bureau, démarrage automatique (optionnel).
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

Write-Host "== Team-IT CDS : installation ==" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js est requis (version 20 ou plus). Installe-le depuis https://nodejs.org puis relance ce script." -ForegroundColor Red
  exit 1
}
Write-Host ("Node.js " + (node -v))

Write-Host "Installation des dépendances..." -ForegroundColor Cyan
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install a échoué" }

Write-Host "Construction de l'application..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build a échoué" }

# Raccourci bureau : lance le serveur en arrière-plan puis ouvre la fenêtre application.
$launcher = Join-Path $root 'launch.ps1'
$wsh = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = $wsh.CreateShortcut((Join-Path $desktop 'Team-IT CDS.lnk'))
$lnk.TargetPath = 'powershell.exe'
$lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`""
$lnk.WorkingDirectory = $root
$lnk.Description = 'Team-IT CDS'
$lnk.Save()
Write-Host "Raccourci créé sur le bureau : Team-IT CDS" -ForegroundColor Green

$ans = Read-Host "Démarrer automatiquement à l'ouverture de session Windows ? (o/N)"
if ($ans -match '^[oOyY]') {
  $startup = [Environment]::GetFolderPath('Startup')
  $auto = $wsh.CreateShortcut((Join-Path $startup 'Team-IT CDS.lnk'))
  $auto.TargetPath = 'powershell.exe'
  $auto.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -Background"
  $auto.WorkingDirectory = $root
  $auto.Save()
  Write-Host "Démarrage automatique activé (le serveur démarre sans ouvrir de fenêtre)." -ForegroundColor Green
}

Write-Host ""
Write-Host "Terminé. Lance « Team-IT CDS » depuis le bureau." -ForegroundColor Cyan
Write-Host "Assistant : installe Claude Code puis lance 'claude' une fois pour te connecter (voir Paramètres)."
