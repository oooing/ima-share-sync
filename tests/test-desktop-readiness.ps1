$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\src\sync.ps1'), [Text.Encoding]::UTF8)
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'PowerShell source did not parse' }
$entry = $ast.EndBlock.Statements[-1].Extent.StartOffset
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$sandbox = Join-Path $tempRoot ('ima-desktop-contract-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($sandbox)
try {
    # The entry path runs with an unavailable desktop. Any IMA access fails the test.
    $overrides = @'
function Test-ImaWorkstationLocked { return $true }
function Invoke-ImaSync { throw 'TEST: IMA must never run while desktop is unavailable' }
function Close-ImaApplicationAfterSync { throw 'TEST: IMA must not be closed by preflight' }
function Write-SyncLog { param($Text) }

'@
    $scriptPath = Join-Path $sandbox 'blocked.ps1'
    [IO.File]::WriteAllText($scriptPath, $source.Insert($entry,$overrides), (New-Object Text.UTF8Encoding($true)))
    $output = Join-Path $sandbox 'result.json'
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -OutputPath $output | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Blocked entry failed' }
    $blocked = [IO.File]::ReadAllText($output) | ConvertFrom-Json
    if ($blocked.locked -ne $true -or $blocked.items.Count -ne 0 -or $blocked.errors.Count -ne 0) { throw 'Blocked desktop did not defer cleanly' }
    $probeOutput = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -CheckDesktop -InputPath 'THIS_FILE_MUST_NOT_BE_READ'
    if ($LASTEXITCODE -ne 0) { throw 'Read-only probe failed' }
    $probe = $probeOutput | ConvertFrom-Json
    if ($probe.desktopReady -ne $false) { throw 'Blocked desktop reported ready' }

    # Initialization failure must also block the real wrapper, rather than permit UIA.
    $ImaSpeedSyncSkipMain = $true
    . ([scriptblock]::Create($source)) -CheckDesktop
    function Initialize-ImaNativeMethods { throw 'Simulated native initialization failure' }
    if (-not (Test-ImaWorkstationLocked)) { throw 'Native status failure allowed automation' }
    Write-Output 'PASS: locked entry, read-only probe, no IMA access, no input loading, native failure blocks automation'
} finally {
    $resolved = [IO.Path]::GetFullPath($sandbox)
    if (-not $resolved.StartsWith((Join-Path $tempRoot 'ima-desktop-contract-'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
