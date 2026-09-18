$ErrorActionPreference = 'Stop'
$ImaSpeedSyncSkipMain = $true
$sourcePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\sync.ps1'
$source = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8)
. ([scriptblock]::Create($source))
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Write-SyncLog {}
$script:Checks = 0
function Check($Expected, $Actual, [string]$Name) {
    $script:Checks++
    if ($Expected -cne $Actual) { throw "$Name : expected <$Expected>, got <$Actual>" }
}
function Check-Throws([scriptblock]$Action, [string]$Name) {
    $script:Checks++
    try { & $Action } catch { return }
    throw "$Name : expected a failure"
}

$script:TitleFilterMode = 'all'
Check $true (Test-ImaGeneralTitle '会议纪要') 'arbitrary Chinese title'
Check $true (Test-ImaGeneralTitle 'Learning notes (draft)') 'arbitrary English title'
Check $false (Test-ImaGeneralTitle ' ') 'empty card title'
$script:TitleFilterMode = 'contains'; $script:TitleFilter = 'meeting'
Check $true (Test-ImaGeneralTitle 'Weekly MEETING notes') 'literal case-insensitive keyword'
Check $false (Test-ImaGeneralTitle 'ordinary notes') 'nonmatching keyword'
$script:TitleFilterMode = 'prefix'; $script:TitleFilter = '[Notes]'
Check $true (Test-ImaGeneralTitle '[Notes] literal brackets') 'prefix is not regex'
Check $false (Test-ImaGeneralTitle 'N literal brackets') 'prefix does not interpret character classes'
$script:TitleFilterMode = 'regex'; $script:TitleRegex = [regex]::new('^notes-\d+$')
Check $true (Test-ImaGeneralTitle 'notes-123') 'advanced regex'
Check $false (Test-ImaGeneralTitle 'notes-draft') 'regex rejects nonmatching title'
$script:TitleFilterMode = 'all'

Check 'knowledge-note_abcdefghijklmnop' (Get-ImaCardIdentity 'knowledge-note_abcdefghijklmnop').SourceId 'opaque article identity'
Check '' (Get-ImaCardIdentity 'knowledge-note_123').SourceId 'row number is not a persistent identity'
Check '' (Get-ImaCardIdentity 'knowledge-note_1234567890123456').SourceId 'long numeric row ID is not trusted'
Check 'pdf' (Get-ImaCardIdentity 'knowledge-pdf_abcdefghijklmnop').Kind 'unsupported file classification'
Check $null (Get-ImaCardIdentity 'sidebar-folder-123') 'folder is not an article'
Check 0 (Get-ImaCardTitleIndex @('普通标题', '笔记', '06:58更新') 'note') 'plain card title'
Check 1 (Get-ImaCardTitleIndex @('很长的缩略图摘要', '真正的标题', '笔记', '9/7更新') 'note') 'preview is not the title'
Check 1 (Get-ImaCardTitleIndex @('关键词出现在摘要', '不匹配的标题', '笔记', '昨天更新') 'note') 'filter does not promote a matching preview'
Check-Throws { Get-ImaCardTitleIndex @('不明结构', '笔记') 'note' } 'unknown card shape is not guessed'

Check "前文`n`n---`n`n后文" (Convert-ImaGeneralDecorations '前文后文' @([pscustomobject]@{Start=2;Length=0;Markdown="`n`n---`n`n"})) 'structural separator is restored'
Check '[链接](<https://example.test/?x=1&y=2>) text' (Convert-ImaGeneralDecorations '链接 text' @([pscustomobject]@{Start=0;Length=2;Markdown='[链接](<https://example.test/?x=1&y=2>)'})) 'named hyperlink replacement preserves query'
Check 'AB--CD[网址](<https://example.test/>)' (Convert-ImaGeneralDecorations 'ABCD网址' @(
    [pscustomobject]@{Start=2;Length=0;Markdown='--'},
    [pscustomobject]@{Start=4;Length=2;Markdown='[网址](<https://example.test/>)'})) 'right-to-left replacements preserve source offsets'
Check-Throws { Convert-ImaGeneralDecorations 'text' @([pscustomobject]@{Start=5;Length=0;Markdown='x'}) } 'invalid structure offset rejected'
Check-Throws { Convert-ImaGeneralDecorations 'abcd' @([pscustomobject]@{Start=1;Length=2;Markdown='x'},[pscustomobject]@{Start=2;Length=1;Markdown='y'}) } 'overlapping structure ranges rejected'
Check 'End' ([Windows.Automation.Text.TextPatternRangeEndpoint]::End.ToString()) 'UIA range endpoint enum exists on PowerShell 5.1'
& {
    $separator = [pscustomobject]@{Current=[pscustomobject]@{ControlType=[Windows.Automation.ControlType]::Separator}}
    $range = [pscustomobject]@{}
    $range | Add-Member ScriptMethod GetText { param($Length) return '' }
    $prefix = [pscustomobject]@{}
    $prefix | Add-Member ScriptMethod GetText { param($Length) return '前文' }
    $prefix | Add-Member ScriptMethod MoveEndpointByRange { param($End, $Range, $Start) }
    $bodyRange = [pscustomobject]@{Prefix=$prefix}
    $bodyRange | Add-Member ScriptMethod Clone { return $this.Prefix }
    $body = [pscustomobject]@{Separator=$separator}
    $body | Add-Member ScriptMethod FindAll { param($Scope,$Condition) return @($this.Separator) }
    $pattern = [pscustomobject]@{Range=$range}
    $pattern | Add-Member ScriptMethod RangeFromChild { param($Element) return $this.Range }
    $binding = [pscustomobject]@{Body=$body;TextPattern=$pattern}
    Check "前文`n`n---`n`n后文" (Get-ImaGeneralMarkdown $binding $bodyRange '前文后文') 'separator uses real UIA enum and range adapter'
}

Check $null (Get-ImaOptionalUpdatedDate '没有日期的短笔记') 'optional missing date'
Check $null (Get-ImaOptionalUpdatedDate '更新时间：2026-02-31') 'invalid date is not fabricated'
Check '2026-09-07' (Get-ImaOptionalUpdatedDate "更新时间：2026.09.07 09:30`n正文") 'valid source date'
Check $null (Get-ImaOptionalUpdatedDate '正文引用更新时间：2026-09-07') 'prose is not a metadata line'

$overlap = "精确保留：标点、公式 a+b != a-b，以及 Markdown。`n"
Check "前言`n${overlap}结尾" (Merge-ImaGeneralText "前言`n$overlap" "${overlap}结尾") 'exact overlapping text'
Check "line1`n-----`nline2" (Merge-ImaGeneralText "line1`n-----`nline2" 'line2') 'already-covered tail'
Check 'short complete note' (Merge-ImaGeneralText 'short complete' 'short complete note') 'full-window extension'
Check-Throws { Merge-ImaGeneralText 'abcdefghijklmno+pqrs' 'abcdefghijklmno-pqrs END' } 'punctuation difference is not normalized away'
Check-Throws { Merge-ImaGeneralText 'first window without any overlap' 'entirely different next window' } 'missing middle is rejected'
Check-Throws { Merge-ImaGeneralText '' 'text' } 'empty window is not complete'
$longOverlap = 'x' * 19000 + 'a+b, 中文'
$mergeTimer = [Diagnostics.Stopwatch]::StartNew()
Check ("start-$longOverlap-END") (Merge-ImaGeneralText "start-$longOverlap" "$longOverlap-END") 'long exact overlap'
if ($mergeTimer.Elapsed.TotalSeconds -gt 5) { throw 'Overlap matching is unexpectedly slow' }

Check $false (Test-ImaForegroundAllowed $false 0 10000) 'foreground disabled by default'
Check $false (Test-ImaForegroundAllowed $true 8000 10000) 'per-run foreground budget'
Check $false (Test-ImaForegroundAllowed $true 0 500) 'user input prevents takeover'
Check $true (Test-ImaForegroundAllowed $true 100 3000) 'explicit idle foreground fallback'
Check $false ([bool]($source -match '\[ImaSpeedSync\.NativeMethods\]::(?:SetCursorPos|mouse_event)\(')) 'runtime never moves the shared pointer or sends global mouse input'
Check $true (Test-ImaGeneralBottom ([pscustomobject]@{ Scrollable=$false; ScrollPercent=-1 })) 'non-scrolling short document'
Check $false (Test-ImaGeneralBottom ([pscustomobject]@{ Scrollable=$true; ScrollPercent=50 })) 'stalled middle is not bottom'
Check $true (Test-ImaGeneralBottom ([pscustomobject]@{ Scrollable=$true; ScrollPercent=103.1 })) 'bounded Chromium overshoot'
Check $false (Test-ImaGeneralBottom ([pscustomobject]@{ Scrollable=$true; ScrollPercent=[double]::NaN })) 'unknown scroll state is not bottom'
$viewportBounds = [pscustomobject]@{Top=50;Bottom=1050;Height=1000}
Check $true (Test-ImaContentEndVisible ([pscustomobject]@{Top=-7000;Bottom=1010;Height=8010;Width=800}) $viewportBounds) 'full editor extent ends within viewport'
Check $false (Test-ImaContentEndVisible ([pscustomobject]@{Top=50;Bottom=1050;Height=1000;Width=800}) $viewportBounds) 'clipped viewport rectangle is not an end boundary'
Check $false (Test-ImaContentEndVisible ([pscustomobject]@{Top=-4000;Bottom=4010;Height=8010;Width=800}) $viewportBounds) 'content extends below viewport'
Check $true (Test-ImaGeneralBottom ([pscustomobject]@{Scrollable=$true;ScrollPercent=95.5;ContentEndVisible=$true})) 'editor geometry independently confirms provider bottom'

& {
    $script:shortReads = 0
    function Get-ImaGeneralSnapshot {
        $script:shortReads++
        return [pscustomobject]@{ Text='明天开会'; Signature='same'; Scrollable=$false; ScrollPercent=-1 }
    }
    function Start-ImaCancelableSleep {}
    $short = Wait-ImaGeneralSnapshot '任意标题'
    Check 4 $script:shortReads 'short text is observed repeatedly, not accepted immediately'
    Check '明天开会' $short.Text 'short text remains intact'
}

& {
    function Wait-ImaGeneralSnapshot { return [pscustomobject]@{ Text='短文'; Scrollable=$false; ScrollPercent=-1; ViewSize=100 } }
    function Invoke-ImaBodyMouseWheel { throw 'A complete short note must not scroll or touch the desktop' }
    $short = Read-ImaGeneralArticle '没有日期也没有目录'
    Check '短文' $short.body 'short plain note extraction'
    Check $null $short.updatedDate 'short note does not invent a date'
    Check $true $short.complete 'verified non-scrolling note is complete'
}

& {
    $script:genericIndex = 0
    $script:genericWheels = 0
    $join1 = 'first overlap, preserving all punctuation!'
    $join2 = 'second overlap, preserving all punctuation!'
    $frames = @(
        [pscustomobject]@{ Text="Start $join1"; ScrollPercent=0 },
        [pscustomobject]@{ Text="$join1 Middle $join2"; ScrollPercent=50 },
        [pscustomobject]@{ Text="$join2 Tail"; ScrollPercent=100 }
    )
    $scroller = [pscustomobject]@{}
    $scroller | Add-Member ScriptMethod SetScrollPercent {}
    function Wait-ImaGeneralSnapshot {
        $frame = $frames[[Math]::Min(2, $script:genericIndex++)]
        return [pscustomobject]@{ Text=$frame.Text; Signature=$frame.Text; ScrollPercent=$frame.ScrollPercent; ViewSize=20; Scrollable=$true; Scroller=$scroller }
    }
    function Invoke-ImaBodyMouseWheel { $script:genericWheels++ }
    $long = Read-ImaGeneralArticle '无目录长文'
    Check "Start $join1 Middle $join2 Tail" $long.body 'continuous extraction keeps beginning middle and end'
    Check $true $long.complete 'complete long text'
    Check 2 $script:genericWheels 'only two scoped bottom confirmations'
    Check 5 $script:genericIndex 'no second full traversal'
}

& {
    $script:stalledReads = 0
    $scroller = [pscustomobject]@{}
    $scroller | Add-Member ScriptMethod SetScrollPercent {}
    function Wait-ImaGeneralSnapshot {
        $script:stalledReads++
        $position = if ($script:stalledReads -eq 1) { 0 } else { 50 }
        return [pscustomobject]@{ Text='same already-loaded content'; Signature='same'; ScrollPercent=$position; ViewSize=20; Scrollable=$true; Scroller=$scroller }
    }
    function Invoke-ImaBodyMouseWheel {}
    Check-Throws { Read-ImaGeneralArticle '中途卡住' } 'no-op in the middle is not treated as complete'
    Check 4 $script:stalledReads 'stalled article fails promptly without rereading everything'
}

& {
    $script:extentReads = 0
    function Wait-ImaGeneralSnapshot {
        $script:extentReads++
        $position = if ($script:extentReads -eq 1) { 0 } else { 95.5 }
        $scroller = [pscustomobject]@{}
        $scroller | Add-Member ScriptMethod SetScrollPercent {}
        return [pscustomobject]@{ Text='entire text with a known editor end'; Signature='same'; ScrollPercent=$position; ViewSize=12; Scrollable=$true; Scroller=$scroller; ContentEndVisible=($position -eq 95.5) }
    }
    function Invoke-ImaBodyMouseWheel { throw 'Verified editor end must not need the shared mouse' }
    function Start-ImaCancelableSleep {}
    $complete = Read-ImaGeneralArticle '边界可见'
    Check $true $complete.complete 'independent editor extent confirms completion'
    Check 4 $script:extentReads 'two stable end confirmations follow the first end observation'
}

& {
    function Wait-ImaGeneralSnapshot { throw [OperationCanceledException]::new('cancel') }
    Check-Throws { Read-ImaGeneralArticle '取消读取' } 'cancellation propagates immediately'
}

& {
    $script:CompletedItems = New-Object Collections.Generic.List[object]
    $script:CompletedErrors = New-Object Collections.Generic.List[object]
    $script:CompletedSkippedTitles = New-Object Collections.Generic.List[string]
    $script:SkipSourceIds = @{ 'known-id' = $true }
    $script:openedRecords = @()
    $script:closedRecords = 0
    function Get-ImaRecentArticleRecords {
        return @(
            [pscustomobject]@{ Name='同名文章'; Kind='note'; SourceId='known-id' },
            [pscustomobject]@{ Name='同名文章'; Kind='note'; SourceId='new-id' },
            [pscustomobject]@{ Name='附件.pdf'; Kind='pdf'; SourceId='pdf-id' }
        )
    }
    function Invoke-ImaArticleRecord { param($Record) $script:openedRecords += $Record.SourceId }
    function Read-ImaGeneralArticle { return [pscustomobject]@{ body='短正文'; complete=$true; updatedDate=$null } }
    function Close-ImaCurrentArticle { $script:closedRecords++ }
    function Write-SyncLog {}
    $result = Invoke-ImaGeneralSync $null
    Check 'new-id' ($script:openedRecords -join ',') 'known IDs and unsupported attachments are not opened'
    Check 1 $result.items.Count 'same-name different source is retained'
    Check 1 $result.skippedTitles.Count 'source ID skip is counted'
    Check 1 $result.errors.Count 'unsupported content is explicitly reported'
    Check 1 $script:closedRecords 'each newly opened article is closed once'
}

Write-Output "PASS: $script:Checks general-text and low-interference assertions (no real desktop operations)"
