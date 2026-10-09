$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
$ImaSpeedSyncSkipMain = $true
. ([ScriptBlock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot '../src/sync.ps1'))))
$script:checks = 0
function Check($Condition, $Label) {
    if (-not $Condition) { throw "FAIL: $Label" }
    $script:checks++
}
# No real UI calls, log writes, or mouse/keyboard input in this suite.
function Write-SyncLog { param($Text) }
function Write-ImaProgress { param($Text) }
function Test-ImaCancellation { }
function Start-ImaCancelableSleep { param($Milliseconds) Start-Sleep -Milliseconds 10 }

$before = @([pscustomobject]@{ Name = 'brief-0920'; Y = 10 })
$moved = @([pscustomobject]@{ Name = 'brief-0920'; Y = 12 })
Check ((Get-ImaTitleReadinessSignature $before) -ceq (Get-ImaTitleReadinessSignature $moved)) 'layout jitter does not reset readiness'
Check ((Get-ImaTitleReadinessSignature $before) -cne (Get-ImaTitleReadinessSignature @([pscustomobject]@{Name='brief-0921'}))) 'changed title resets readiness'
Check ((Get-ImaTitleReadinessSignature @()) -ceq '') 'empty lists are not ready'
$idA = @([pscustomobject]@{ Name='same'; Key='id-A' })
$idB = @([pscustomobject]@{ Name='same'; Key='id-B' })
Check ((Get-ImaTitleReadinessSignature $idA) -cne (Get-ImaTitleReadinessSignature $idB)) 'general identities survive same names'

$script:recoveryCount = 0
$script:probes = 0
function Get-ImaTitleListState {
    $script:probes++
    if ($script:probes -eq 1) { throw [InvalidOperationException]::new('stale tree') }
    [pscustomobject]@{Root='fresh-root'; Signature=$(if ($script:recoveryCount) {'loaded'} else {''}); Reason='test'; Hidden=$false}
}
$root = Wait-ImaTitleListStable $null -TimeoutMilliseconds 2500 -RecoveryAfterMilliseconds 20 -Recover { $script:recoveryCount++ }
Check ($root -ceq 'fresh-root') 'reacquires a fresh root after transient failure and recovery'
Check ($script:recoveryCount -eq 1) 'recovery runs once'

$script:recoveryCount = 0
function Get-ImaTitleListState { [pscustomobject]@{Root=$null;Signature='';Reason='missing list';Hidden=$false} }
$message = ''
try { Wait-ImaTitleListStable $null -TimeoutMilliseconds 100 -RecoveryAfterMilliseconds 20 -Recover { $script:recoveryCount++ } } catch { $message = $_.Exception.Message }
Check ($message.Contains('missing list')) 'timeout records last observed reason'
Check ($script:recoveryCount -eq 1) 'persistent failures have bounded recovery'

$script:recoveryCount = 0
function Get-ImaTitleListState { [pscustomobject]@{Root=$null;Signature='';Reason='hidden window';Hidden=$true} }
$message = ''
try { Wait-ImaTitleListStable $null -TimeoutMilliseconds 500 -Recover { $script:recoveryCount++ } } catch { $message = $_.Exception.Message }
Check ($message -ceq 'hidden window') 'invisible window gets an actionable error'
Check ($script:recoveryCount -eq 0) 'hidden windows are not foregrounded or clicked'

$script:recoveryCount = 0
function Get-ImaTitleListState { [pscustomobject]@{Root=$null;Signature='';Reason='folder no longer exists';Hidden=$false;TerminalError=$true} }
$message = ''
try { Wait-ImaTitleListStable $null -TimeoutMilliseconds 500 -RecoveryAfterMilliseconds 0 -Recover { $script:recoveryCount++ } } catch { $message = $_.Exception.Message }
Check ($message -ceq 'folder no longer exists') 'source error is preserved instead of a timeout'
Check ($script:recoveryCount -eq 0) 'terminal source errors do not loop or change sources'

function Test-ImaCancellation { throw [OperationCanceledException]::new('canceled') }
$canceled = $false
try { Wait-ImaTitleListStable $null } catch [OperationCanceledException] { $canceled = $true }
Check $canceled 'cancellation propagates without retry'
Write-Output "PASS: $script:checks list readiness assertions"
