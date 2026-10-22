$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$envFile = Join-Path $repo '.env.local'
if (-not (Test-Path $envFile)) {
  Write-Error "Missing $envFile. Create it using DEPLOYMENT.md and keep its secrets private."
}
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
  }
}
if (-not $env:MINI_COMPUTER_CLOUD_AGENT_URL -or -not $env:MINI_COMPUTER_AGENT_TOKEN) {
  Write-Error 'MINI_COMPUTER_CLOUD_AGENT_URL and MINI_COMPUTER_AGENT_TOKEN are required.'
}
Set-Location $repo
npm run agent
