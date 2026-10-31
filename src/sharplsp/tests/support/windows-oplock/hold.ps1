param([string]$Source)
$ErrorActionPreference='Stop'
$held=$null
try {
 # Windows PowerShell's CodeDom file compiler misresolves UNC source paths.
 $sourceCode=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'SourceOplock.cs'))
 Add-Type -TypeDefinition $sourceCode
 $held=[SourceOplock]::Acquire($Source)
 Write-Output '{"state":"ready"}'
 $held.WaitForReader()
 Write-Output '{"state":"blocked"}'
 $null=[Console]::In.ReadLine()
 $held.Dispose()
 $held=$null
 Write-Output '{"state":"released"}'
} finally { if ($null -ne $held) { $held.Dispose() } }
