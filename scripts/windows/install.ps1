$ErrorActionPreference = 'Stop'
$pnpm = Get-Command -Name pnpm.cmd, pnpm.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $pnpm) { throw 'pnpm was not found. Install pnpm and add it to PATH.' }

Push-Location -LiteralPath (Join-Path $PSScriptRoot '..\..')
try {
    & node.exe scripts/check-runtime.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $pnpm.Source install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $pnpm.Source run build
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
