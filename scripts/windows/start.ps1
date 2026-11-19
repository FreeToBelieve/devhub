$ErrorActionPreference = 'Stop'
$pnpm = Get-Command -Name pnpm.cmd, pnpm.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $pnpm) { throw 'pnpm was not found. Install pnpm and add it to PATH.' }

Push-Location -LiteralPath (Join-Path $PSScriptRoot '..\..')
try {
    & $pnpm.Source run start
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
