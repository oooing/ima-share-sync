$ErrorActionPreference = "Stop"

$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "src\sync.ps1"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "src/sync.ps1 does not exist"
}

$ImaSpeedSyncSkipMain = $true
$scriptSource = [IO.File]::ReadAllText($scriptPath, (New-Object Text.UTF8Encoding($false)))
$scriptBlock = [ScriptBlock]::Create($scriptSource)
$skipTitlesJson = '["brief-0810","brief-0809"]'
$skipTitlesBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($skipTitlesJson))
. $scriptBlock `
    -KnowledgeBaseName "Test knowledge base" `
    -FolderName "Test folder" `
    -TitlePattern '^brief-\d{4}$' `
    -UpdateMarker "UPDATED:" `
    -MaxItems 3 `
    -SkipTitlesBase64 $skipTitlesBase64

$script:AssertionCount = 0
function Assert-Equal([string]$Expected, [string]$Actual, [string]$Name) {
    $script:AssertionCount++
    if ($Expected -cne $Actual) {
        throw "$Name failed.`nExpected:`n$Expected`nActual:`n$Actual"
    }
}

function Assert-Throws([scriptblock]$Action, [string]$Name) {
    $script:AssertionCount++
    try {
        & $Action
    }
    catch {
        return
    }
    throw "$Name failed: expected an exception"
}

$raw = "Contents`nbrief-0810`nUPDATED: 2026.08.10 11:59`n$([char]0xFEFF)`n$([char]0xFFFC)`nBody title`nBody text`n$([char]0xFFFC)"
Assert-Equal "Body title`nBody text" (Get-ImaBodyChunk $raw) "body extraction"
Assert-Equal "2026-08-10" (Get-ImaUpdatedDateFromText $raw) "full update date"
Assert-Throws { Get-ImaUpdatedDateFromText "UPDATED: not-a-date" } "invalid update date"
$quotedUpdate = "Contents`nbrief-0904`nUPDATED: 2026-09-04 08:00`nOpening paragraph`nUPDATED: 2020-01-01`nQuoted historical note"
Assert-Equal "2026-09-04" (Get-ImaUpdatedDateFromText $quotedUpdate) "body update quote cannot replace header date"
Assert-Equal "Opening paragraph`nUPDATED: 2020-01-01`nQuoted historical note" (Get-ImaBodyChunk $quotedUpdate) "body update quote cannot truncate content"
Assert-Throws { Get-ImaUpdatedDateFromText "Contents`nUPDATED: invalid`nBody" } "invalid update marker is rejected"
$inlineMarkerBeforeHeader = "Contents mention UPDATED: 2020-01-01 inline`nUPDATED: 2026-09-04`nBody"
Assert-Equal "2026-09-04" (Get-ImaUpdatedDateFromText $inlineMarkerBeforeHeader) "only a strict marker line defines the header date"

$readinessPrefix = "P" * 1100
$readyDocumentText = "Contents`nFirst heading`nUPDATED: 2026-09-04`n$readinessPrefix`nTail A"
$readyState = Get-ImaDocumentReadinessState $readyDocumentText $true
Assert-Equal "True" ([string]$readyState.Ready) "article readiness accepts loaded TOC body and scroller"
Assert-Equal "1" ([string]$readyState.TocCount) "article readiness counts stable TOC entries"
$missingScrollerState = Get-ImaDocumentReadinessState $readyDocumentText $false
Assert-Equal "False" ([string]$missingScrollerState.Ready) "article readiness waits for known body scroller"
$tailOnlyChangeState = Get-ImaDocumentReadinessState ($readyDocumentText.Replace("Tail A", "Tail B")) $true
Assert-Equal $readyState.Signature $tailOnlyChangeState.Signature "virtualized tail changes do not block initial structure stability"
$prefixChangeState = Get-ImaDocumentReadinessState ($readyDocumentText.Replace(("P" * 100), ("Q" * 100))) $true
Assert-Equal $readyState.Signature $prefixChangeState.Signature "continuously changing body prefix does not block structural readiness"
$tocTextChangeState = Get-ImaDocumentReadinessState ($readyDocumentText.Replace("First heading", "Renamed heading")) $true
Assert-Equal $readyState.Signature $tocTextChangeState.Signature "changing TOC text with a stable count does not hard-block readiness"
$tocGrowthState = Get-ImaDocumentReadinessState ($readyDocumentText.Replace("First heading", "First heading`nSecond heading")) $true
Assert-Equal "False" ([string]($readyState.Signature -ceq $tocGrowthState.Signature)) "TOC growth resets article structure stability"

$firstTitle = "First section title long enough for table-of-contents detection"
$secondTitle = "Second section title long enough for table-of-contents detection"
$sectionChunk = "Preface`n$firstTitle`nFirst body`n$secondTitle`nSecond body"
Assert-Equal "Preface`n$firstTitle`nFirst body" (Get-ImaSectionText $sectionChunk $firstTitle $secondTitle $true) "first section keeps preface"
Assert-Equal "$secondTitle`nSecond body" (Get-ImaSectionText $sectionChunk $secondTitle $null $false) "last section keeps tail"
$duplicateSectionChunk = "Repeated heading`nFirst occurrence`nRepeated heading`nSecond occurrence"
Assert-Equal "Repeated heading`nSecond occurrence" (Get-ImaSectionText $duplicateSectionChunk "Repeated heading" $null $false 2) "duplicate heading occurrence selects its own section"
Assert-Equal "False" ([string](Test-ImaCanReuseTopViewport "First body heading" "Article title" 1 0)) "TOC article title cannot reuse a body viewport"
Assert-Equal "True" ([string](Test-ImaCanReuseTopViewport "First body heading" "First body heading" 1 0)) "first body heading already at top may avoid a needless jump"
Assert-Equal "False" ([string](Test-ImaCanReuseTopViewport "Repeated heading" "Repeated heading" 2 0)) "second duplicate heading cannot reuse the first occurrence viewport"
Assert-Equal "True" ([string](Test-ImaCanReuseTopViewport "Repeated heading`nBody`nRepeated heading" "Repeated heading" 2 0)) "visible duplicate occurrence may reuse the same top viewport"
Assert-Equal "False" ([string](Test-ImaCanReuseTopViewport "First body heading" "First body heading" 1 5)) "non-top viewport still requires click progress validation"
Assert-Equal "True" ([string](Test-ImaHasCompleteSectionWindow $sectionChunk $firstTitle $secondTitle)) "complete cached section can skip a TOC click"
Assert-Equal "False" ([string](Test-ImaHasCompleteSectionWindow $firstTitle $firstTitle $secondTitle)) "a heading alone cannot prove the section is complete"
Assert-Equal "False" ([string](Test-ImaHasCompleteSectionWindow $sectionChunk $secondTitle $firstTitle)) "cached section boundaries must be in body order"
Assert-Equal "False" ([string](Test-ImaHasCompleteSectionWindow "Quoted $firstTitle in prose`n$secondTitle" $firstTitle $secondTitle)) "prose mentions are not section boundaries"
Assert-Equal "False" ([string](Test-ImaHasCompleteSectionWindow $sectionChunk $firstTitle "")) "the last section must still verify the bottom"
Assert-Throws { Get-ImaSectionText $sectionChunk "Missing current section title" $secondTitle $false } "missing current section boundary"
Assert-Throws { Get-ImaSectionText $sectionChunk $firstTitle "Missing next section title" $false } "missing next section boundary"
Assert-Equal "Preface`n`n## $firstTitle`n`nFirst body" (Format-ImaSectionMarkdown "Preface`n$firstTitle`nFirst body" $firstTitle) "section title formatting"

$overlapA = "First section`nShared overlap line one is long enough`nShared overlap line two is also long enough"
$overlapB = "Shared overlap line one is long enough`nShared overlap line two is also long enough`nNext section"
Assert-Equal "$overlapA`nNext section" (Merge-ImaTextWindows $overlapA $overlapB) "virtualized text-window merge"
$fuzzyOverlapA = "First section`nShared virtualized text contains enough meaningful characters for matching.`n---`nFinal shared paragraph"
$fuzzyOverlapB = "Shared virtualized text contains enough`nmeaningful characters for matching.`nFinal shared paragraph`nNext section"
Assert-Equal "$fuzzyOverlapA`nNext section" (Merge-ImaTextWindows $fuzzyOverlapA $fuzzyOverlapB) "format-tolerant virtualized text-window merge"
$ruleAnchors = @([pscustomobject]@{ Before = "Previous source"; After = "Next heading" })
Assert-Equal "Previous source`n`n---`n`nNext heading" (Add-ImaHorizontalRulesToText "Previous source`nNext heading" $ruleAnchors) "horizontal-rule restoration"
Assert-Equal "Previous source`n---`nNext heading" (Add-ImaHorizontalRulesToText "Previous source`n---`nNext heading" $ruleAnchors) "existing horizontal rule is not duplicated"

$cancelPath = [IO.Path]::GetTempFileName()
$script:CancelFilePath = $cancelPath
Assert-Throws { Test-ImaCancellation } "cancellation signal"
[IO.File]::Delete($cancelPath)
$script:CancelFilePath = ""
Assert-Equal "True" ([string]($scriptSource.Contains('catch [OperationCanceledException]'))) "cancellation has a graceful top-level handler"

$realTocTitle = "Example report title long enough for table-of-contents candidate testing"
$exampleLink = "Example share https://example.invalid/ima/share/demo"
Assert-Equal "True" ([string](Test-ImaTocCandidateName $realTocTitle "Contents`n$realTocTitle")) "table-of-contents title"
Assert-Equal "False" ([string](Test-ImaTocCandidateName $exampleLink "Contents`n$exampleLink")) "share link is not a table-of-contents title"
Assert-Equal "False" ([string](Test-ImaTocCandidateName "Short title" "Contents`nShort title")) "old proven TOC rule rejects fragment-prone short labels"
Assert-Equal "True" ([string](Test-ImaTocCandidateName $realTocTitle "Contents`n1. $realTocTitle")) "old proven TOC rule accepts a full UIA name inside a prefixed raw TOC line"
Assert-Equal "False" ([string](Test-ImaTocCandidateName "report title" "Contents`n$realTocTitle")) "old proven TOC rule still applies its length threshold to fragments"
Assert-Equal "A|A" ((Get-ImaTocCandidateNames "Contents`nA`nA") -join "|") "duplicate table-of-contents titles retain occurrence identity"

$tocItemsFunctionSource = [regex]::Match(
    $scriptSource,
    'function Get-ImaTocItems\((?s:.*?)\r?\n\}'
).Value
Assert-Equal "True" ([string]($tocItemsFunctionSource.Contains('$all = $Root.FindAll'))) "TOC candidates are enumerated from the complete article window root"
Assert-Equal "True" ([string]($tocItemsFunctionSource.Contains('[Windows.Automation.Condition]::TrueCondition'))) "TOC enumeration matches the old proven Root traversal"
Assert-Equal "False" ([string]($tocItemsFunctionSource.Contains('$Document.FindAll'))) "TOC item collection no longer scans every body descendant"
Assert-Equal "False" ([string]($tocItemsFunctionSource.Contains('$documentRuntimeId'))) "TOC candidates are not rejected merely for sharing the body Document"
Assert-Equal "False" ([string]($tocItemsFunctionSource.Contains('dom-scroll-content'))) "TOC candidates are not rejected by the shared body ancestor"
Assert-Equal "True" ([string]($tocItemsFunctionSource.Contains('$seen.ContainsKey($name)'))) "old proven TOC rule keeps the first invokable node for each name"
Assert-Equal "True" ([string]($tocItemsFunctionSource.Contains('$name -ceq $script:CurrentArticleTitle'))) "article title is explicitly excluded from TOC items"
Assert-Equal "True" ([string]($tocItemsFunctionSource.Contains('Occurrence = 1'))) "same-name TOC entries document the first-occurrence compatibility rule"
Assert-Equal "False" ([string]($tocItemsFunctionSource.Contains('Resolve-ImaTocDisplayTitle'))) "fragment mapping is not used by the proven TOC path"

$titleRecords = @(
    [pscustomobject]@{ Name = "brief-0831"; VisualIndex = 0 },
    [pscustomobject]@{ Name = "brief-0904"; VisualIndex = 6 },
    [pscustomobject]@{ Name = "brief-0903"; VisualIndex = 4 },
    [pscustomobject]@{ Name = "other"; VisualIndex = 1 }
)
$sortedTitleNames = @((Sort-ImaTitleRecords $titleRecords ([datetime]"2026-09-04")) | ForEach-Object { $_.Name })
Assert-Equal "brief-0904|brief-0903|brief-0831|other" ($sortedTitleNames -join "|") "date titles are newest-first despite UIA enumeration"
$topFolderTitles = @("brief-0822", "brief-0904", "brief-0903", "brief-0905")
$selectedTopTitles = @(Select-ImaRecentTitles $topFolderTitles 3 ([datetime]"2026-09-05"))
Assert-Equal "brief-0904|brief-0903|brief-0822" ($selectedTopTitles -join "|") "top-of-folder window is fixed before title-date sorting"
Assert-Equal "False" ([string]($selectedTopTitles -contains "brief-0905")) "a later visual entry cannot displace a newly re-shared top candidate"
Assert-Equal "2025-12-31" ((Get-ImaTitleDateValue "brief-1231" ([datetime]"2026-01-03")).ToString("yyyy-MM-dd")) "short title date handles year boundary"

Add-Type -AssemblyName UIAutomationClient
$firstPageProbe = & {
    $script:firstPageProbeWheelCalls = 0
    $script:firstPageProbeResetCalls = 0
    $mockScrollTarget = [pscustomobject]@{
        RangePattern = $null
        Pattern = [pscustomobject]@{
            Current = [pscustomobject]@{
                VerticalScrollPercent = 0.0
                VerticalViewSize = 25.0
            }
        }
    }
    function Get-ImaTitleListScroller { return $mockScrollTarget }
    function Reset-ImaTitleListToTop { $script:firstPageProbeResetCalls++ }
    function Get-ImaRoot { return $null }
    function Start-ImaCancelableSleep {}
    function Write-SyncLog {}
    function Invoke-ImaTitleListMouseWheel {
        $script:firstPageProbeWheelCalls++
        return $true
    }
    function Add-ImaVisibleTitles {
        param($Root, $Seen, $Titles, $ScrollPercent, $ScrollStep)
        foreach ($name in @("brief-0822", "brief-0904", "brief-0903", "brief-0905")) {
            if (-not $Seen.ContainsKey($name)) {
                $Seen[$name] = $true
                $Titles.Add($name)
            }
        }
    }
    $selected = @(Get-ImaRecentTitles $null 3)
    return [pscustomobject]@{
        Selected = ($selected -join "|")
        WheelCalls = $script:firstPageProbeWheelCalls
        ResetCalls = $script:firstPageProbeResetCalls
    }
}
Assert-Equal "brief-0904|brief-0903|brief-0822" $firstPageProbe.Selected "complete first page is sorted only after its candidate window is fixed"
Assert-Equal "0" ([string]$firstPageProbe.WheelCalls) "a sufficient first page performs no downward scroll"
Assert-Equal "1" ([string]$firstPageProbe.ResetCalls) "an unmoved top page avoids a redundant final reset"

Assert-Equal "True" ([string](Test-ImaTransientExtractionError "document loading timeout")) "transient extraction error"
Assert-Equal "False" ([string](Test-ImaTransientExtractionError "invalid metadata value")) "permanent extraction error"
Assert-Equal "False" ([string](Test-ImaTransientExtractionError "最后章节未能完整读取到正文底部：相邻 IMA 文本窗口没有足够的重叠内容")) "tail merge failure does not restart the entire article"
Assert-Equal "False" ([string](Test-ImaTransientExtractionError "IMA 正文尾部向下滚动失败：等待 IMA 正文视图稳定超时")) "exhausted local tail retry does not restart the entire article"

$windowPresenceProbe = & {
    function Get-ImaWindowRoots { return $script:windowPresenceRoots }
    $script:windowPresenceRoots = @(
        [pscustomobject]@{ Current = [pscustomobject]@{ Name = "brief-0905" } }
    )
    $present = (Get-ImaArticleWindowPresence "brief-0905").State
    $caseMismatch = (Get-ImaArticleWindowPresence "Brief-0905").State
    $unavailableRoot = New-Object PSObject
    $unavailableRoot | Add-Member -MemberType ScriptProperty -Name Current -Value {
        throw "element unavailable"
    }
    $script:windowPresenceRoots = @($unavailableRoot)
    $unknown = (Get-ImaArticleWindowPresence "brief-0905").State
    return [pscustomobject]@{
        Present = $present
        CaseMismatch = $caseMismatch
        Unknown = $unknown
    }
}
Assert-Equal "Present" $windowPresenceProbe.Present "an exact top-level title proves that the article is open"
Assert-Equal "Absent" $windowPresenceProbe.CaseMismatch "article-window title matching is ordinal and case-sensitive"
Assert-Equal "Unknown" $windowPresenceProbe.Unknown "an unavailable top-level window never proves absence"

$idempotentOpenProbe = & {
    $script:idempotentOpenCacheCalls = 0
    $script:idempotentOpenRootCalls = 0
    $script:idempotentOpenTitleClicks = 0
    function Get-ImaArticleWindowPresence {
        return [pscustomobject]@{ State = "Present"; Root = "existing-root" }
    }
    function Find-ImaArticleWindow {
        return [pscustomobject]@{ Root = "existing-root"; Document = "existing-document" }
    }
    function Set-ImaArticleWindowCache { $script:idempotentOpenCacheCalls++ }
    function Get-ImaRoot {
        $script:idempotentOpenRootCalls++
        return "list-root"
    }
    function Invoke-ImaVisibleListTitle { $script:idempotentOpenTitleClicks++ }
    function Write-SyncLog {}
    $script:CurrentArticleTitle = ""
    Invoke-ImaArticleTitle "brief-0905"
    return [pscustomobject]@{
        CurrentTitle = $script:CurrentArticleTitle
        CacheCalls = $script:idempotentOpenCacheCalls
        RootCalls = $script:idempotentOpenRootCalls
        TitleClicks = $script:idempotentOpenTitleClicks
    }
}
Assert-Equal "brief-0905" $idempotentOpenProbe.CurrentTitle "an already-open title becomes the current article"
Assert-Equal "1" ([string]$idempotentOpenProbe.CacheCalls) "an already-open title refreshes the article-window cache"
Assert-Equal "0" ([string]$idempotentOpenProbe.RootCalls) "an already-open title does not return to the list root"
Assert-Equal "0" ([string]$idempotentOpenProbe.TitleClicks) "an already-open title is not clicked again"

$unknownOpenProbe = & {
    $script:unknownOpenTitleClicks = 0
    function Get-ImaArticleWindowPresence {
        return [pscustomobject]@{ State = "Unknown"; Root = $null }
    }
    function Invoke-ImaVisibleListTitle { $script:unknownOpenTitleClicks++ }
    $threw = $false
    try {
        Invoke-ImaArticleTitle "brief-0905"
    }
    catch {
        $threw = $true
    }
    return [pscustomobject]@{
        Threw = $threw
        TitleClicks = $script:unknownOpenTitleClicks
    }
}
Assert-Equal "True" ([string]$unknownOpenProbe.Threw) "unknown window presence stops title invocation"
Assert-Equal "0" ([string]$unknownOpenProbe.TitleClicks) "unknown window presence never risks a duplicate click"

$uncertainClickProbe = & {
    $script:uncertainTitleClicks = 0
    $script:uncertainScrollerCalls = 0
    function Get-ImaArticleWindowPresence {
        return [pscustomobject]@{ State = "Absent"; Root = $null }
    }
    function Find-ImaArticleWindow { return $null }
    function Clear-ImaBodyScrollerCache {}
    function Clear-ImaArticleWindowCache {}
    function Get-ImaRoot { return "list-root" }
    function Get-ImaVisibleTitleElements {
        return @([pscustomobject]@{ Current = [pscustomobject]@{ Name = "brief-0905" } })
    }
    function Invoke-ImaVisibleListTitle {
        $script:uncertainTitleClicks++
        throw "UIA provider did not acknowledge the invocation"
    }
    function Get-ImaTitleListScroller {
        $script:uncertainScrollerCalls++
        return $null
    }
    $threw = $false
    try {
        Invoke-ImaArticleTitle "brief-0905"
    }
    catch {
        $threw = $true
    }
    return [pscustomobject]@{
        Threw = $threw
        TitleClicks = $script:uncertainTitleClicks
        ScrollerCalls = $script:uncertainScrollerCalls
    }
}
Assert-Equal "True" ([string]$uncertainClickProbe.Threw) "an uncertain title invocation is deferred"
Assert-Equal "1" ([string]$uncertainClickProbe.TitleClicks) "an uncertain title invocation is attempted only once"
Assert-Equal "0" ([string]$uncertainClickProbe.ScrollerCalls) "an uncertain title invocation does not fall through to another click path"

$sameWindowRetryProbe = & {
    $script:retryProbeTitleClicks = 0
    $script:retryProbeReads = 0
    $script:retryProbeWaits = 0
    $script:retryProbeBodyCacheClears = 0
    $script:retryProbeWindowCacheClears = 0
    $script:retryProbeCloseCalls = 0
    $savedSkipTitles = $script:SkipTitles
    $script:SkipTitles = @{}
    function Open-ImaSpeedFolder { return "list-root" }
    function Get-ImaRecentTitles { return @("brief-0905") }
    function Invoke-ImaArticleTitle {
        $script:retryProbeTitleClicks++
        $script:CurrentArticleTitle = $args[0]
    }
    function Wait-ImaDocument {
        $script:retryProbeWaits++
        return "article-document"
    }
    function Get-ImaDocumentText { return "article-document-text" }
    function Get-ImaUpdatedDateFromText { return "2026-09-05" }
    function Read-ImaCompleteArticle {
        $script:retryProbeReads++
        if ($script:retryProbeReads -eq 1) {
            throw "document loading timeout"
        }
        return ("B" * 1100)
    }
    function Clear-ImaBodyScrollerCache { $script:retryProbeBodyCacheClears++ }
    function Clear-ImaArticleWindowCache { $script:retryProbeWindowCacheClears++ }
    function Get-ImaArticleWindowPresence {
        return [pscustomobject]@{ State = "Present"; Root = "article-root" }
    }
    function Start-ImaCancelableSleep {}
    function Close-ImaCurrentArticle {
        $script:retryProbeCloseCalls++
        return $true
    }
    function Test-ImaCancellation {}
    function Write-SyncLog {}
    $result = Invoke-ImaSync
    $script:SkipTitles = $savedSkipTitles
    return [pscustomobject]@{
        TitleClicks = $script:retryProbeTitleClicks
        Reads = $script:retryProbeReads
        Waits = $script:retryProbeWaits
        BodyCacheClears = $script:retryProbeBodyCacheClears
        WindowCacheClears = $script:retryProbeWindowCacheClears
        CloseCalls = $script:retryProbeCloseCalls
        ItemCount = $result.items.Count
        ErrorCount = $result.errors.Count
    }
}
Assert-Equal "1" ([string]$sameWindowRetryProbe.TitleClicks) "a transient body retry clicks the title only once"
Assert-Equal "2" ([string]$sameWindowRetryProbe.Reads) "a transient body error retries the read exactly once"
Assert-Equal "2" ([string]$sameWindowRetryProbe.Waits) "a same-window retry resolves the document again"
Assert-Equal "1" ([string]$sameWindowRetryProbe.BodyCacheClears) "a same-window retry clears the body-scroller cache"
Assert-Equal "1" ([string]$sameWindowRetryProbe.WindowCacheClears) "a same-window retry clears the article-window cache"
Assert-Equal "1" ([string]$sameWindowRetryProbe.CloseCalls) "a successful retry closes only after extraction"
Assert-Equal "1" ([string]$sameWindowRetryProbe.ItemCount) "a successful same-window retry returns the article"
Assert-Equal "0" ([string]$sameWindowRetryProbe.ErrorCount) "a successful same-window retry records no error"

$failedCloseProbe = & {
    $script:failedCloseTitleClicks = 0
    $script:failedCloseReads = 0
    $script:failedCloseCalls = 0
    $savedSkipTitles = $script:SkipTitles
    $script:SkipTitles = @{}
    function Open-ImaSpeedFolder { return "list-root" }
    function Get-ImaRecentTitles { return @("brief-0905") }
    function Invoke-ImaArticleTitle {
        $script:failedCloseTitleClicks++
        $script:CurrentArticleTitle = $args[0]
    }
    function Wait-ImaDocument { return "article-document" }
    function Get-ImaDocumentText { return "article-document-text" }
    function Get-ImaUpdatedDateFromText { return "2026-09-05" }
    function Read-ImaCompleteArticle {
        $script:failedCloseReads++
        throw "document loading timeout"
    }
    function Clear-ImaBodyScrollerCache {}
    function Clear-ImaArticleWindowCache {}
    function Get-ImaArticleWindowPresence {
        return [pscustomobject]@{ State = "Present"; Root = "article-root" }
    }
    function Start-ImaCancelableSleep {}
    function Close-ImaCurrentArticle {
        $script:failedCloseCalls++
        return $false
    }
    function Test-ImaCancellation {}
    function Write-SyncLog {}
    $result = Invoke-ImaSync
    $script:SkipTitles = $savedSkipTitles
    return [pscustomobject]@{
        TitleClicks = $script:failedCloseTitleClicks
        Reads = $script:failedCloseReads
        CloseCalls = $script:failedCloseCalls
        ItemCount = $result.items.Count
        ErrorCount = $result.errors.Count
    }
}
Assert-Equal "1" ([string]$failedCloseProbe.TitleClicks) "a failed close never causes another title click"
Assert-Equal "2" ([string]$failedCloseProbe.Reads) "a persistent transient error still reads at most twice"
Assert-Equal "1" ([string]$failedCloseProbe.CloseCalls) "a persistent error attempts one final close"
Assert-Equal "0" ([string]$failedCloseProbe.ItemCount) "a persistent error returns no article"
Assert-Equal "1" ([string]$failedCloseProbe.ErrorCount) "a persistent error is reported without reopening"

$missingRetryWindowProbe = & {
    $script:missingRetryTitleClicks = 0
    $script:missingRetryReads = 0
    $script:missingRetryWaits = 0
    $script:missingRetryCloseCalls = 0
    $savedSkipTitles = $script:SkipTitles
    $script:SkipTitles = @{}
    function Open-ImaSpeedFolder { return "list-root" }
    function Get-ImaRecentTitles { return @("brief-0905") }
    function Invoke-ImaArticleTitle {
        $script:missingRetryTitleClicks++
        $script:CurrentArticleTitle = $args[0]
    }
    function Wait-ImaDocument {
        $script:missingRetryWaits++
        return "article-document"
    }
    function Get-ImaDocumentText { return "article-document-text" }
    function Get-ImaUpdatedDateFromText { return "2026-09-05" }
    function Read-ImaCompleteArticle {
        $script:missingRetryReads++
        throw "document loading timeout"
    }
    function Clear-ImaBodyScrollerCache {}
    function Clear-ImaArticleWindowCache {}
    function Get-ImaArticleWindowPresence {
        return [pscustomobject]@{ State = "Absent"; Root = $null }
    }
    function Find-ImaArticleWindow { return $null }
    function Start-ImaCancelableSleep {}
    function Close-ImaCurrentArticle {
        $script:missingRetryCloseCalls++
        return $false
    }
    function Test-ImaCancellation {}
    function Write-SyncLog {}
    $result = Invoke-ImaSync
    $script:SkipTitles = $savedSkipTitles
    return [pscustomobject]@{
        TitleClicks = $script:missingRetryTitleClicks
        Reads = $script:missingRetryReads
        Waits = $script:missingRetryWaits
        CloseCalls = $script:missingRetryCloseCalls
        ErrorMessage = [string]$result.errors[0].message
    }
}
Assert-Equal "1" ([string]$missingRetryWindowProbe.TitleClicks) "a vanished retry window is not reopened"
Assert-Equal "1" ([string]$missingRetryWindowProbe.Reads) "a vanished retry window is not read through a new article"
Assert-Equal "1" ([string]$missingRetryWindowProbe.Waits) "a vanished retry window does not wait for a replacement document"
Assert-Equal "1" ([string]$missingRetryWindowProbe.CloseCalls) "a vanished retry window still performs only final cleanup"
Assert-Equal "True" ([string]$missingRetryWindowProbe.ErrorMessage.Contains("本轮不重新打开")) "a vanished retry window is deferred to a later sync"

$articleRootDescriptors = @(
    [pscustomobject]@{ Name = "IMA main"; Id = "main"; OriginalIndex = 0 },
    [pscustomobject]@{ Name = "brief-0904"; Id = "article-first"; OriginalIndex = 1 },
    [pscustomobject]@{ Name = "other window"; Id = "other"; OriginalIndex = 2 },
    [pscustomobject]@{ Name = "brief-0904"; Id = "article-second"; OriginalIndex = 3 }
)
$preferredArticleRoots = @(Select-ImaArticleRootDescriptors $articleRootDescriptors "brief-0904")
Assert-Equal "article-first|article-second" (($preferredArticleRoots | ForEach-Object { $_.Id }) -join "|") "exact top-level article roots exclude the large main window"
$fallbackArticleRoots = @(Select-ImaArticleRootDescriptors $articleRootDescriptors "missing-title")
Assert-Equal "main|article-first|other|article-second" (($fallbackArticleRoots | ForEach-Object { $_.Id }) -join "|") "compatibility fallback preserves top-level root order"

$documentRectangle = [pscustomobject]@{ X = 400.0; Y = 100.0; Width = 800.0; Height = 700.0 }
$ancestorScroller = [pscustomobject]@{
    Name = "ancestor"; Pattern = "ancestor-pattern"
    Rectangle = [pscustomobject]@{ X = 380.0; Y = 80.0; Width = 850.0; Height = 750.0 }
    IsAncestor = $true; IsDocumentDescendant = $false; IsDomScrollContent = $false
    IsOffscreen = $false; VerticallyScrollable = $true; IsTitleList = $false
}
$bodyFallbackLarge = [pscustomobject]@{
    Name = "body-large"; Pattern = "body-large-pattern"
    Rectangle = [pscustomobject]@{ X = 390.0; Y = 90.0; Width = 830.0; Height = 730.0 }
    IsAncestor = $false; IsDocumentDescendant = $false; IsDomScrollContent = $false
    IsOffscreen = $false; VerticallyScrollable = $true; IsTitleList = $false
}
$bodyFallbackSmall = [pscustomobject]@{
    Name = "body-small"; Pattern = "body-small-pattern"
    Rectangle = [pscustomobject]@{ X = 410.0; Y = 110.0; Width = 760.0; Height = 660.0 }
    IsAncestor = $false; IsDocumentDescendant = $false; IsDomScrollContent = $false
    IsOffscreen = $false; VerticallyScrollable = $true; IsTitleList = $false
}
$titleListScroller = [pscustomobject]@{
    Name = "title-list"; Pattern = "list-pattern"
    Rectangle = [pscustomobject]@{ X = 400.0; Y = 100.0; Width = 500.0; Height = 650.0 }
    IsAncestor = $false; IsDocumentDescendant = $false; IsDomScrollContent = $false
    IsOffscreen = $false; VerticallyScrollable = $true; IsTitleList = $true
}
$unrelatedScroller = [pscustomobject]@{
    Name = "unrelated"; Pattern = "unrelated-pattern"
    Rectangle = [pscustomobject]@{ X = 0.0; Y = 0.0; Width = 300.0; Height = 600.0 }
    IsAncestor = $false; IsDocumentDescendant = $false; IsDomScrollContent = $false
    IsOffscreen = $false; VerticallyScrollable = $true; IsTitleList = $false
}
$domScrollContent = [pscustomobject]@{
    Name = "dom-scroll-content"; Pattern = "dom-pattern"
    Rectangle = [pscustomobject]@{ X = 395.0; Y = 95.0; Width = 810.0; Height = 710.0 }
    IsAncestor = $false; IsDocumentDescendant = $true; IsDomScrollContent = $true
    IsOffscreen = $false; VerticallyScrollable = $true; IsTitleList = $false
}
$genericDocumentScroller = [pscustomobject]@{
    Name = "generic-document-child"; Pattern = "generic-document-pattern"
    Rectangle = [pscustomobject]@{ X = 410.0; Y = 110.0; Width = 760.0; Height = 660.0 }
    IsAncestor = $false; IsDocumentDescendant = $true; IsDomScrollContent = $false
    IsOffscreen = $false; VerticallyScrollable = $true; IsTitleList = $false
}
$selectedAncestor = Select-ImaBodyScrollerCandidate @($bodyFallbackSmall, $ancestorScroller) $documentRectangle
Assert-Equal "ancestor" $selectedAncestor.Name "document ancestor scroller has priority"
$selectedFallback = Select-ImaBodyScrollerCandidate @($titleListScroller, $bodyFallbackLarge, $unrelatedScroller, $bodyFallbackSmall) $documentRectangle
Assert-Equal "body-small" $selectedFallback.Name "geometry fallback excludes title list and unrelated scrollers"
Assert-Equal "body-small-pattern" $selectedFallback.Pattern "geometry fallback returns the selected body pattern"
$selectedLargeOnly = Select-ImaBodyScrollerCandidate @($titleListScroller, $bodyFallbackLarge) $documentRectangle
Assert-Equal "body-large" $selectedLargeOnly.Name "valid body fallback remains available when no ancestor exists"
$selectedDomScroller = Select-ImaBodyScrollerCandidate @($bodyFallbackSmall, $genericDocumentScroller, $domScrollContent) $documentRectangle
Assert-Equal "dom-scroll-content" $selectedDomScroller.Name "known document descendant body scroller has priority"
$selectedAncestorOverDom = Select-ImaBodyScrollerCandidate @($domScrollContent, $ancestorScroller) $documentRectangle
Assert-Equal "ancestor" $selectedAncestorOverDom.Name "ancestor still has priority over known descendant scroller"
$trustedDomWithUnreliableGeometry = [pscustomobject]@{
    Name = "dom-trusted"; Pattern = "dom-trusted-pattern"
    Rectangle = [pscustomobject]@{ X = 0.0; Y = 0.0; Width = 0.0; Height = 0.0 }
    IsAncestor = $false; IsDocumentDescendant = $true; IsDomScrollContent = $true
    IsOffscreen = $true; VerticallyScrollable = $true; IsTitleList = $false
}
$selectedTrustedDom = Select-ImaKnownBodyScrollerCandidate @($trustedDomWithUnreliableGeometry)
Assert-Equal "dom-trusted" $selectedTrustedDom.Name "exact dom-scroll-content binding does not depend on unreliable Chromium geometry"
Assert-Equal "True" ([string]($null -eq (Select-ImaKnownBodyScrollerCandidate @()))) "known body-scroller selector handles an empty candidate set"

$resolverFailureState = Get-ImaBodyScrollerReadinessState { throw "SCROLLER_DIAGNOSTIC_SENTINEL" }
Assert-Equal "False" ([string]$resolverFailureState.Ready) "body-scroller resolver failure keeps readiness false"
Assert-Equal "True" ([string]$resolverFailureState.Reason.Contains("SCROLLER_DIAGNOSTIC_SENTINEL")) "body-scroller readiness preserves the resolver error"
$resolverFailureTracker = New-ImaArticleStabilityTracker ([datetime]"2026-09-04T00:00:00Z")
[void](Update-ImaArticleStabilityTracker $resolverFailureTracker $resolverFailureState "" ([datetime]"2026-09-04T00:00:01Z"))
Assert-Equal "True" ([string]$resolverFailureTracker.LastReason.Contains("SCROLLER_DIAGNOSTIC_SENTINEL")) "article wait tracker retains the body-scroller resolver error"

$script:BodyScrollerCache = @{}
$sameArticleCacheKey = Get-ImaBodyScrollerCacheKey "brief-0904" 42 1001 "7.8.9"
$sameArticleCacheKeyAgain = Get-ImaBodyScrollerCacheKey "brief-0904" 42 1001 "7.8.9"
$otherDocumentCacheKey = Get-ImaBodyScrollerCacheKey "brief-0904" 42 1001 "7.8.10"
Assert-Equal $sameArticleCacheKey $sameArticleCacheKeyAgain "body-scroller cache key is stable for the same article document"
Assert-Equal "False" ([string]($sameArticleCacheKey -ceq $otherDocumentCacheKey)) "body-scroller cache key distinguishes a rebuilt document"
$script:bodyScrollerResolverCount = 0
$script:bodyScrollerValidatorCount = 0
$script:bodyScrollerEntryGeneration = 0
$bodyScrollerResolver = {
    [void]($script:bodyScrollerResolverCount++)
    [void]($script:bodyScrollerEntryGeneration++)
    return [pscustomobject]@{
        Generation = $script:bodyScrollerEntryGeneration
        Element = "element-$($script:bodyScrollerEntryGeneration)"
        Pattern = "pattern-$($script:bodyScrollerEntryGeneration)"
    }
}
$bodyScrollerValidator = {
    param($Entry)
    [void]($script:bodyScrollerValidatorCount++)
    return $true
}
$firstCachedScroller = Get-ImaCachedBodyScrollerEntry $sameArticleCacheKey $bodyScrollerResolver $bodyScrollerValidator
$secondCachedScroller = Get-ImaCachedBodyScrollerEntry $sameArticleCacheKey $bodyScrollerResolver $bodyScrollerValidator
Assert-Equal "1" ([string]$script:bodyScrollerResolverCount) "consecutive snapshots of one article resolve the body scroller once"
Assert-Equal "True" ([string][object]::ReferenceEquals($firstCachedScroller, $secondCachedScroller)) "consecutive snapshots reuse the same cached scroller entry"

Add-Type -AssemblyName UIAutomationTypes
$staleValidator = {
    param($Entry)
    throw (New-Object Windows.Automation.ElementNotAvailableException)
}
$refreshedScroller = Get-ImaCachedBodyScrollerEntry $sameArticleCacheKey $bodyScrollerResolver $staleValidator
Assert-Equal "2" ([string]$script:bodyScrollerResolverCount) "stale body scroller is cleared and resolved again in the same call"
Assert-Equal "2" ([string]$refreshedScroller.Generation) "stale cache refresh returns the new body-scroller entry"

$otherTitleCacheKey = Get-ImaBodyScrollerCacheKey "brief-0903" 42 1002 "1.2.3"
$script:BodyScrollerCache[$otherTitleCacheKey] = [pscustomobject]@{ Element = "other"; Pattern = "other" }
Clear-ImaBodyScrollerCache "brief-0904"
Assert-Equal "False" ([string]$script:BodyScrollerCache.ContainsKey($sameArticleCacheKey)) "clearing an article removes only its body-scroller cache entry"
Assert-Equal "True" ([string]$script:BodyScrollerCache.ContainsKey($otherTitleCacheKey)) "clearing an article preserves another article cache entry"

$script:ArticleWindowCache = @{}
$script:articleWindowResolverCount = 0
$script:articleWindowGeneration = 0
$articleWindowResolver = {
    [void]($script:articleWindowResolverCount++)
    [void]($script:articleWindowGeneration++)
    return [pscustomobject]@{
        Root = "root-$($script:articleWindowGeneration)"
        Document = "document-$($script:articleWindowGeneration)"
        Generation = $script:articleWindowGeneration
    }
}
$validArticleWindow = { param($Entry) return $true }
$firstArticleWindow = Get-ImaCachedArticleWindowEntry "brief-0904" $articleWindowResolver $validArticleWindow
$secondArticleWindow = Get-ImaCachedArticleWindowEntry "brief-0904" $articleWindowResolver $validArticleWindow
Assert-Equal "1" ([string]$script:articleWindowResolverCount) "consecutive viewport snapshots find the article window only once"
Assert-Equal "True" ([string][object]::ReferenceEquals($firstArticleWindow, $secondArticleWindow)) "consecutive viewport snapshots reuse the cached Root and Document"
$staleArticleWindow = {
    param($Entry)
    throw (New-Object Windows.Automation.ElementNotAvailableException)
}
$refreshedArticleWindow = Get-ImaCachedArticleWindowEntry "brief-0904" $articleWindowResolver $staleArticleWindow
Assert-Equal "2" ([string]$script:articleWindowResolverCount) "stale article window cache re-runs the finder in the same call"
Assert-Equal "2" ([string]$refreshedArticleWindow.Generation) "stale article window cache returns the refreshed Root and Document"
$unexpectedArticleWindowValidator = {
    param($Entry)
    throw (New-Object ApplicationException -ArgumentList "ARTICLE_WINDOW_UNEXPECTED")
}
Assert-Throws {
    Get-ImaCachedArticleWindowEntry "brief-0904" $articleWindowResolver $unexpectedArticleWindowValidator
} "unexpected article-window validation error is not swallowed"
Assert-Equal "2" ([string]$script:articleWindowResolverCount) "unexpected cache validation error does not invoke the resolver"

$fastResolverPosition = $scriptSource.IndexOf('$knownScroller = Get-ImaKnownBodyScrollerCandidate', [StringComparison]::Ordinal)
$titleListFallbackPosition = $scriptSource.IndexOf('$titleListElement = Get-ImaTitleListElement $Root', [StringComparison]::Ordinal)
Assert-Equal "True" ([string]($fastResolverPosition -ge 0 -and $fastResolverPosition -lt $titleListFallbackPosition)) "known body-scroller fast path precedes expensive title-list and tree fallbacks"
Assert-Equal "True" ([string]($scriptSource.IndexOf('Resolution = "dom-scroll-content"', [StringComparison]::Ordinal) -ge 0)) "known body scroller records its fast-path resolution"
$readinessCacheCall = 'Get-ImaBodyScroller' + ' $bodyRoot $bodyDocument'
Assert-Equal "True" ([string]($scriptSource.Contains($readinessCacheCall))) "article readiness seeds the shared body-scroller cache"
Assert-Equal "True" ([string]($scriptSource.Contains('$articleWindow = Get-ImaArticleWindow $Title'))) "viewport snapshots use the cached article window"

Assert-Equal "Test knowledge base" $script:KnowledgeBaseName "knowledge-base setting"
Assert-Equal "Test folder" $script:FolderName "folder setting"
Assert-Equal "^brief-\d{4}$" $script:TitlePattern "custom title pattern"
Assert-Equal "2" ([string]$script:SkipTitles.Count) "PowerShell 5.1 decodes every skipped title"
Assert-Equal "True" ([string]$script:SkipTitles.ContainsKey("brief-0810")) "decoded skipped title is individually addressable"

$inputPath = [IO.Path]::GetTempFileName()
[IO.File]::WriteAllText($inputPath, '{"skipTitles":["from-file","second-file"]}', (New-Object Text.UTF8Encoding($false)))
$InputPath = $inputPath
Initialize-ImaInput
Assert-Equal "2" ([string]$script:SkipTitles.Count) "input JSON title count"
Assert-Equal "True" ([string]$script:SkipTitles.ContainsKey("from-file")) "input JSON takes precedence over base64"
[IO.File]::Delete($inputPath)
$InputPath = ""
Initialize-ImaInput

$outputPath = [IO.Path]::GetTempFileName()
$OutputPath = $outputPath
$outputStdout = Write-ImaResult ([pscustomobject]@{ busy = $false; canceled = $true; items = @([pscustomobject]@{ sourceTitle = "done" }); errors = @(); skippedTitles = @() })
$outputObject = [IO.File]::ReadAllText($outputPath, (New-Object Text.UTF8Encoding($false))) | ConvertFrom-Json
Assert-Equal "True" ([string]$outputObject.canceled) "output JSON records cancellation"
Assert-Equal "done" ([string]$outputObject.items[0].sourceTitle) "output JSON retains completed items on cancellation"
Assert-Equal '{"outputWritten":true}' ([string]$outputStdout) "output-file mode keeps stdout bounded"
[IO.File]::Delete($outputPath)
$OutputPath = ""
$legacyResult = [pscustomobject]@{ busy = $false; canceled = $false; items = @(); errors = @(); skippedTitles = @() }
Assert-Equal (ConvertTo-ImaResultJson $legacyResult) ([string](Write-ImaResult $legacyResult)) "legacy mode keeps full stdout JSON"

$logPath = [IO.Path]::GetTempFileName()
[IO.File]::WriteAllText($logPath, "123456", (New-Object Text.UTF8Encoding($false)))
Assert-Equal "True" ([string](Rotate-ImaLogIfNeeded $logPath 5)) "oversized log rotates"
Assert-Equal "True" ([string]([IO.File]::Exists("$logPath.1"))) "rotated log backup exists"
[IO.File]::Delete("$logPath.1")

function Write-SyncLog {}
$mutexName = "Local\ImaSpeedSyncTest-$([guid]::NewGuid().ToString('N'))"
$childCode = @"
`$mutex = New-Object Threading.Mutex(`$false, '$mutexName')
[void]`$mutex.WaitOne()
[Console]::Out.WriteLine('LOCKED')
[Console]::Out.Flush()
Start-Sleep -Seconds 30
"@
$encodedChildCode = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCode))
$startInfo = New-Object Diagnostics.ProcessStartInfo
$startInfo.FileName = (Get-Command powershell.exe).Source
$startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedChildCode"
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$child = [Diagnostics.Process]::Start($startInfo)
try {
    $readyTask = $child.StandardOutput.ReadLineAsync()
    if (-not $readyTask.Wait(5000)) {
        throw "abandoned mutex child did not acquire the mutex"
    }
    Assert-Equal "LOCKED" $readyTask.Result "child process owns named mutex"
    # Keep a second process handle open before killing the owner, otherwise Windows
    # may destroy and recreate the named mutex instead of reporting abandonment.
    $recoveredMutex = New-Object Threading.Mutex($false, $mutexName)
    $child.Kill()
    $child.WaitForExit()

    $recovered = $false
    try {
        $recovered = Enter-ImaMutex $recoveredMutex
        Assert-Equal "True" ([string]$recovered) "abandoned named mutex is treated as acquired"
        Assert-Equal "True" ([string]$script:LastMutexWasAbandoned) "abandoned named mutex follows recovery path"
    }
    finally {
        if ($recovered) {
            $recoveredMutex.ReleaseMutex()
        }
        $recoveredMutex.Dispose()
    }

    $probeMutex = New-Object Threading.Mutex($false, $mutexName)
    $probeAcquired = $probeMutex.WaitOne(0)
    try {
        Assert-Equal "True" ([string]$probeAcquired) "recovered mutex ownership is released"
    }
    finally {
        if ($probeAcquired) {
            $probeMutex.ReleaseMutex()
        }
        $probeMutex.Dispose()
    }
}
finally {
    if (-not $child.HasExited) {
        $child.Kill()
        $child.WaitForExit()
    }
    $child.Dispose()
}

Assert-Equal "True" ([string]($scriptSource -match 'attempt -lt 90')) "IMA cold start waits for main window"
$openSpeedFolderSource = [regex]::Match(
    $scriptSource,
    'function Open-ImaSpeedFolder \{(?s:.*?)\r?\n\}'
).Value
Assert-Equal "True" ([string]($openSpeedFolderSource -match 'Wait-ImaText\s+"')) "startup waits for knowledge-base navigation"
Assert-Equal "True" ([string]($scriptSource.Contains('Wait-ImaText $script:KnowledgeBaseName'))) "startup waits for configured knowledge base"
Assert-Equal "True" ([string]($scriptSource.Contains('function Close-ImaApplication'))) "application close function exists"
Assert-Equal "True" ([string]($scriptSource.Contains('[Windows.Automation.AutomationElement]::AutomationIdProperty'))) "application close uses automation id"
Assert-Equal "True" ([string]($scriptSource.Contains('"view_4"'))) "application close targets title-bar close button"
Assert-Equal "True" ([string]($scriptSource.Contains('if ($syncStarted)'))) "application closes only after a started sync"
Assert-Equal "True" ([string]($scriptSource.Contains('$script:SkipTitles.ContainsKey($title)'))) "known titles are skipped before extraction"
Assert-Equal "True" ([string]($scriptSource.Contains('function Find-ImaArticleWindow'))) "article document search covers every IMA top-level window"
Assert-Equal "True" ([string]($scriptSource.Contains('function Merge-ImaTextWindowsAcrossScrollRange'))) "long sections fill virtualized gaps with intermediate windows"
Assert-Equal "True" ([string]($scriptSource.Contains('Sort-Object -Property ScrollPercent, OriginalIndex'))) "table-of-contents items are ordered by document position"
Assert-Equal "True" ([string]($scriptSource.Contains('function Get-ImaTitleListElement'))) "article titles are scoped to the configured list container"
Assert-Equal "True" ([string]($scriptSource.Contains('function Wait-ImaTitleListStable'))) "article list waits for a stable render"
$visibleTitleFunctionSource = [regex]::Match(
    $scriptSource,
    'function Get-ImaVisibleTitleSnapshot\((?s:.*?)\r?\n\}'
).Value
Assert-Equal "True" ([string]($visibleTitleFunctionSource.Contains('Windows.Automation.PropertyCondition'))) "visible-title enumeration uses a UIA property filter"
Assert-Equal "True" ([string]($visibleTitleFunctionSource.Contains('$textCondition'))) "visible-title enumeration requests only Text controls"
Assert-Equal "False" ([string]($visibleTitleFunctionSource.Contains('[Windows.Automation.Condition]::TrueCondition'))) "visible-title enumeration no longer materializes every descendant"
$recentTitlesFunctionSource = [regex]::Match(
    $scriptSource,
    'function Get-ImaRecentTitles\((?s:.*?)(?=\r?\nfunction )'
).Value
Assert-Equal "True" ([string]($recentTitlesFunctionSource.Contains('Test-ImaShouldSkipTitleListRestore'))) "recent-title scan can skip a redundant final reset"
Assert-Equal "True" ([string]($recentTitlesFunctionSource.Contains('if ($titles.Count -ge $Limit)'))) "recent-title scan stops when the complete current page satisfies the configured count"
Assert-Equal "True" ([string]($recentTitlesFunctionSource.Contains('if ($page -eq 0)'))) "recent-title scan has a distinct first-page fast path"
$selectRecentFunctionSource = [regex]::Match(
    $scriptSource,
    'function Select-ImaRecentTitles\((?s:.*?)(?=\r?\nfunction )'
).Value
Assert-Equal "True" ([string]($selectRecentFunctionSource.IndexOf('$topCandidates = @($records | Select-Object -First $Limit)', [StringComparison]::Ordinal) -lt $selectRecentFunctionSource.IndexOf('Sort-ImaTitleRecords $topCandidates', [StringComparison]::Ordinal))) "recent-title scan fixes top IMA candidates before sorting their title dates"
Assert-Equal "True" ([string]($scriptSource.Contains('function Get-ImaTitleListScrollCandidate'))) "title-list scroller has a bounded ancestor fast path"
Assert-Equal "True" ([string]($scriptSource.Contains('$all = $Root.FindAll('))) "title-list scroller retains a compatibility fallback"
Assert-Equal "True" ([string]($scriptSource.Contains('function Get-ImaRawDocumentText'))) "article document supports stable raw-text probes"
Assert-Equal "True" ([string]($scriptSource.Contains('function Invoke-ImaTocItem'))) "table-of-contents entries retain their UI identity"
Assert-Equal "True" ([string]($scriptSource.Contains('$script:CompletedItems.ToArray()'))) "top-level cancellation result retains completed items"
Assert-Equal "True" ([string]($scriptSource.Contains('[IO.File]::Replace($temporaryPath, $OutputPath, $backupPath)'))) "result file replacement is atomic"
Assert-Equal "True" ([string]($scriptSource -match '(?s)function Wait-ImaArticleStable\(\s*\[string\]\$Title,\s*\[int\]\$TimeoutMilliseconds = 90000')) "article structure wait defaults to 90 seconds"
Assert-Equal "True" ([string]($scriptSource -match 'function Wait-ImaDocument\(\[string\]\$Title, \[int\]\$TimeoutMilliseconds = 90000')) "document wait forwards a 90-second default"

$script:titleResetMoves = New-Object Collections.Generic.Queue[bool]
foreach ($movement in @($true, $true, $true, $true, $true, $true, $true, $true, $true, $true, $true, $true, $false, $false)) {
    $script:titleResetMoves.Enqueue($movement)
}
function Invoke-ImaTitleListMouseWheel {
    if ($script:titleResetMoves.Count -eq 0) {
        return $false
    }
    return $script:titleResetMoves.Dequeue()
}
Assert-Equal "True" ([string](Test-ImaTitleListScrollPercentAtTop 0)) "zero-percent title list is confirmed at top"
Assert-Equal "True" ([string](Test-ImaTitleListScrollPercentAtTop 0.1)) "small valid title-list tolerance is confirmed at top"
Assert-Equal "False" ([string](Test-ImaTitleListScrollPercentAtTop 0.11)) "title-list position beyond tolerance is not top"
Assert-Equal "False" ([string](Test-ImaTitleListScrollPercentAtTop ([double]::NaN))) "unknown title-list position is not top"
Assert-Equal "False" ([string](Test-ImaShouldSkipTitleListRestore $false 0 25)) "stale movement detection cannot skip restore after leaving the top"
Assert-Equal "True" ([string](Test-ImaShouldSkipTitleListRestore $false -1 0.05)) "unmoved scan currently at top skips final reset"
Assert-Equal "False" ([string](Test-ImaShouldSkipTitleListRestore $true 0 0)) "moved scan still restores the title list"

$script:titleResetMoves = New-Object Collections.Generic.Queue[bool]
$script:titleResetMoves.Enqueue($true)
$fastResetTarget = [pscustomobject]@{
    RangePattern = $null
    Pattern = [pscustomobject]@{ Current = [pscustomobject]@{ VerticalScrollPercent = 0.05 } }
}
$script:CurrentTitleScrollStep = 99
Reset-ImaTitleListToTop $fastResetTarget
Assert-Equal "0" ([string]$script:CurrentTitleScrollStep) "non-thorough reset accepts an already confirmed top position"
Assert-Equal "1" ([string]$script:titleResetMoves.Count) "confirmed top fast path avoids expensive mouse-wheel signatures"

Add-Type -AssemblyName UIAutomationClient
$directPercentPattern = [pscustomobject]@{
    Current = [pscustomobject]@{ VerticalScrollPercent = 75.0 }
}
$directPercentPattern | Add-Member -MemberType ScriptMethod -Name SetScrollPercent -Value {
    param($HorizontalPercent, $VerticalPercent)
    $this.Current.VerticalScrollPercent = [double]$VerticalPercent
}
$directPercentTarget = [pscustomobject]@{
    RangePattern = $null
    Pattern = $directPercentPattern
}
$script:CurrentTitleScrollStep = 75
Reset-ImaTitleListToTop $directPercentTarget
Assert-Equal "0" ([string][int]$directPercentPattern.Current.VerticalScrollPercent) "known ScrollPattern position jumps directly to the top"
Assert-Equal "0" ([string]$script:CurrentTitleScrollStep) "verified direct ScrollPattern reset records step zero"
Assert-Equal "1" ([string]$script:titleResetMoves.Count) "verified direct ScrollPattern reset avoids mouse-wheel pagination"

$resetTarget = [pscustomobject]@{ RangePattern = $null }
$script:CurrentTitleScrollStep = 99
Reset-ImaTitleListToTop $resetTarget
Assert-Equal "0" ([string]$script:CurrentTitleScrollStep) "no-range reset confirms top after consecutive stalls"
Assert-Equal "0" ([string]$script:titleResetMoves.Count) "no-range reset is not capped by small MaxItems behavior"

$script:titleResetMoves = New-Object Collections.Generic.Queue[bool]
for ($moveIndex = 0; $moveIndex -lt 120; $moveIndex++) {
    $script:titleResetMoves.Enqueue($true)
}
$script:CurrentTitleScrollStep = 17
Assert-Throws { Reset-ImaTitleListToTop $resetTarget } "unconfirmed no-range reset fails closed"
Assert-Equal "17" ([string]$script:CurrentTitleScrollStep) "unconfirmed no-range reset does not claim step zero"

$rangePattern = [pscustomobject]@{
    Current = [pscustomobject]@{ Minimum = 0.0; Maximum = 100.0; Value = 75.0 }
}
$rangePattern | Add-Member -MemberType ScriptMethod -Name SetValue -Value {
    param($Value)
    $this.Current.Value = [double]$Value
}
$rangeTarget = [pscustomobject]@{
    RangePattern = $rangePattern
    Pattern = [pscustomobject]@{ Current = [pscustomobject]@{ VerticalScrollPercent = -1.0 } }
}
$script:CurrentTitleScrollStep = 8
Reset-ImaTitleListToTop $rangeTarget
Assert-Equal "0" ([string][int]$rangePattern.Current.Value) "range reset verifies its authoritative minimum value"
Assert-Equal "0" ([string]$script:CurrentTitleScrollStep) "verified range reset records step zero"

$stuckRangePattern = [pscustomobject]@{
    Current = [pscustomobject]@{ Minimum = 0.0; Maximum = 100.0; Value = 75.0 }
}
$stuckRangePattern | Add-Member -MemberType ScriptMethod -Name SetValue -Value { param($Value) }
$stuckRangeTarget = [pscustomobject]@{
    RangePattern = $stuckRangePattern
    Pattern = [pscustomobject]@{ Current = [pscustomobject]@{ VerticalScrollPercent = -1.0 } }
}
$script:CurrentTitleScrollStep = 8
Assert-Throws { Reset-ImaTitleListToTop $stuckRangeTarget } "range reset cannot treat unknown outer percent as proof"
Assert-Equal "8" ([string]$script:CurrentTitleScrollStep) "failed range reset does not record step zero"

$script:delayedViewportCall = 0
function Get-ImaViewportSnapshot {
    $script:delayedViewportCall++
    $isUpdated = $script:delayedViewportCall -ge 3
    return [pscustomobject]@{
        Document = "document"
        Text = if ($isUpdated) { "Target viewport" } else { "Old viewport" }
        Signature = if ($isUpdated) { "new-signature" } else { "old-signature" }
        ScrollPercent = 50.0
        ViewSize = 10.0
        Scroller = $null
    }
}
$delayedViewport = Wait-ImaViewportStable "brief-0810" 50 "Target" "old-signature" 0 1000 0 1 0
Assert-Equal "new-signature" $delayedViewport.Signature "viewport wait ignores delayed stale text"
Assert-Equal "4" ([string]$script:delayedViewportCall) "viewport wait requires updated content to become stable"

$script:duplicateViewportCall = 0
function Get-ImaViewportSnapshot {
    $script:duplicateViewportCall++
    $isUpdated = $script:duplicateViewportCall -ge 3
    return [pscustomobject]@{
        Document = "document"
        Text = if ($isUpdated) { "Repeated heading`nSecond body" } else { "Repeated heading`nFirst body" }
        Signature = if ($isUpdated) { "duplicate-new" } else { "duplicate-old" }
        ScrollPercent = if ($isUpdated) { 60.0 } else { 10.0 }
        ViewSize = 10.0
        Scroller = $null
    }
}
$duplicateViewport = Wait-ImaViewportStable "brief-0810" -1 "Repeated heading" "duplicate-old" 10 1000 0 1 0
Assert-Equal "duplicate-new" $duplicateViewport.Signature "duplicate TOC title waits for its clicked occurrence"
Assert-Equal "60" ([string][int]$duplicateViewport.ScrollPercent) "duplicate TOC title observes the new scroll position"
Assert-Equal "4" ([string]$script:duplicateViewportCall) "duplicate TOC delayed jump becomes stable before return"

$script:slowViewportCall = 0
function Get-ImaViewportSnapshot {
    $script:slowViewportCall++
    Start-Sleep -Milliseconds 40
    return [pscustomobject]@{
        Document = "slow-document"
        Text = "Slow target viewport"
        Signature = "slow-valid-signature"
        ScrollPercent = 50.0
        ViewSize = 10.0
        Scroller = $null
    }
}
$slowViewport = Wait-ImaViewportStable "brief-0810" 50 "Slow target" "old-signature" 0 5 10 2 0
Assert-Equal "slow-valid-signature" $slowViewport.Signature "a valid slow snapshot is accepted even when it returns after the deadline"
Assert-Equal "1" ([string]$script:slowViewportCall) "a slow valid snapshot is not discarded for missing extra polling samples"

function Get-ImaViewportSnapshot {
    throw (New-Object ApplicationException -ArgumentList "VIEWPORT_UNEXPECTED")
}
Assert-Throws {
    Wait-ImaViewportStable "brief-0810" -1 "" "" -1 100 0 0 0
} "unexpected viewport errors are not swallowed"

$trackerStart = [datetime]"2026-09-04T00:00:00Z"
$flappingTracker = New-ImaArticleStabilityTracker $trackerStart
[void](Update-ImaArticleStabilityTracker $flappingTracker ([pscustomobject]@{ Ready = $true; TocCount = 28 }) "" $trackerStart)
[void](Update-ImaArticleStabilityTracker $flappingTracker ([pscustomobject]@{ Ready = $true; TocCount = 27 }) "" $trackerStart.AddMilliseconds(100))
[void](Update-ImaArticleStabilityTracker $flappingTracker $null "ElementNotAvailable" $trackerStart.AddMilliseconds(200))
[void](Update-ImaArticleStabilityTracker $flappingTracker ([pscustomobject]@{ Ready = $true; TocCount = 28 }) "" $trackerStart.AddMilliseconds(300))
[void](Update-ImaArticleStabilityTracker $flappingTracker ([pscustomobject]@{ Ready = $true; TocCount = 28 }) "" $trackerStart.AddMilliseconds(400))
Assert-Equal "28" ([string]$flappingTracker.MaximumTocCount) "TOC high-water mark survives a 28-27-28 fluctuation"
Assert-Equal "3" ([string]$flappingTracker.MaximumCountSamples) "maximum TOC samples accumulate across transient failures"
Assert-Equal "2" ([string]$flappingTracker.TemporaryFailures) "lower counts and UIA exceptions remain diagnostic failures"
Assert-Equal "True" ([string](Test-ImaArticleStabilityReady $flappingTracker $trackerStart.AddMilliseconds(500) 0 200 3)) "intermittent lower count and exception do not prevent readiness"

$growthTracker = New-ImaArticleStabilityTracker $trackerStart
foreach ($offset in @(0, 100, 200)) {
    [void](Update-ImaArticleStabilityTracker $growthTracker ([pscustomobject]@{ Ready = $true; TocCount = 28 }) "" $trackerStart.AddMilliseconds($offset))
}
[void](Update-ImaArticleStabilityTracker $growthTracker ([pscustomobject]@{ Ready = $true; TocCount = 29 }) "" $trackerStart.AddMilliseconds(1000))
Assert-Equal "1" ([string]$growthTracker.MaximumCountSamples) "new TOC maximum resets high-water samples"
Assert-Equal "False" ([string](Test-ImaArticleStabilityReady $growthTracker $trackerStart.AddMilliseconds(1100) 0 500 3)) "TOC growth resets the quiet period"
[void](Update-ImaArticleStabilityTracker $growthTracker ([pscustomobject]@{ Ready = $true; TocCount = 28 }) "" $trackerStart.AddMilliseconds(1200))
Assert-Equal "False" ([string](Test-ImaArticleStabilityReady $growthTracker $trackerStart.AddMilliseconds(2000) 0 500 3)) "current lower count cannot complete a newer high-water mark"
[void](Update-ImaArticleStabilityTracker $growthTracker ([pscustomobject]@{ Ready = $true; TocCount = 29 }) "" $trackerStart.AddMilliseconds(2100))
[void](Update-ImaArticleStabilityTracker $growthTracker ([pscustomobject]@{ Ready = $true; TocCount = 29 }) "" $trackerStart.AddMilliseconds(2200))
Assert-Equal "True" ([string](Test-ImaArticleStabilityReady $growthTracker $trackerStart.AddMilliseconds(2300) 0 500 3)) "new TOC maximum completes after enough maximum samples and quiet time"
$diagnosticTracker = [pscustomobject]@{
    MaximumTocCount = 28
    CurrentTocCount = 27
    MaximumCountSamples = 4
    TemporaryFailures = 2
    LastReason = "still loading"
}
$diagnosticText = Format-ImaArticleStabilityTimeout "brief-0904" $diagnosticTracker
Assert-Equal "True" ([string]($diagnosticText -match 'brief-0904.*28.*27.*4.*2.*still loading')) "article timeout diagnostic formats every runtime value"
Assert-Equal "False" ([string]$diagnosticText.Contains('{0}')) "article timeout diagnostic leaves no format placeholders"

$script:articleStableProbeCall = 0
function Find-ImaArticleWindow {
    return [pscustomobject]@{ Root = "article-root"; Document = "article-document" }
}
function Get-ImaDocumentReadinessProbe {
    $script:articleStableProbeCall++
    $signature = if ($script:articleStableProbeCall -le 2) { "toc-partial" } else { "toc-complete" }
    return [pscustomobject]@{ Ready = $true; Signature = $signature; Reason = ""; TocCount = if ($signature -eq "toc-partial") { 16 } else { 53 } }
}
$stableArticle = Wait-ImaArticleStable "brief-0810" 1000 0 0 3 0
Assert-Equal "53" ([string]$stableArticle.TocCount) "article stability waits through asynchronous TOC growth"
Assert-Equal "5" ([string]$script:articleStableProbeCall) "article stability requires the final structure signature to settle"
Assert-Equal "article-document" ([string]$script:ArticleWindowCache["brief-0810"].Document) "stable article wait saves the Root and Document cache"

$nonBodyTitle = "Non-body title long enough for table-of-contents candidate testing"
$script:testTocTitles = @(
    "brief-0810",
    $firstTitle,
    $nonBodyTitle,
    $secondTitle
)
$script:testChunks = @(
    "Preface`n$firstTitle`n$('A' * 600)`n$secondTitle`nAdjacent-window text that must not be merged",
    "Preface`n$firstTitle`n$('A' * 600)`n$secondTitle`nThe candidate title is absent from this body window",
    "Virtualized text can differ between windows`n$secondTitle`n$('B' * 600)`nTail"
)
Add-Type -AssemblyName UIAutomationClient
Assert-Equal "100" ([string](Normalize-ImaBodyScrollPercent 102.813599062134)) "small Chromium UIA scroll overshoot is clamped to 100"
Assert-Throws { Normalize-ImaBodyScrollPercent 106 } "large body scroll overshoot is rejected"
Assert-Throws { Normalize-ImaBodyScrollPercent ([double]::NaN) } "NaN body scroll position is rejected"
$script:testScroller = [pscustomobject]@{
    Current = [pscustomobject]@{
        VerticalScrollPercent = 0
        VerticalViewSize = 10
    }
}
$script:tailPercent = 50.0
$script:testScroller | Add-Member -MemberType ScriptMethod -Name SetScrollPercent -Value {
    param($Horizontal, $Vertical)
    $script:tailPercent = [double]$Vertical
}
$script:testScroller | Add-Member -MemberType ScriptMethod -Name Scroll -Value {
    param($Horizontal, $Vertical)
    if ($script:tailPercent -lt 100) { $script:tailPercent = [Math]::Min(100, $script:tailPercent + 20) }
}
function Invoke-ImaBodyMouseWheel {
    param([string]$Title, [int]$Delta)
    if ($Delta -ge 0) { throw "Body tail wheel must only move down" }
    if ($script:tailPercent -lt 100) { $script:tailPercent = [Math]::Min(100, $script:tailPercent + 20) }
}
function Get-ImaRoot { return "root" }
function Get-ImaBodyScroller { param($Root, $Document) return $script:testScroller }
function Wait-ImaDocument { return "document" }
function Get-ImaViewportSnapshot {
    if ($script:tailPercent -lt 70) {
        $script:tailCurrentText = $script:tailWindowB
    }
    elseif ($script:tailPercent -lt 95) {
        $script:tailCurrentText = $script:tailWindowC
    }
    else {
        $script:tailCurrentText = $script:tailWindowD
    }
    return [pscustomobject]@{
        Document = "document"
        Text = $script:tailCurrentText
        Signature = Get-ImaViewportFingerprint $script:tailCurrentText
        ScrollPercent = $script:tailPercent
        ViewSize = 20.0
        Scroller = $script:testScroller
    }
}
$script:tailWaitCalls = @()
function Wait-ImaViewportStable {
    param(
        [string]$Title,
        [double]$ExpectedPercent = -1,
        [string]$ExpectedText = "",
        [string]$PreviousSignature = "",
        [double]$PreviousPercent = -1,
        [int]$TimeoutMilliseconds = 10000,
        [int]$MinimumObservationMilliseconds = 600,
        [int]$StableSamples = 2,
        [int]$PollMilliseconds = 250,
        [bool]$AllowUnchanged = $false
    )
    $script:tailWaitCalls += [pscustomobject]@{
        ExpectedPercent = $ExpectedPercent
        TimeoutMilliseconds = $TimeoutMilliseconds
        MinimumObservationMilliseconds = $MinimumObservationMilliseconds
        StableSamples = $StableSamples
        AllowUnchanged = $AllowUnchanged
    }
    return Get-ImaViewportSnapshot $Title
}
function Get-ImaDocumentText { return $script:tailCurrentText }
function Get-ImaBodyChunk { param($DocumentText) return $DocumentText }

$script:tailWindowA = "Last section`n$('A' * 100)"
$script:tailWindowB = "$($('A' * 100))`n$($('B' * 100))"
$script:tailWindowC = "$($('B' * 100))`n$($('C' * 100))"
$script:tailWindowD = "$($('C' * 100))`nLONG_TAIL_SENTINEL"
$script:tailCurrentText = $script:tailWindowA
$tailResult = Merge-ImaTextWindowsToBottom "brief-0810" $script:tailWindowA 50
Assert-Equal "True" ([string]$tailResult.StartsWith("Last section")) "tail completion keeps the last section start"
Assert-Equal "True" ([string]$tailResult.EndsWith("LONG_TAIL_SENTINEL")) "tail completion reads through the 100-percent viewport"
Assert-Equal "100" ([string][int]$script:tailPercent) "tail completion reaches actual 100-percent position"
$bottomWait = $script:tailWaitCalls[-1]
Assert-Equal "30000" ([string]$bottomWait.TimeoutMilliseconds) "tail completion gives bottom lazy loading a 30-second observation window"
Assert-Equal "2000" ([string]$bottomWait.MinimumObservationMilliseconds) "tail completion observes bottom lazy loading for at least two seconds"
Assert-Equal "4" ([string]$bottomWait.StableSamples) "tail completion requires four stable bottom samples"
Assert-Equal "True" ([string]$bottomWait.AllowUnchanged) "tail completion accepts an already-bottom Chromium viewport"

# A historical overshoot must return through its TOC anchor. Set(100) would
# navigate backwards to a different text window on the real 0906 article.
$script:tailPercent = 50.0
$script:tailCurrentText = $script:tailWindowA
$script:tailAnchorCalls = 0
$script:testScroller | Add-Member -MemberType ScriptMethod -Name SetScrollPercent -Force -Value {
    throw "Percent positioning would jump backwards"
}
$script:testScroller | Add-Member -MemberType ScriptMethod -Name Scroll -Force -Value {
    throw "Relative UIA scrolling also clamps to the wrong bottom"
}
function Invoke-ImaTocItem { $script:tailAnchorCalls++; $script:tailPercent = 102.813599062134 }
$historicalBottomResult = Merge-ImaTextWindowsToBottom "brief-0810" $script:tailWindowC 102.813599062134 ([pscustomobject]@{Title="Last section"})
Assert-Equal "1" ([string]$script:tailAnchorCalls) "historical bottom percentage repositions through the last heading"
Assert-Equal "102.813599062134" ([string]$script:tailPercent) "overshoot completion never sets the absolute percentage to 100"
Assert-Equal "True" ([string]$historicalBottomResult.EndsWith("LONG_TAIL_SENTINEL")) "historical bottom percentage reads the live bottom after repositioning"
$script:tailPercent = 103.118082751575
$overshootResult = Merge-ImaTextWindowsToBottom "brief-0906" $script:tailWindowC 103.118082751575
Assert-Equal "True" ([string]$overshootResult.EndsWith("LONG_TAIL_SENTINEL")) "0906 overshoot can confirm bottom without a backward jump"
Assert-Equal "1" ([string]$script:tailAnchorCalls) "an already-positioned tail does not click the last heading again"

& {
    $script:tailPercent = 50.0
    function Invoke-ImaBodyMouseWheel {}
    Assert-Throws { Merge-ImaTextWindowsToBottom "brief-0906" $script:tailWindowA 50 } "an unchanged middle viewport is never accepted as the bottom"
}

& {
    $script:tailPercent = 103.118
    $script:cancelTailMoves = 0
    function Invoke-ImaBodyMouseWheel { $script:cancelTailMoves++; throw [OperationCanceledException]::new("cancel") }
    Assert-Throws { Move-ImaTailViewportDown "brief-0906" } "tail scrolling propagates cancellation"
    Assert-Equal "1" ([string]$script:cancelTailMoves) "cancelled tail input is never retried"
}

# The last TOC click can leave Chromium at 100% while its recorded UIA percentage is
# slightly lower. A repeated SetScrollPercent is then a valid no-op and must not timeout.
$script:tailPercent = 100.0
$script:tailCurrentText = $script:tailWindowD
$script:tailWaitCalls = @()
$script:tailNoOpSetCalls = 0
$script:testScroller | Add-Member -MemberType ScriptMethod -Name SetScrollPercent -Force -Value {
    param($Horizontal, $Vertical)
    $script:tailNoOpSetCalls++
}
$noOpTailResult = Merge-ImaTextWindowsToBottom "brief-0810" $script:tailWindowC 98
Assert-Equal "True" ([string]$noOpTailResult.EndsWith("LONG_TAIL_SENTINEL")) "tail completion handles an already-bottom no-op scroll"
Assert-Equal "True" ([string]$script:tailWaitCalls[0].AllowUnchanged) "tail no-op explicitly permits an unchanged stable viewport"

# A stale Chromium scroll provider can ignore the first command. The tail-only
# wrapper refreshes the cached scroller and retries with the longer budget.
$script:tailPercent = 50.0
$script:tailRetrySetCalls = 0
$script:tailRetryWaitCalls = 0
$script:tailRetryTimeouts = @()
$script:testScroller | Add-Member -MemberType ScriptMethod -Name SetScrollPercent -Force -Value {
    param($Horizontal, $Vertical)
    $script:tailRetrySetCalls++
    $script:tailPercent = [double]$Vertical
}
function Wait-ImaViewportStable {
    $script:tailRetryWaitCalls++
    $script:tailRetryTimeouts += [int]$args[5]
    if ($script:tailRetryWaitCalls -eq 1) {
        throw "等待 IMA 正文视图稳定超时：$($args[0])"
    }
    return Get-ImaViewportSnapshot $args[0]
}
$retryViewport = Wait-ImaTailViewportAtPercent "brief-0810" 60
Assert-Equal "2" ([string]$script:tailRetryWaitCalls) "tail viewport retries once after a stability timeout"
Assert-Equal "2" ([string]$script:tailRetrySetCalls) "tail viewport reissues the scroll command on retry"
Assert-Equal "10000,30000" ($script:tailRetryTimeouts -join ",") "tail viewport retry extends the stability timeout"
Assert-Equal "60" ([string][int]$retryViewport.ScrollPercent) "tail viewport retry reaches the requested position"

$localTailRetryProbe = & {
    $script:localTailMoves = 0
    $script:localTailCacheClears = 0
    $scroller = [pscustomobject]@{}
    $scroller | Add-Member ScriptMethod Scroll { throw "Chromium UIA scroll must not be used for tail completion" }
    function Invoke-ImaBodyMouseWheel { $script:localTailMoves++ }
    function Get-ImaViewportSnapshot { return [pscustomobject]@{ Scroller=$scroller; Signature="tail"; ScrollPercent=103.118 } }
    function Wait-ImaViewportStable {
        if ($script:localTailMoves -eq 1) { throw "等待 IMA 正文视图稳定超时：brief-0906" }
        return Get-ImaViewportSnapshot
    }
    function Clear-ImaBodyScrollerCache { $script:localTailCacheClears++ }
    $result = Move-ImaTailViewportDown "brief-0906"
    return "$script:localTailMoves,$script:localTailCacheClears,$($result.ScrollPercent)"
}
Assert-Equal "2,1,103.118" $localTailRetryProbe "tail scroll retries locally without losing captured sections"

$noWholeArticleRetryProbe = & {
    $script:noWholeArticleReads = 0
    function Read-ImaCompleteArticle { $script:noWholeArticleReads++; throw "最后章节未能完整读取到正文底部：相邻 IMA 文本窗口没有足够的重叠内容" }
    try { Read-ImaCompleteArticleWithRetry "brief-0906" } catch { }
    return $script:noWholeArticleReads
}
Assert-Equal "1" ([string]$noWholeArticleRetryProbe) "a deterministic merge error never reads all TOC entries twice"

$script:testChunkIndex = -1
$script:articleCurrentText = $script:testChunks[0]
$script:articlePercent = 0.0
$script:testScroller | Add-Member -MemberType ScriptMethod -Name SetScrollPercent -Force -Value {
    param($Horizontal, $Vertical)
    $script:articlePercent = [double]$Vertical
}
function Get-ImaViewportSnapshot {
    return [pscustomobject]@{
        Document = "document"
        Text = $script:articleCurrentText
        Signature = Get-ImaViewportFingerprint $script:articleCurrentText
        ScrollPercent = $script:articlePercent
        ViewSize = 10.0
        Scroller = $script:testScroller
    }
}
function Wait-ImaViewportStable { return Get-ImaViewportSnapshot $args[0] }
function Get-ImaTocItems {
    $seenTitles = @{}
    return @($script:testTocTitles | ForEach-Object {
        if (-not $seenTitles.ContainsKey($_)) { $seenTitles[$_] = 0 }
        $seenTitles[$_]++
        [pscustomobject]@{ Title = $_; Identity = "test-$($_)-$($seenTitles[$_])"; Occurrence = $seenTitles[$_]; Element = $null; InvokeElement = $null }
    })
}
function Invoke-ImaTocItem {
    $script:testChunkIndex++
    $script:articleCurrentText = $script:testChunks[$script:testChunkIndex]
    $script:articlePercent = @(10.0, 25.0, 70.0)[$script:testChunkIndex]
}
function Get-ImaDocumentText { return $script:articleCurrentText }
function Get-ImaBodyChunk { param($DocumentText) return $DocumentText }
function Merge-ImaTextWindowsToBottom {
    param($Title, $StartingChunk, $StartingPercent)
    return "$StartingChunk`nLONG_TAIL_SENTINEL"
}
$expectedArticle = "Preface`n`n## $firstTitle`n`n$('A' * 600)`n## $secondTitle`n`n$('B' * 600)`nTail`nLONG_TAIL_SENTINEL"
$actualArticle = Read-ImaCompleteArticle "brief-0810"
Assert-Equal $expectedArticle $actualArticle "article ignores non-body table-of-contents candidates"
Assert-Equal "2" ([string]$script:testChunkIndex) "article title TOC item is skipped without invoking or waiting for a viewport change"
Assert-Equal "True" ([string]$actualArticle.StartsWith("Preface")) "article keeps the top preface before the first heading"
Assert-Equal "True" ([string]$actualArticle.EndsWith("LONG_TAIL_SENTINEL")) "article keeps the final tail after the last heading"

$script:testTocTitles = @($firstTitle, $secondTitle)
$script:articleCurrentText = "Preface`n$firstTitle`n$('A' * 600)`n$secondTitle`nPartial second body"
$script:articlePercent = 0.0
$script:cachedSectionClicks = 0
function Invoke-ImaTocItem {
    $script:cachedSectionClicks++
    $script:articleCurrentText = "$secondTitle`n$('B' * 600)`nTail"
    $script:articlePercent = 70.0
}
$cachedArticle = Read-ImaCompleteArticle "brief-0810"
Assert-Equal "1" ([string]$script:cachedSectionClicks) "two sections need only one click when the first is complete in the top window"
Assert-Equal $expectedArticle $cachedArticle "cached-section fast path produces the same complete markdown"

Write-Output "PASS: $script:AssertionCount PowerShell assertions"
