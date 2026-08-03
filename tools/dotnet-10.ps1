[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Uninstall')]
    [string] $Action
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw 'Unable to resolve the current user LocalApplicationData directory.'
}

$installRoot = [IO.Path]::GetFullPath((Join-Path $localAppData 'Microsoft\dotnet'))
$localRoot = [IO.Path]::GetFullPath($localAppData).TrimEnd([IO.Path]::DirectorySeparatorChar)
$requiredPrefix = $localRoot + [IO.Path]::DirectorySeparatorChar
if (-not $installRoot.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to manage a .NET directory outside LocalApplicationData: $installRoot"
}

function Update-UserPath {
    param([bool] $Add)

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $segments = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $normalizedInstallRoot = $installRoot.Trim().Trim('"').TrimEnd([IO.Path]::DirectorySeparatorChar)
    $withoutInstallRoot = @(
        $segments | Where-Object {
            -not $_.Trim().Trim('"').TrimEnd([IO.Path]::DirectorySeparatorChar).Equals(
                $normalizedInstallRoot,
                [StringComparison]::OrdinalIgnoreCase
            )
        }
    )

    if ($Add) {
        $withoutInstallRoot += $installRoot
    }

    [Environment]::SetEnvironmentVariable('Path', ($withoutInstallRoot -join ';'), 'User')
}

function Install-DotNet10 {
    $cacheRoot = Join-Path $localAppData 'SharpLsp\dotnet-install'
    $installer = Join-Path $cacheRoot 'dotnet-install.ps1'
    New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null

    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        Write-Host '==> Downloading the official dotnet-install.ps1...'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installer
    }

    & $installer -Channel '10.0' -InstallDir $installRoot

    $dotnet = Join-Path $installRoot 'dotnet.exe'
    if (-not (Test-Path -LiteralPath $dotnet -PathType Leaf)) {
        throw "The installer completed without creating $dotnet"
    }

    Update-UserPath -Add $true
    $env:Path = "$installRoot;$env:Path"
    Write-Host "==> .NET 10 installed at $installRoot"
    & $dotnet --list-sdks
    & $dotnet --list-runtimes
}

function Assert-ManagedChild {
    param(
        [Parameter(Mandatory = $true)] [string] $Parent,
        [Parameter(Mandatory = $true)] [string] $Child
    )

    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $childPath = [IO.Path]::GetFullPath($Child)
    $prefix = $parentPath + [IO.Path]::DirectorySeparatorChar
    if (-not $childPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside $parentPath`: $childPath"
    }
    return $childPath
}

function Remove-VersionDirectories {
    param([Parameter(Mandatory = $true)] [string] $Parent)

    if (-not (Test-Path -LiteralPath $Parent -PathType Container)) {
        return
    }

    foreach ($directory in Get-ChildItem -LiteralPath $Parent -Directory) {
        if ($directory.Name -notmatch '^10\.') {
            continue
        }

        $target = Assert-ManagedChild -Parent $Parent -Child $directory.FullName
        Write-Host "  Removing $target"
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

function Uninstall-DotNet10 {
    if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) {
        Write-Host "==> No user-local .NET installation exists at $installRoot"
        Update-UserPath -Add $false
        return
    }

    foreach ($relativeParent in @('sdk', 'host\fxr', 'templates', 'sdk-manifests')) {
        Remove-VersionDirectories -Parent (Join-Path $installRoot $relativeParent)
    }

    foreach ($group in @('shared', 'packs')) {
        $groupPath = Join-Path $installRoot $group
        if (-not (Test-Path -LiteralPath $groupPath -PathType Container)) {
            continue
        }
        foreach ($component in Get-ChildItem -LiteralPath $groupPath -Directory) {
            Remove-VersionDirectories -Parent $component.FullName
        }
    }

    $remainingSdks = @(Get-ChildItem -LiteralPath (Join-Path $installRoot 'sdk') -Directory -ErrorAction SilentlyContinue)
    $remainingRuntimes = @(
        Get-ChildItem -LiteralPath (Join-Path $installRoot 'shared') -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue }
    )
    if ($remainingSdks.Count -eq 0 -and $remainingRuntimes.Count -eq 0) {
        Update-UserPath -Add $false
    }

    Write-Host '==> User-local .NET 10 SDK and runtime directories removed.'
    $dotnet = Join-Path $installRoot 'dotnet.exe'
    if (Test-Path -LiteralPath $dotnet -PathType Leaf) {
        & $dotnet --list-sdks
        & $dotnet --list-runtimes
    }
}

if ($Action -eq 'Install') {
    Install-DotNet10
} else {
    Uninstall-DotNet10
}
