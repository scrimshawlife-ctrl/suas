param(
  [ValidateSet('veteran', 'responder', 'admin')]
  [string]$Role
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

if (-not (Test-Path '.env')) { throw 'LOCAL startup refused: .env is missing.' }
foreach ($line in Get-Content '.env') {
  if ($line -match '^\s*([^#=\s]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim("'\""), 'Process')
  }
}

if ($env:SUAS_ENV -ne 'LOCAL') { throw 'LOCAL startup refused: SUAS_ENV must be LOCAL.' }
if ($env:SUAS_ALLOW_REAL_EXTERNAL_EFFECTS -ne 'false') { throw 'LOCAL startup refused: real external effects must be false.' }
if ($env:DATABASE_URL -ne 'postgresql://suas:suas@localhost:5432/suas_local') { throw 'LOCAL startup refused: DATABASE_URL must target local suas_local.' }
if (($env:SUAS_HTTP_HOST ?? '127.0.0.1') -ne '127.0.0.1') { throw 'LOCAL startup refused: SUAS_HTTP_HOST must be 127.0.0.1.' }
if (($env:SUAS_HTTP_PORT ?? '3000') -ne '3000') { throw 'LOCAL startup refused: SUAS_HTTP_PORT must be 3000.' }

$Container = 'suas-postgres17-local'
docker container inspect $Container *> $null
if ($LASTEXITCODE -ne 0) { throw "LOCAL startup refused: Docker container $Container is missing." }
if ((docker inspect -f '{{.State.Status}}' $Container) -ne 'running') { docker start $Container *> $null }
for ($i = 0; $i -lt 60; $i++) {
  docker exec $Container pg_isready -U suas -d postgres *> $null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 1
}
docker exec $Container pg_isready -U suas -d postgres *> $null
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL 17 did not become ready.' }

New-Item -ItemType Directory -Force '.local-secrets' | Out-Null
$env:UMASK = '077'
npm run migrate -- apply
npm run migrate -- validate
& npm run seed *> '.local-secrets/seed-output.json'
if ($LASTEXITCODE -ne 0) { throw 'Synthetic seed failed.' }

if ([string]::IsNullOrWhiteSpace($Role)) {
  npm run dev
  exit $LASTEXITCODE
}

$server = Start-Process -FilePath 'npm' -ArgumentList 'run', 'dev' -WorkingDirectory $Root -RedirectStandardOutput '.local-secrets/server.stdout.log' -RedirectStandardError '.local-secrets/server.stderr.log' -PassThru
try {
  for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/v0/health' | Out-Null; break } catch { Start-Sleep -Seconds 1 }
  }
  node --env-file=.env --import tsx/esm scripts/local-demo-browser.ts $Role
} finally {
  if (-not $server.HasExited) { Stop-Process -Id $server.Id }
}
