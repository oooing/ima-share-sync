$ErrorActionPreference = 'Stop'
$ImaSpeedSyncSkipMain = $true
$sourcePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\sync.ps1'
$source = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8)
. ([scriptblock]::Create($source))
# Everything below is synthetic. Never open IMA, inspect Chromium cache or use
# HttpWebRequest with a valid URL. Tests do not create/download any PDF files.
$script:Checks = 0
function Check($Expected, $Actual, [string]$Name) {
    $script:Checks++
    if ($Expected -cne $Actual) { throw "$Name : expected <$Expected>, got <$Actual>" }
}
function Check-Throws([scriptblock]$Action, [string]$Name) {
    $script:Checks++
    try { & $Action | Out-Null } catch { return }
    throw "$Name : expected a failure"
}
function New-Window([string]$Name, [int]$Handle, [int]$Process=321) {
    $window = [pscustomobject]@{ Current=[pscustomobject]@{
        Name=$Name; NativeWindowHandle=$Handle; ProcessId=$Process
    }; RuntimeSuffix=99 }
    $window | Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value {
        return @([int]$this.Current.NativeWindowHandle, [int]$this.RuntimeSuffix)
    }
    return $window
}
& {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $actualWindowRoots=${function:Get-ImaWindowRoots}
    function Get-Process {param($Name,$ErrorAction) if($Name -cne 'ima.copilot'){throw 'unexpected process query'};return @([pscustomobject]@{Id=321})}
    function Get-ImaNativeWindowHandles {param($ProcessIds) Check '321' ($ProcessIds -join ',') 'native enumeration restricted to IMA PIDs';return @(1,2,3,4)}
    $script:ResolvedHandles=@()
    function Get-ImaWindowElement {param($Handle)
        $script:ResolvedHandles += [int]$Handle
        if([int]$Handle -eq 4){throw [Windows.Automation.ElementNotAvailableException]::new('destroyed')}
        if([int]$Handle -eq 3){return New-Window 'not IMA after HWND reuse' 3 999}
        return New-Window '' ([int]$Handle) 321
    }
    $actual=@(& $actualWindowRoots)
    Check '1,2' (($actual|ForEach-Object{$_.Current.NativeWindowHandle})-join',') 'preserve untitled and hidden IMA windows; reject changed PID and destroyed HWND'
    Check '1,2,3,4' ($script:ResolvedHandles-join',') 'only filtered handles enter UIA'
    Check $false ($actualWindowRoots.ToString().Contains('RootElement')) 'reader enumeration never enters other desktop providers'
    function Get-Process {param($Name,$ErrorAction) return @()}
    function Get-ImaNativeWindowHandles {throw 'no IMA must not enumerate desktop'}
    Check 0 @(& $actualWindowRoots).Count 'no IMA returns without native enumeration'
}
function Get-ImaRoot { throw 'OFFLINE: desktop access forbidden' }
function Get-ImaWindowRoots { return @($script:Windows) }
function Write-SyncLog {}
function Start-ImaCancelableSleep {}
function Test-ImaCancellation {
    if ($script:Canceled) { throw [OperationCanceledException]::new('cancelled') }
}
$script:Canceled=$false
$script:Windows=@()
Check 'Q4report2026.pdf' (Get-ImaNormalizedTitleKey 'Q4report2026.pdf') 'preserve full title'
Check 'a;b.pdf' (Get-ImaNormalizedTitleKey 'a;b.pdf') 'do not truncate semicolon'
Check 'a+b.pdf' (Get-ImaNormalizedTitleKey 'a+b.pdf') 'literal plus is not a space'
Check 'a.b.pdf' (Get-ImaNormalizedTitleKey 'a.b.pdf') 'preserve extension and dots'
Check 'a b.pdf' (Get-ImaNormalizedTitleKey "a$([char]160)b.pdf") 'NBSP may normalize'
Check 'a b.pdf' (Get-ImaNormalizedTitleKey "a & b.pdf") 'ampersand with spaces normalizes to single space'
Check 'a b.pdf' (Get-ImaNormalizedTitleKey "a&b.pdf") 'ampersand without spaces normalizes to single space'
$script:Windows=@((New-Window 'Q4report.pdf' 2))
Check 'Absent' (Get-ImaOriginalWindowPresence 'Q4report2026.pdf').State 'substring title is not identity'
Check $null (Get-ImaInterceptedFileUrl 'Q4report.pdf') 'legacy cache path is disabled'
Check $false ($source.Contains('Cache_Data\data_1')) 'no cache index reads remain'
Check $false ($source.Contains('Tabs_*')) 'no historic session reads remain'

$main=New-Window 'IMA' 1
$reader=New-Window 'Q4report2026.pdf' 2
$other=New-Window 'User document.pdf' 9
$before=@{'1'='old'}
$owned=Select-ImaOwnedOriginalWindow @($main,$reader,$other) $before 'Q4report2026.pdf'
Check 2 $owned.Window.Current.NativeWindowHandle 'choose only exact new reader'
Check $null (Select-ImaOwnedOriginalWindow @($main,$other) $before 'Q4report2026.pdf') 'do not choose unrelated new reader'
Check $null (Select-ImaOwnedOriginalWindow @($reader) @{'2'='old'} 'Q4report2026.pdf') 'preexisting matching handle is not ours'
Check-Throws { Select-ImaOwnedOriginalWindow @($reader,(New-Window 'Q4report2026.pdf' 3)) $before 'Q4report2026.pdf' } 'ambiguous exact new readers rejected'
Check $true (Test-ImaOwnedWindow $owned) 'frozen window identity accepted'
$reader.RuntimeSuffix=100
Check $false (Test-ImaOwnedWindow $owned) 'reused handle rejected by runtime identity'
$reader.RuntimeSuffix=99
$reader.Current.Name='Another.pdf'
Check $false (Test-ImaOwnedWindow $owned) 'window content/title switched'
$reader.Current.Name='Q4report2026.pdf'

Check $true (Test-ImaTrustedDownloadUri ([uri]'https://ima.qq.com/file?x=1')) 'trusted HTTPS service'
Check $true (Test-ImaTrustedDownloadUri ([uri]'https://files.ima.qq.com/file')) 'trusted service subdomain'
Check $true (Test-ImaTrustedDownloadUri ([uri]'https://example-123.cos.ap-shanghai.myqcloud.com/file')) 'Tencent COS origin'
foreach ($bad in @('http://ima.qq.com/file','https://127.0.0.1/file','https://ima.qq.com.evil.test/file',
    'https://ima.qq.com:444/file','https://user:password@ima.qq.com/file','file:///c:/secret',
    'https://ima.qq.com/file#fragment','https://arbitrary.test/file')) {
    Check $false (Test-ImaTrustedDownloadUri ([uri]$bad)) "reject $bad"
}
Check-Throws { Invoke-ImaDirectDownloadOriginal 'http://ima.qq.com/file' (Join-Path $PSScriptRoot 'never-created.pdf') '.pdf' } 'untrusted URL fails before network/file creation'
Check $false ([IO.File]::Exists((Join-Path $PSScriptRoot 'never-created.pdf'))) 'invalid URL creates no output'
Check $true ($source.Contains('$req.AllowAutoRedirect = $false')) 'redirect following disabled'
Check $true ($source.Contains('$totalBytes -ne $resp.ContentLength')) 'reject transport truncation'
Check-Throws { ConvertFrom-ImaUrlQuery ([uri]'https://ima.qq.com/?originUrl=a&originUrl=b') } 'duplicate query parameters rejected'

function Get-ImaReaderDocumentUrls { param($Reader) return @($script:ReaderUrls) }
$correct='https://ima.qq.com/file?media_title=Q4report2026.pdf&id=current'
$wrong='https://ima.qq.com/file?media_title=Q4report.pdf&id=wrong'
$script:ReaderUrls=@('chrome-extension://elhgpcianbbmeilccnddimfddkgegeee/index.html?originUrl='+[uri]::EscapeDataString($wrong))
Check $null (Get-ImaReaderFileUrl $owned 'Q4report2026.pdf') 'wrong title in current URL rejected'
$script:ReaderUrls=@('chrome-extension://elhgpcianbbmeilccnddimfddkgegeee/index.html?originUrl='+[uri]::EscapeDataString($correct))
Check $correct (Get-ImaReaderFileUrl $owned 'Q4report2026.pdf') 'current reader bound URL accepted'
$script:ReaderUrls=@($correct,$correct)
Check $correct (Get-ImaReaderFileUrl $owned 'Q4report2026.pdf') 'same URL exposed twice deduplicated'
$script:ReaderUrls=@($correct,'https://ima.qq.com/file?media_title=Q4report2026.pdf&id=other')
Check-Throws { Get-ImaReaderFileUrl $owned 'Q4report2026.pdf' } 'multiple current resource URLs rejected'
$script:ReaderUrls=@()
Check $null (Get-ImaReaderFileUrl $owned 'Q4report2026.pdf') 'missing UIA URL never falls back to historical cache'
$script:ReaderUrls=@('https://ima.qq.com/file?media_title=Q4report2026.pdf&media_title=Q4report2026.pdf')
Check $null (Get-ImaReaderFileUrl $owned 'Q4report2026.pdf') 'ambiguous title parameters rejected'

$script:OwnerMap=@{20=2;21=9;22=20}
function Get-ImaNativeOwnerHandle { param($Handle)
    if ($script:OwnerMap.ContainsKey([int]$Handle)) { return [IntPtr]$script:OwnerMap[[int]$Handle] }
    return [IntPtr]::Zero
}
$dialog=New-Window 'Save As' 20
$unrelatedDialog=New-Window 'Save As' 21
Check $true (Test-ImaSaveDialogOwner $dialog $reader) 'reader owns save dialog'
Check $true (Test-ImaSaveDialogOwner (New-Window 'Save As' 22) $reader) 'bounded transitive owner accepted'
Check $false (Test-ImaSaveDialogOwner $unrelatedDialog $reader) 'same PID does not establish ownership'
Check $false (Test-ImaSaveDialogOwner (New-Window 'Save As' 20 999) $reader) 'different PID rejected'
Check 20 (Select-ImaOwnedSaveDialog @($unrelatedDialog,$dialog) @{} $reader).Window.Current.NativeWindowHandle 'only owned save dialog selected'
Check $null (Select-ImaOwnedSaveDialog @($dialog) @{'20'=$true} $reader) 'preexisting dialog never selected'
$script:OwnerMap[23]=2
Check-Throws { Select-ImaOwnedSaveDialog @($dialog,(New-Window 'Save As' 23)) @{} $reader } 'multiple owned dialogs fail closed'

$script:Closed=@()
function Close-ImaOriginalWindow { param($Window)
    $script:Closed += [int]$Window.Current.NativeWindowHandle
    $script:Windows=@($script:Windows | Where-Object { $_.Current.NativeWindowHandle -ne $Window.Current.NativeWindowHandle })
}
function Get-ImaOriginalDownloadControl { param($Reader)
    if (-not $script:ExportAllowed) { throw 'export is unavailable' }
    return 'synthetic download button'
}
function Invoke-ImaOwnedDownload { param($Owned)
    $script:UiDownloads++
    throw 'OFFLINE: native download not executed'
}
function Invoke-ImaArticleRecord { param($Record)
    $script:OpenCalls++
    $script:Windows=@($main,$reader,$other)
}
function Invoke-ImaDirectDownloadOriginal { param($Url,$TargetPath,$ExpectedExtension)
    $script:Downloads++
    if ($script:CancelDownload) { throw [OperationCanceledException]::new('cancelled while downloading') }
    # No actual network or file IO.
}
function Reset-TestState {
    $script:Canceled=$false; $script:CancelDownload=$false; $script:ExportAllowed=$true
    $script:Downloads=0; $script:UiDownloads=0; $script:OpenCalls=0; $script:Closed=@()
    $script:PreserveImaWindows=$false; $script:Windows=@($main)
    $script:ReaderUrls=@($correct); $script:DownloadDirectory=$PSScriptRoot
}
$record=[pscustomobject]@{Name='Q4report2026.pdf';Kind='pdf';SourceId='knowledge-pdf_do_not_guess_a_media_id'}
Reset-TestState
$script:Windows=@($main,$other)
Check-Throws { Save-ImaOriginalFile $record } 'preexisting user PDF blocks safely'
Check 0 $script:OpenCalls 'do not open while user reader exists'
Check 0 $script:Closed.Count 'do not close preexisting reader'
Check $true $script:PreserveImaWindows 'enclosing sync must preserve user app'
Reset-TestState
$result=Save-ImaOriginalFile $record
Check $true ($result -match '^downloads/file-[0-9a-f]{32}\.pdf$') 'success returns only relative path'
Check 1 $script:OpenCalls 'open once'
Check 1 $script:Downloads 'one current bound download'
Check 0 $script:UiDownloads 'no redundant UI download'
Check '2' ($script:Closed -join ',') 'close only owned target, not parallel user window'
Check $true $script:PreserveImaWindows 'preserve unrelated parallel window at end'
Reset-TestState
$script:ExportAllowed=$false
Check-Throws { Save-ImaOriginalFile $record } 'viewer URL cannot override unavailable export'
Check 0 $script:Downloads 'no direct download without export'
Check '2' ($script:Closed -join ',') 'failure cleanup still only owned target'
Reset-TestState
$script:CancelDownload=$true
Check-Throws { Save-ImaOriginalFile $record } 'cancel propagates'
Check 1 $script:Downloads 'attempt occurs once'
Check 0 $script:UiDownloads 'cancel does not fall back to UI'
Check '2' ($script:Closed -join ',') 'cancel cleanup does not touch unrelated window'
Reset-TestState
$script:Canceled=$true
Check-Throws { Save-ImaOriginalFile $record } 'cancel before opening'
Check 0 $script:OpenCalls 'cancel before opening makes no UI calls'
Check 0 $script:Closed.Count 'cancel before opening closes nothing'
$script:AppCloseCalls=0
function Close-ImaApplication { $script:AppCloseCalls++ }
$script:PreserveImaWindows=$true
Close-ImaApplicationAfterSync
Check 0 $script:AppCloseCalls 'top-level cleanup preserves user readers'
$script:PreserveImaWindows=$false
Close-ImaApplicationAfterSync
Check 1 $script:AppCloseCalls 'normal sync retains requested app-close behavior'
& {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $shared=New-Window 'Q4report2026.pdf' 88
    $beforeShared=@{'88'=(Get-ImaOwnedWindowIdentity $shared)}
    $sourceId='knowledge-pdf_fixture_media_identity'
    $script:ReaderUrls=@('https://ima.qq.com/file?media_title=Q4report2026.pdf&media_id=pdf_fixture_media_identity')
    $script:ClosedTabs=0;$script:Closed=@()
    $invoke=[pscustomobject]@{};$invoke|Add-Member ScriptMethod Invoke {$script:ClosedTabs++}
    $button=[pscustomobject]@{Pattern=$invoke};$button|Add-Member ScriptMethod TryGetCurrentPattern {param($kind,$output) $output.Value=$this.Pattern;return $true}
    $tabElement=[pscustomobject]@{Close=$button};$tabElement|Add-Member ScriptMethod FindAll {param($scope,$condition) return @($this.Close)}
    $newTab=[pscustomobject]@{Id='new-tab';Title='Q4report2026.pdf';Selected=$true;Element=$tabElement}
    $oldTab=[pscustomobject]@{Id='old-note-tab';Title='Untitled note';Selected=$false;Element=$null}
    $script:ReaderTabs=@($oldTab,$newTab)
    function Get-ImaReaderTabs {param($Window) return $script:ReaderTabs}
    $oldTabs=@{'88'=@('old-note-tab')}
    $claimed=Select-ImaOwnedOriginalWindow @($shared) $beforeShared 'Q4report2026.pdf' $oldTabs $sourceId
    Check 'new-tab' $claimed.TabId 'same native window may host a verified new selected file tab'
    Check $true (Test-ImaOwnedWindow $claimed) 'tab ownership also verifies current media ID'
    Check $null (Select-ImaOwnedOriginalWindow @($shared) $beforeShared 'Q4report2026.pdf' @{'88'=@('old-note-tab','new-tab')} $sourceId) 'preexisting same title and media tab cannot be claimed'
    $newTab.Selected=$false
    Check $null (Select-ImaOwnedOriginalWindow @($shared) $beforeShared 'Q4report2026.pdf' $oldTabs $sourceId) 'background tab cannot be claimed'
    Check $false (Test-ImaOwnedWindow $claimed) 'switching away invalidates existing tab claim'
    Close-ImaOwnedOriginalWindow $claimed
    Check 0 $script:ClosedTabs 'inactive owned tab is not touched'
    $newTab.Selected=$true
    $script:ReaderUrls=@('https://ima.qq.com/file?media_title=Q4report2026.pdf&media_id=pdf_different_identity')
    Check $null (Select-ImaOwnedOriginalWindow @($shared) $beforeShared 'Q4report2026.pdf' $oldTabs $sourceId) 'matching title with wrong source ID is refused'
    Check $false (Test-ImaOwnedWindow $claimed) 'media ID change invalidates owned tab'
    $script:ReaderUrls=@('https://ima.qq.com/file?media_title=Q4report2026.pdf&media_id=pdf_fixture_media_identity')
    $script:ReaderTabs+= [pscustomobject]@{Id='another-new-tab';Title='Q4report2026.pdf';Selected=$false;Element=$null}
    Check-Throws {Select-ImaOwnedOriginalWindow @($shared) $beforeShared 'Q4report2026.pdf' $oldTabs $sourceId} 'multiple new matching tabs are ambiguous'
    $script:ReaderTabs=@($oldTab,$newTab)
    Close-ImaOwnedOriginalWindow $claimed
    Check 1 $script:ClosedTabs 'cleanup invokes only the owned tab close button'
    Check 0 $script:Closed.Count 'cleanup keeps preexisting note and native window'
    Check $true $script:PreserveImaWindows 'reused window is preserved by top-level cleanup'
    $existing=Select-ImaOwnedOriginalWindow @($shared) $beforeShared 'Q4report2026.pdf' @{'88'=@('old-note-tab','new-tab')} $sourceId -AllowExisting
    Check $true $existing.KeepOpen 'verified preexisting selected media may be used but is never owned for cleanup'
    Close-ImaOwnedOriginalWindow $existing
    Check 1 $script:ClosedTabs 'existing verified tab remains open'
    $newTab.Selected=$false
    Check $null (Select-ImaOwnedOriginalWindow @($shared) $beforeShared 'Q4report2026.pdf' @{'88'=@('old-note-tab','new-tab')} $sourceId -AllowExisting) 'existing background tab cannot be read before selection'
    $newTab.Selected=$true
    Check $true (Select-ImaOwnedOriginalWindow @($shared) $beforeShared 'Q4report2026.pdf' @{'88'=@('old-note-tab','new-tab')} $sourceId -AllowExisting).KeepOpen 'existing tab selected by exact-card open is reusable without closure'
    Reset-TestState
    $script:Windows=@($shared);$script:ReaderUrls=@('https://ima.qq.com/file?media_title=Q4report2026.pdf&media_id=pdf_fixture_media_identity')
    $reuseRecord=[pscustomobject]@{Name='Q4report2026.pdf';Kind='pdf';SourceId=$sourceId}
    [void](Save-ImaOriginalFile $reuseRecord)
    Check 1 $script:Downloads 'same-source existing selected reader downloads once'
    Check 0 $script:OpenCalls 'existing verified reader needs no repeated card open'
    Check 0 $script:Closed.Count 'reuse never closes existing native window'
    Check 1 $script:ClosedTabs 'reuse never closes existing file or note tab'
}
Reset-TestState
$script:Windows=@($main,$reader)
Check-Throws {Save-ImaOriginalFile $record} 'existing matching file reader is preserved, not auto-closed'
Check 0 $script:Closed.Count 'same-title preflight closes no existing window'
Check 0 $script:OpenCalls 'same-title preflight opens no new tab'
Write-Output "$script:Checks original-file safety checks passed (offline, no desktop/network/cache access)."
