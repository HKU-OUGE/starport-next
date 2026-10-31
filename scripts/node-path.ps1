function Get-StarportNode {
  param([string]$Repo)
  $Candidates = @()
  $Existing = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($Existing) { $Candidates += $Existing.Source }
  if ($env:ProgramFiles) { $Candidates += (Join-Path $env:ProgramFiles 'nodejs/node.exe') }
  $Candidates += (Join-Path $Repo 'private/runtime/node-v22.23.1-win-x64/node.exe')
  $Candidates += (Join-Path $Repo 'private/runtime/node-v22.23.1-win-arm64/node.exe')
  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate) {
      & $Candidate -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)'
      if ($LASTEXITCODE -eq 0) { return $Candidate }
    }
  }
  return $null
}
