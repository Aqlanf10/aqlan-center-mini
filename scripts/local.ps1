param([Parameter(ValueFromRemainingArguments = $true)][string[]]$NpmArguments = @('run', 'dev'))

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

# Prefer an explicit runtime, then the workspace runtime, then an installed Node 22.
$workspaceNode = Join-Path (Split-Path -Parent (Get-Location).Path) 'runtime\node_modules\node\bin\node.exe'
$installedNode = Get-Command node -ErrorAction SilentlyContinue
$nodeCandidates = @($env:AQLAN_NODE_BINARY, $workspaceNode, $installedNode.Source) | Where-Object { $_ }
$selectedNode = $null
foreach ($nodeCandidate in $nodeCandidates) {
    if (-not (Test-Path -LiteralPath $nodeCandidate)) { continue }
    $nodeMajor = & $nodeCandidate -p 'process.versions.node.split(".")[0]'
    if ($LASTEXITCODE -eq 0 -and $nodeMajor -eq '22') { $selectedNode = $nodeCandidate; break }
}
if (-not $selectedNode) { throw 'Node 22 is required. Install it or set AQLAN_NODE_BINARY to its node.exe path.' }

$npmEntry = $env:npm_execpath
if (-not $npmEntry -or -not (Test-Path -LiteralPath $npmEntry)) {
    $installedNpm = Get-Command npm -ErrorAction Stop
    $npmEntry = Join-Path (Split-Path -Parent $installedNpm.Source) 'node_modules\npm\bin\npm-cli.js'
    $npmPrefixScript = Join-Path (Split-Path -Parent $npmEntry) 'npm-prefix.js'
    if (Test-Path -LiteralPath $npmPrefixScript) {
        $npmGlobalPrefix = & $selectedNode $npmPrefixScript
        if ($LASTEXITCODE -eq 0 -and $npmGlobalPrefix) {
            $npmGlobalEntry = Join-Path $npmGlobalPrefix.Trim() 'node_modules\npm\bin\npm-cli.js'
            if (Test-Path -LiteralPath $npmGlobalEntry) { $npmEntry = $npmGlobalEntry }
        }
    }
}
if (-not (Test-Path -LiteralPath $npmEntry)) { throw 'npm-cli.js was not found. Install npm first.' }

$env:PATH = (Split-Path -Parent $selectedNode) + [IO.Path]::PathSeparator + $env:PATH
$env:npm_execpath = $npmEntry
& $selectedNode $npmEntry @NpmArguments
exit $LASTEXITCODE
