param([switch] $Json)

$ErrorActionPreference = 'Stop'
$pnpm = Get-Command -Name pnpm.cmd, pnpm.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $pnpm) { throw 'pnpm was not found. Install pnpm and add it to PATH.' }

Push-Location -LiteralPath (Join-Path $PSScriptRoot '..\..')
try {
    $doctorArgs = @('exec', 'devhub', 'doctor')
    if ($Json) { $doctorArgs += '--json' }
    & $pnpm.Source @doctorArgs
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
