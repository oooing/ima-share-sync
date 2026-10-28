$ErrorActionPreference = 'Stop'
$ImaSpeedSyncSkipMain = $true
$sourcePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\sync.ps1'
$source = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8)
. ([scriptblock]::Create($source))
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Get-ImaRoot { throw 'OFFLINE TEST: desktop access is forbidden' }
function Get-ImaWindowRoots { throw 'OFFLINE TEST: desktop access is forbidden' }
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
foreach ($pair in @(@(70,30), @(90,10), @(0,98), @(98,20))) {
    Check $false (Test-ImaGeneralBottom ([pscustomobject]@{Scrollable=$true;ScrollPercent=$pair[0];ViewSize=$pair[1];ContentEndVisible=$false})) 'visible percentage cannot be added to scroll offset'
}
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
    function Get-ImaGeneralCandidates {
        return @(
            [pscustomobject]@{ Name='同名文章'; Kind='note'; SourceId='known-id'; RelativeFolder=@() },
            [pscustomobject]@{ Name='同名文章'; Kind='note'; SourceId='new-id'; RelativeFolder=@() },
            [pscustomobject]@{ Name='分享网页'; Kind='weburl'; SourceId='web-id'; RelativeFolder=@() },
            [pscustomobject]@{ Name='附件.pdf'; Kind='pdf'; SourceId='pdf-id'; RelativeFolder=@() }
        )
    }
    function Invoke-ImaArticleRecord { param($Record) $script:openedRecords += $Record.SourceId }
    function Read-ImaGeneralArticle { return [pscustomobject]@{ body='短正文'; complete=$true; updatedDate=$null } }
    function Close-ImaCurrentArticle { $script:closedRecords++ }
    function Write-SyncLog {}
    $result = Invoke-ImaGeneralSync $null
    Check 'new-id,web-id' ($script:openedRecords -join ',') 'notes and web articles use text extraction; known IDs skip'
    Check 2 $result.items.Count 'same-name different source and web article are retained'
    Check 1 $result.skippedTitles.Count 'source ID skip is counted'
    Check 1 $result.errors.Count 'unsupported content is explicitly reported'
    Check 2 $script:closedRecords 'each newly opened article is closed once'
}

& {
    # 针对 Invoke-ImaArticleRecord 有界定位恢复与歧义拦截的离线回归测试
    $script:invokedKeys = @()
    $mockInvoke = [pscustomobject]@{}
    $mockInvoke | Add-Member ScriptMethod Invoke {
        $script:invokedKeys += $script:currentCardKey
        $script:invokedRuntimeIds += $script:currentRuntimeId
    }
    $script:invokedRuntimeIds = @()

    function Make-MockArticleElement($Key, $Name, $RuntimeId = 30) {
        $elem = [pscustomobject]@{
            Current = [pscustomobject]@{
                Name = $Name
                IsOffscreen = $false
                BoundingRectangle = [pscustomobject]@{ X=10; Y=100; Width=300; Height=40 }
            }
        }
        $elem | Add-Member NoteProperty TargetKey $Key
        $elem | Add-Member NoteProperty RuntimeId $RuntimeId
        $elem | Add-Member ScriptMethod TryGetCurrentPattern {
            param($PatternId, [ref]$PatternObj)
            if ($PatternId -eq [Windows.Automation.InvokePattern]::Pattern) {
                $script:currentCardKey = $this.TargetKey
                $script:currentRuntimeId = $this.RuntimeId
                $PatternObj.Value = $mockInvoke
                return $true
            }
            return $false
        }
        $elem | Add-Member ScriptMethod GetRuntimeId { return @(10, 20, $this.RuntimeId) }
        $card = [pscustomobject]@{
            Current = [pscustomobject]@{
                AutomationId = "knowledge-note_$Key"; IsOffscreen = $false
                BoundingRectangle = [pscustomobject]@{ X=10; Y=100; Width=300; Height=40 }
            }
            RuntimeId = $RuntimeId
        }
        $card | Add-Member ScriptMethod GetRuntimeId { return @(10, 20, $this.RuntimeId) }
        $card | Add-Member ScriptMethod TryGetCurrentPattern { param($PatternId, [ref]$PatternObj) return $false }
        return [pscustomobject]@{
            Name = $Name; Key = $Key; SourceId = $Key; Kind = 'note'; AutomationId = "knowledge-note_$Key"
            Element = $elem; Card = $card
            Y = 100.0; ScrollPercent = 0.0; ScrollStep = 0
        }
    }

    $fakeRoot = [pscustomobject]@{
        Current = [pscustomobject]@{ NativeWindowHandle = [IntPtr]1234; ProcessId = 5678 }
    }
    function Get-ImaRoot { return $fakeRoot }
    function Get-ImaArticleWindowPresence { param($Name) return [pscustomobject]@{ State = 'Absent' } }
    function Find-ImaArticleWindow { param($Name) return $null }
    $script:locateSleepCount = 0
    function Start-ImaCancelableSleep { param($Ms) $script:locateSleepCount++ }
    function Test-ImaCancellation {}
    function Set-ImaTitleListScrollPercent { param($Target, $Percent) $script:lastSetScroll = $Percent }

    $mockScroller = [pscustomobject]@{
        Pattern = [pscustomobject]@{
            Current = [pscustomobject]@{ VerticalScrollPercent = 10.0; VerticalViewSize = 25.0 }
        }
        RangePattern = $null
    }
    function Get-ImaTitleListScroller { param($Root) return $mockScroller }
    $mockList = [pscustomobject]@{
        Current = [pscustomobject]@{
            IsOffscreen = $false
            BoundingRectangle = [pscustomobject]@{ X=0; Y=0; Width=400; Height=800 }
        }
    }
    function Get-ImaTitleListElement { param($Root) return $mockList }

    # 测试 1：首屏直接命中，无额外等待与滚动
    $script:invokedKeys = @()
    $script:lastSetScroll = -1
    $mockRecord1 = Make-MockArticleElement 'key-1' '文章1'
    function Get-ImaVisibleTitleSnapshot { param($Root) return [pscustomobject]@{ Records = @($mockRecord1) } }
    Invoke-ImaArticleRecord ([pscustomobject]@{ Name='文章1'; Key='key-1'; Kind='note'; ScrollPercent=0; ScrollStep=0 })
    Check 'key-1' ($script:invokedKeys -join ',') 'target visible on first screen opens directly'
    Check 1 $script:invokedKeys.Count 'unique first-screen target invokes exactly once'
    Check 0 $script:locateSleepCount 'unique first-screen target does not add a readiness delay'
    Check -1 $script:lastSetScroll 'unique first-screen target does not scroll'

    # 测试 2：渲染延迟（轮询重试后就绪）
    $script:invokedKeys = @()
    $script:pollAttempt = 0
    function Get-ImaVisibleTitleSnapshot {
        param($Root)
        $script:pollAttempt++
        if ($script:pollAttempt -lt 2) { return [pscustomobject]@{ Records = @() } }
        return [pscustomobject]@{ Records = @($mockRecord1) }
    }
    function Get-ImaGeneralTitleSnapshot { param($List, [switch]$IncludeOffscreen) return [pscustomobject]@{ AllRecords = @() } }
    Invoke-ImaArticleRecord ([pscustomobject]@{ Name='文章1'; Key='key-1'; Kind='note'; ScrollPercent=25; ScrollStep=2 })
    Check 'key-1' ($script:invokedKeys -join ',') 'delayed rendering is resolved within bounded polling loop'

    # 测试 3：真正触发懒加载范围变化后的微调恢复（阶段 4），断言微调滚动计算与最终命中
    $script:invokedKeys = @()
    $script:lastSetScroll = -1
    $script:stage4Triggered = $false
    $offscreenCard = Make-MockArticleElement 'key-3' '失准文章'
    $offscreenCard.Y = 900.0 # 位于视口下方

    function Set-ImaTitleListScrollPercent {
        param($Target, $Percent)
        $script:lastSetScroll = $Percent
        if ($Percent -ne 50) {
            $script:stage4Triggered = $true
        }
    }

    # 阶段 2 离屏快照为空；阶段 3 回放提示（lastSetScroll=50）后离屏树显现卡片供阶段 4 计算几何补偿
    function Get-ImaGeneralTitleSnapshot {
        param($List, [switch]$IncludeOffscreen)
        if ($IncludeOffscreen -and $script:lastSetScroll -eq 50) {
            return [pscustomobject]@{ AllRecords = @($offscreenCard) }
        }
        return [pscustomobject]@{ AllRecords = @() }
    }

    # 阶段 1 和阶段 3 视口快照均未命中；只有当阶段 4 真正触发微调几何滚动后，卡片才就绪
    function Get-ImaVisibleTitleSnapshot {
        param($Root)
        if ($script:stage4Triggered) {
            return [pscustomobject]@{ Records = @($offscreenCard) }
        }
        return [pscustomobject]@{ Records = @() }
    }

    Invoke-ImaArticleRecord ([pscustomobject]@{ Name='失准文章'; Key='key-3'; Kind='note'; ScrollPercent=50; ScrollStep=5 })
    Check 'key-3' ($script:invokedKeys -join ',') 'extent recovery successfully recalculates offset and opens target'
    Check $true $script:stage4Triggered 'stage 4 extent recovery actually recalculated and updated scroll percent'

    # 测试 4：始终未就绪在时限内安全退出且不误点
    function Get-ImaVisibleTitleSnapshot { param($Root) return [pscustomobject]@{ Records = @() } }
    function Get-ImaGeneralTitleSnapshot { param($List, [switch]$IncludeOffscreen) return [pscustomobject]@{ AllRecords = @() } }
    $errMsg = ''
    try {
        Invoke-ImaArticleRecord ([pscustomobject]@{ Name='丢失文章'; Key='key-lost'; Kind='note'; ScrollPercent=80; ScrollStep=8 })
    } catch {
        $errMsg = $_.Exception.Message
    }
    Check $true ($errMsg -like '*本轮不点击：丢失文章*') 'unresolved article terminates safely without click'

    # 测试 5：身份出现歧义时拦截
    $dup1 = Make-MockArticleElement 'key-dup' '歧义1'
    $dup2 = Make-MockArticleElement 'key-dup' '歧义2'
    function Get-ImaVisibleTitleSnapshot { param($Root) return [pscustomobject]@{ Records = @($dup1, $dup2) } }
    $ambigMsg = ''
    try {
        Invoke-ImaArticleRecord ([pscustomobject]@{ Name='歧义1'; Key='key-dup'; Kind='note'; ScrollPercent=0; ScrollStep=0 })
    } catch {
        $ambigMsg = $_.Exception.Message
    }
    Check $true ($ambigMsg -like '*存在歧义*') 'ambiguous identity is strictly rejected'

    # A duplicate source identity must settle before any physical element is invoked.
    $mockTargetCard = Make-MockArticleElement 'key-transient' 'same title' 101
    $duplicate = Make-MockArticleElement 'key-transient' 'same title' 202
    $requested = [pscustomobject]@{ Name='same title'; Key='key-transient'; Kind='note'; ScrollPercent=35; ScrollStep=1 }
    $script:invokedKeys = @(); $script:invokedRuntimeIds = @(); $script:visibleReads = 0
    function Get-ImaVisibleTitleSnapshot {
        param($Root)
        $script:visibleReads++
        if ($script:visibleReads -le 2) { return [pscustomobject]@{ Records=@($mockTargetCard, $duplicate) } }
        return [pscustomobject]@{ Records=@($mockTargetCard) }
    }
    Invoke-ImaArticleRecord $requested
    Check 1 $script:invokedKeys.Count 'initial transient duplicate invokes exactly once'
    Check 'key-transient' $script:invokedKeys[0] 'initial transient duplicate preserves source identity'
    Check 101 $script:invokedRuntimeIds[0] 'initial transient duplicate invokes the surviving physical element'
    Check $true ($script:visibleReads -ge 3) 'initial duplicate waits until a unique snapshot'

    # The loaded-scroll polling path must not stop on its first two-match frame.
    $script:invokedKeys = @(); $script:invokedRuntimeIds = @(); $script:visibleReads = 0
    $script:loadedReads = 0; $script:lastSetScroll = -1
    function Set-ImaTitleListScrollPercent { param($Target, $Percent) $script:lastSetScroll = $Percent }
    function Get-ImaGeneralTitleSnapshot {
        param($List, [switch]$IncludeOffscreen)
        $script:loadedReads++
        return [pscustomobject]@{ AllRecords=@($mockTargetCard) }
    }
    function Get-ImaVisibleTitleSnapshot {
        param($Root)
        $script:visibleReads++
        if ($script:visibleReads -eq 1) { return [pscustomobject]@{ Records=@() } }
        if ($script:visibleReads -eq 2) { return [pscustomobject]@{ Records=@($mockTargetCard, $duplicate) } }
        return [pscustomobject]@{ Records=@($mockTargetCard) }
    }
    Invoke-ImaArticleRecord $requested
    Check 1 $script:invokedKeys.Count 'loaded-scroll transient duplicate invokes exactly once'
    Check 'key-transient' $script:invokedKeys[0] 'loaded-scroll transient duplicate preserves source identity'
    Check 101 $script:invokedRuntimeIds[0] 'loaded-scroll transient duplicate invokes only the surviving element'
    Check $true ($script:loadedReads -ge 1 -and $script:lastSetScroll -ne 35) 'loaded-scroll case uses loaded geometry instead of the saved hint'

    # If no loaded card is available, hint playback must also survive 0 -> 2 -> 1.
    $script:invokedKeys = @(); $script:invokedRuntimeIds = @(); $script:visibleReads = 0
    $script:lastSetScroll = -1
    function Get-ImaGeneralTitleSnapshot { param($List, [switch]$IncludeOffscreen) return [pscustomobject]@{ AllRecords=@() } }
    Invoke-ImaArticleRecord $requested
    Check 1 $script:invokedKeys.Count 'hint playback transient duplicate invokes exactly once'
    Check 'key-transient' $script:invokedKeys[0] 'hint playback transient duplicate preserves source identity'
    Check 101 $script:invokedRuntimeIds[0] 'hint playback transient duplicate invokes only the surviving element'
    Check 35 $script:lastSetScroll 'hint playback case actually uses the saved scroll hint'

    # Loaded duplicates must settle before their geometry is used to scroll.
    $script:invokedKeys = @(); $script:invokedRuntimeIds = @()
    $script:loadedReads = 0; $script:lastSetScroll = -1; $script:loadedRecoveredScroll = $false
    function Get-ImaGeneralTitleSnapshot {
        param($List, [switch]$IncludeOffscreen)
        $script:loadedReads++
        if ($script:loadedReads -le 2) { return [pscustomobject]@{ AllRecords=@($mockTargetCard, $duplicate) } }
        return [pscustomobject]@{ AllRecords=@($mockTargetCard) }
    }
    function Set-ImaTitleListScrollPercent {
        param($Target, $Percent)
        $script:lastSetScroll = $Percent
        if ($script:loadedReads -ge 3 -and $Percent -ne 35) { $script:loadedRecoveredScroll = $true }
    }
    function Get-ImaVisibleTitleSnapshot {
        param($Root)
        if ($script:loadedRecoveredScroll) { return [pscustomobject]@{ Records=@($mockTargetCard) } }
        return [pscustomobject]@{ Records=@() }
    }
    Invoke-ImaArticleRecord $requested
    Check 1 $script:invokedKeys.Count 'loaded duplicate settling invokes exactly once'
    Check 'key-transient' $script:invokedKeys[0] 'loaded duplicate settling preserves target identity'
    Check 101 $script:invokedRuntimeIds[0] 'loaded duplicate settling invokes the surviving physical card'
    Check $true ($script:loadedReads -ge 3 -and $script:loadedRecoveredScroll) 'loaded duplicates settle before target geometry scrolls'

    # If duplicates first appear after hint playback, extent recovery must also wait.
    $script:invokedKeys = @(); $script:invokedRuntimeIds = @()
    $script:extentLoadedReads = 0; $script:lastSetScroll = -1; $script:extentRecoveredScroll = $false
    function Get-ImaGeneralTitleSnapshot {
        param($List, [switch]$IncludeOffscreen)
        if ($script:lastSetScroll -ne 35) { return [pscustomobject]@{ AllRecords=@() } }
        $script:extentLoadedReads++
        if ($script:extentLoadedReads -le 2) { return [pscustomobject]@{ AllRecords=@($mockTargetCard, $duplicate) } }
        return [pscustomobject]@{ AllRecords=@($mockTargetCard) }
    }
    function Set-ImaTitleListScrollPercent {
        param($Target, $Percent)
        $script:lastSetScroll = $Percent
        if ($script:extentLoadedReads -ge 3 -and $Percent -ne 35) { $script:extentRecoveredScroll = $true }
    }
    function Get-ImaVisibleTitleSnapshot {
        param($Root)
        if ($script:extentRecoveredScroll) { return [pscustomobject]@{ Records=@($mockTargetCard) } }
        return [pscustomobject]@{ Records=@() }
    }
    Invoke-ImaArticleRecord $requested
    Check 1 $script:invokedKeys.Count 'extent loaded duplicate settling invokes exactly once'
    Check 'key-transient' $script:invokedKeys[0] 'extent loaded duplicate settling preserves target identity'
    Check 101 $script:invokedRuntimeIds[0] 'extent loaded duplicate settling invokes the surviving physical card'
    Check $true ($script:extentLoadedReads -ge 3 -and $script:extentRecoveredScroll) 'extent recovery waits for unique loaded geometry'

    # Real Nexchip trace: the bottom jump first has no loaded target, then the
    # content extent grows and the target arrives offscreen. Waiting alone never
    # makes it visible: exactly one correction using the fresh extent is needed.
    $mockLateCard = Make-MockArticleElement 'key-late' 'late target' 401
    $mockLateCard.Y = 900.0
    $mockLateDecoy = Make-MockArticleElement 'key-late-decoy' 'late target' 402
    $lateRequested = [pscustomobject]@{ Name='late target'; Key='key-late'; Kind='note'; ScrollPercent=100; ScrollStep=1 }
    $script:invokedKeys = @(); $script:invokedRuntimeIds = @()
    $script:lateScrolls = @(); $script:lateLoadedReads = 0; $script:lateVisibleReadsAfterAdjust = 0
    $script:lateScrollViews = @(); $script:lateScrollOffsets = @()
    $mockScroller.Pattern.Current.VerticalViewSize = 26.76
    $mockScroller.Pattern.Current.VerticalScrollPercent = 100.0
    function Get-ImaTitleListScroller {
        param($Root)
        return [pscustomobject]@{
            Pattern=[pscustomobject]@{ Current=[pscustomobject]@{
                VerticalViewSize=$mockScroller.Pattern.Current.VerticalViewSize
                VerticalScrollPercent=$mockScroller.Pattern.Current.VerticalScrollPercent
            } }
            RangePattern=$null
        }
    }
    function Get-ImaGeneralTitleSnapshot {
        param($List, [switch]$IncludeOffscreen)
        if ($script:lateScrolls.Count -eq 0) { return [pscustomobject]@{ AllRecords=@() } }
        $script:lateLoadedReads++
        if ($script:lateLoadedReads -lt 3) { return [pscustomobject]@{ AllRecords=@() } }
        $mockScroller.Pattern.Current.VerticalViewSize = 24.8
        $mockScroller.Pattern.Current.VerticalScrollPercent = 88.97
        return [pscustomobject]@{ AllRecords=@($mockLateCard) }
    }
    function Set-ImaTitleListScrollPercent {
        param($Target, $Percent)
        $script:lateScrolls += [double]$Percent
        $script:lateScrollViews += [double]$Target.Pattern.Current.VerticalViewSize
        $script:lateScrollOffsets += [double]$Target.Pattern.Current.VerticalScrollPercent
    }
    function Get-ImaVisibleTitleSnapshot {
        param($Root)
        if ($script:lateScrolls.Count -ge 2) {
            $script:lateVisibleReadsAfterAdjust++
            if ($script:lateVisibleReadsAfterAdjust -ge 3) {
                return [pscustomobject]@{ Records=@($mockLateDecoy, $mockLateCard) }
            }
        }
        return [pscustomobject]@{ Records=@($mockLateDecoy) }
    }
    Invoke-ImaArticleRecord $lateRequested
    Check 1 $script:invokedKeys.Count 'late-loaded extent recovery invokes exactly once'
    Check 'key-late' $script:invokedKeys[0] 'late-loaded extent recovery keeps strict source identity'
    Check 401 $script:invokedRuntimeIds[0] 'late-loaded extent recovery never invokes the same-title decoy'
    Check $true ($script:lateLoadedReads -ge 3) 'extent recovery waits through missing loaded frames'
    Check 2 $script:lateScrolls.Count 'late-loaded recovery uses one hint and at most one geometry correction'
    Check 100 $script:lateScrolls[1] 'late-loaded geometry correction uses the expanded current range'
    Check 24.8 $script:lateScrollViews[1] 'geometry correction reacquires the expanded view size after target arrival'
    Check 88.97 $script:lateScrollOffsets[1] 'geometry correction reacquires the actual offset after target arrival'
    Check $true ($script:lateVisibleReadsAfterAdjust -ge 3) 'post-adjustment readiness does not trigger repeated corrections'
    $mockScroller.Pattern.Current.VerticalViewSize = 25.0
    $mockScroller.Pattern.Current.VerticalScrollPercent = 10.0
    function Get-ImaTitleListScroller { param($Root) return $mockScroller }
    function Set-ImaTitleListScrollPercent { param($Target, $Percent) $script:lastSetScroll = $Percent }
    function Get-ImaGeneralTitleSnapshot { param($List, [switch]$IncludeOffscreen) return [pscustomobject]@{ AllRecords=@() } }

    # Two distinct cards with identical names and source keys remain ambiguous.
    $script:invokedKeys = @(); $script:invokedRuntimeIds = @()
    function Get-ImaVisibleTitleSnapshot { param($Root) return [pscustomobject]@{ Records=@($mockTargetCard, $duplicate) } }
    $persistentError = ''; $clock = [Diagnostics.Stopwatch]::StartNew()
    try { Invoke-ImaArticleRecord $requested } catch { $persistentError = $_.Exception.Message }
    $clock.Stop()
    Check $true ($persistentError -like '*存在歧义*') 'persistent same-title same-key physical duplicates are rejected'
    Check 0 $script:invokedKeys.Count 'persistent duplicate never invokes either card'
    Check 0 $script:invokedRuntimeIds.Count 'persistent duplicate never invokes a physical element'
    Check $true ($clock.ElapsedMilliseconds -lt 5500) 'persistent duplicate stays within the bounded locate budget'

    # A title match cannot substitute for the requested source identity.
    $decoy = Make-MockArticleElement 'key-decoy' 'same title' 303
    $script:invokedKeys = @(); $script:invokedRuntimeIds = @()
    function Get-ImaVisibleTitleSnapshot { param($Root) return [pscustomobject]@{ Records=@($decoy, $mockTargetCard) } }
    Invoke-ImaArticleRecord $requested
    Check 1 $script:invokedKeys.Count 'same-title decoy does not cause a second invocation'
    Check 'key-transient' $script:invokedKeys[0] 'strict key chooses the target over a same-title decoy'
    Check 101 $script:invokedRuntimeIds[0] 'strict key invokes the target physical element'
    $script:invokedKeys = @(); $script:invokedRuntimeIds = @()
    function Get-ImaVisibleTitleSnapshot { param($Root) return [pscustomobject]@{ Records=@($decoy) } }
    Check-Throws { Invoke-ImaArticleRecord $requested } 'a same-title decoy alone cannot resolve the missing identity'
    Check 0 $script:invokedKeys.Count 'missing identity never invokes the same-title decoy'

    # Cancellation while waiting on an ambiguous snapshot must escape without input.
    $script:invokedKeys = @(); $script:invokedRuntimeIds = @(); $script:cancelChecks = 0
    function Get-ImaVisibleTitleSnapshot { param($Root) return [pscustomobject]@{ Records=@($mockTargetCard, $duplicate) } }
    function Test-ImaCancellation {
        $script:cancelChecks++
        throw [OperationCanceledException]::new('cancel ambiguous locate')
    }
    $canceled = $false
    try { Invoke-ImaArticleRecord $requested } catch [OperationCanceledException] { $canceled = $true }
    Check $true $canceled 'cancellation during ambiguous locating propagates'
    Check $true ($script:cancelChecks -ge 1) 'ambiguous locating polls cancellation'
    Check 0 $script:invokedKeys.Count 'canceled ambiguous locating never invokes a card'
}

Write-Output "PASS: $script:Checks general-text and low-interference assertions (no real desktop operations)"
