param(
    [int]$MaxItems = 7,
    [string]$KnowledgeBaseName = "",
    [string]$FolderName = "",
    [string]$TitlePattern = '^速看-\d{4}$',
    [string]$UpdateMarker = "更新时间：",
    [string]$SkipTitlesBase64 = "",
    [string]$CancelFilePath = "",
    [string]$InputPath = "",
    [string]$OutputPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)

$script:KnowledgeBaseName = $KnowledgeBaseName
$script:FolderName = $FolderName
$script:TitlePattern = $TitlePattern
$script:UpdateMarker = $UpdateMarker
$script:LogPath = Join-Path $env:LOCALAPPDATA "ima-speed-sync\sync.log"
$script:TitleScrollPercentByName = @{}
$script:TitleScrollStepByName = @{}
$script:CurrentTitleScrollStep = 0
$script:SkipTitles = @{}
$script:CancelFilePath = $CancelFilePath
$script:CurrentArticleTitle = ""
$script:MainWindowHandle = [IntPtr]::Zero
$script:MainProcessId = 0
$script:StableDocumentTitles = @{}
$script:CompletedItems = New-Object Collections.Generic.List[object]
$script:CompletedErrors = New-Object Collections.Generic.List[object]
$script:CompletedSkippedTitles = New-Object Collections.Generic.List[string]
$script:LogRotationChecked = $false
$script:LastMutexWasAbandoned = $false
$script:BodyScrollerCache = @{}
$script:ArticleWindowCache = @{}
$script:LastKnownBodyScrollerReason = "尚未检查正文滚动器"
$script:ContentMode = "speed-reader"
$script:TitleFilterMode = "all"
$script:TitleFilter = ""
$script:AllowForeground = $false
$script:ForegroundMilliseconds = 0.0
$script:SkipSourceIds = @{}
$script:GeneralBodyCache = @{}

function Write-ImaProgress([string]$Text) {
    try {
        [Console]::WriteLine('IMA_PROGRESS:' + (@{ text = $Text } | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
    } catch { } # Optional progress must not abort extraction or cleanup.
}

function Add-ImaSkipTitles([object[]]$Titles) {
    foreach ($skipTitle in @($Titles)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$skipTitle)) {
            $script:SkipTitles[[string]$skipTitle] = $true
        }
    }
}

function Initialize-ImaInput {
    $script:SkipTitles = @{}
    if (-not [string]::IsNullOrWhiteSpace($InputPath)) {
        if (-not [IO.File]::Exists($InputPath)) {
            throw "同步输入文件不存在：$InputPath"
        }
        try {
            $inputJson = [IO.File]::ReadAllText($InputPath, (New-Object Text.UTF8Encoding($false)))
            $inputData = $inputJson | ConvertFrom-Json
            if ($inputData.PSObject.Properties["skipTitles"] -and $null -ne $inputData.skipTitles) {
                Add-ImaSkipTitles @($inputData.skipTitles)
            }
            if ($inputData.PSObject.Properties["contentMode"]) {
                if ($inputData.contentMode -notin @("general", "speed-reader")) { throw "内容模式无效" }
                $script:ContentMode = [string]$inputData.contentMode
            }
            if ($inputData.PSObject.Properties["titleFilterMode"]) {
                if ($inputData.titleFilterMode -notin @("all", "contains", "prefix", "regex")) { throw "标题筛选方式无效" }
                $script:TitleFilterMode = [string]$inputData.titleFilterMode
            }
            if ($inputData.PSObject.Properties["titleFilter"]) { $script:TitleFilter = [string]$inputData.titleFilter }
            if ($inputData.PSObject.Properties["allowForeground"]) {
                if ($inputData.allowForeground -isnot [bool]) { throw "前台操作开关无效" }
                $script:AllowForeground = $inputData.allowForeground
            }
            if ($inputData.PSObject.Properties["skipSourceIds"]) {
                foreach ($sourceId in @($inputData.skipSourceIds)) {
                    if ($sourceId -isnot [string]) { throw "来源 ID 必须为字符串" }
                    $script:SkipSourceIds[$sourceId] = $true
                }
            }
            return
        }
        catch {
            throw "同步输入文件无效：$($_.Exception.Message)"
        }
    }

    if ([string]::IsNullOrWhiteSpace($SkipTitlesBase64)) {
        return
    }
    try {
        $skipTitlesJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SkipTitlesBase64))
        $decodedSkipTitles = $skipTitlesJson | ConvertFrom-Json
        Add-ImaSkipTitles @($decodedSkipTitles)
    }
    catch {
        throw "跳过标题参数无效：$($_.Exception.Message)"
    }
}

Initialize-ImaInput

$script:TitleRegex = $null
if ($script:ContentMode -eq "general") {
    if ($script:TitleFilter.Length -gt 300) { throw "标题筛选内容不能超过 300 个字符" }
    if ($script:TitleFilterMode -ne "all" -and [string]::IsNullOrWhiteSpace($script:TitleFilter)) { throw "标题筛选内容不能为空" }
    if ($script:TitleFilterMode -eq "regex") {
        try {
            $script:TitleRegex = [regex]::new($script:TitleFilter, [Text.RegularExpressions.RegexOptions]::IgnoreCase, [TimeSpan]::FromMilliseconds(100))
        }
        catch { throw "标题正则表达式无效：$($_.Exception.Message)" }
    }
}

function Initialize-ImaNativeMethods {
    if ("ImaSpeedSync.NativeMethods" -as [type]) {
        return
    }
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace ImaSpeedSync {
    public static class NativeMethods {
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT {
            public int X;
            public int Y;
        }

        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT point);

        [StructLayout(LayoutKind.Sequential)]
        private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
        [DllImport("user32.dll")]
        private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
        public static uint GetInputIdleMilliseconds() {
            LASTINPUTINFO info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
            return GetLastInputInfo(ref info) ? unchecked((uint)Environment.TickCount - info.dwTime) : 0;
        }

        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int x, int y);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr windowHandle);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr windowHandle);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr windowHandle, int command);

        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(
            IntPtr windowHandle,
            IntPtr insertAfter,
            int x,
            int y,
            int width,
            int height,
            uint flags
        );

        [DllImport("user32.dll")]
        private static extern IntPtr WindowFromPoint(POINT point);

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr windowHandle, uint message, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr windowHandle, uint flags);


        public static bool PostMouseWheelToWindow(int x, int y, int delta, IntPtr expectedRoot) {
            POINT point = new POINT { X = x, Y = y };
            IntPtr target = WindowFromPoint(point);
            // Never send wheel input to another application if focus/occlusion
            // changed between locating the article and posting the message.
            if (expectedRoot == IntPtr.Zero || target == IntPtr.Zero || GetAncestor(target, 2) != expectedRoot) {
                return false;
            }
            return PostMessage(target, 0x020A, new IntPtr(delta << 16), new IntPtr((y << 16) | (x & 0xFFFF)));
        }

        public static bool PostMouseWheelAtPoint(int x, int y, int delta) {
            POINT point = new POINT { X = x, Y = y };
            IntPtr target = WindowFromPoint(point);
            int wheelParam = delta << 16;
            int positionParam = (y << 16) | (x & 0xFFFF);
            return target != IntPtr.Zero && PostMessage(
                target,
                0x020A,
                new IntPtr(wheelParam),
                new IntPtr(positionParam)
            );
        }

        [DllImport("user32.dll")]
        public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
    }
}
"@
}

function Rotate-ImaLogIfNeeded([string]$Path, [long]$MaximumBytes = 4194304) {
    if (-not [IO.File]::Exists($Path) -or ([IO.FileInfo]$Path).Length -le $MaximumBytes) {
        return $false
    }

    $backupPath = "$Path.1"
    if ([IO.File]::Exists($backupPath)) {
        [IO.File]::Delete($backupPath)
    }
    [IO.File]::Move($Path, $backupPath)
    return $true
}

function Write-SyncLog([string]$Message) {
    $directory = Split-Path -Parent $script:LogPath
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    if (-not $script:LogRotationChecked) {
        $script:LogRotationChecked = $true
        try {
            [void](Rotate-ImaLogIfNeeded $script:LogPath)
        }
        catch {
            # 日志轮转失败不能阻断同步；本轮仍尝试追加当前日志。
        }
    }
    $line = "{0:yyyy-MM-dd HH:mm:ss} {1}`r`n" -f (Get-Date), $Message
    [IO.File]::AppendAllText($script:LogPath, $line, (New-Object Text.UTF8Encoding($false)))
}

function ConvertTo-ImaResultJson([object]$Result) {
    return ($Result | ConvertTo-Json -Depth 5 -Compress)
}

function Write-ImaResult([object]$Result) {
    $json = ConvertTo-ImaResultJson $Result
    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        $directory = Split-Path -Parent $OutputPath
        if ([string]::IsNullOrWhiteSpace($directory)) {
            $directory = [Environment]::CurrentDirectory
        }
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        $temporaryPath = Join-Path $directory (".{0}.{1}.tmp" -f ([IO.Path]::GetFileName($OutputPath)), [guid]::NewGuid().ToString("N"))
        try {
            [IO.File]::WriteAllText($temporaryPath, $json, (New-Object Text.UTF8Encoding($false)))
            if ([IO.File]::Exists($OutputPath)) {
                $backupPath = "$OutputPath.replace-backup"
                [IO.File]::Replace($temporaryPath, $OutputPath, $backupPath)
                if ([IO.File]::Exists($backupPath)) {
                    [IO.File]::Delete($backupPath)
                }
            }
            else {
                [IO.File]::Move($temporaryPath, $OutputPath)
            }
        }
        finally {
            if ([IO.File]::Exists($temporaryPath)) {
                [IO.File]::Delete($temporaryPath)
            }
        }
        Write-Output '{"outputWritten":true}'
        return
    }
    Write-Output $json
}

function Enter-ImaMutex([Threading.Mutex]$Mutex) {
    $script:LastMutexWasAbandoned = $false
    try {
        return $Mutex.WaitOne(0)
    }
    catch [Threading.AbandonedMutexException] {
        # WaitOne 抛出此异常时，当前线程实际上已经取得互斥锁所有权。
        $script:LastMutexWasAbandoned = $true
        Write-SyncLog "检测到上次同步异常退出遗留的互斥锁，已接管并继续"
        return $true
    }
}

function Test-ImaCancellation {
    if (
        -not [string]::IsNullOrWhiteSpace($script:CancelFilePath) -and
        [IO.File]::Exists($script:CancelFilePath)
    ) {
        throw [OperationCanceledException]::new("用户取消了 IMA Share Sync")
    }
}

function Start-ImaCancelableSleep([int]$Milliseconds) {
    $remaining = [Math]::Max(0, $Milliseconds)
    while ($remaining -gt 0) {
        Test-ImaCancellation
        $interval = [Math]::Min(100, $remaining)
        Start-Sleep -Milliseconds $interval
        $remaining -= $interval
    }
    Test-ImaCancellation
}

function Get-ImaUpdateHeader([string]$DocumentText) {
    $text = $DocumentText.Replace("`r`n", "`n").Replace("`r", "`n")
    $datePattern = '(?m)^[ \t\uFEFF\uFFFC]*' + [regex]::Escape($script:UpdateMarker) +
        '[ \t]*(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[ \t]+\d{1,2}:\d{2}(?::\d{2})?)?[ \t\uFEFF\uFFFC]*$'
    $match = [regex]::Match($text, $datePattern)
    if (-not $match.Success) {
        throw "IMA 文章中未找到严格匹配的头部更新时间行"
    }

    $lineStart = $match.Index
    $lineEnd = $text.IndexOf("`n", $lineStart)
    if ($lineEnd -lt 0) {
        throw "IMA 文章的更新时间标记后没有正文"
    }
    $line = $text.Substring($lineStart, $lineEnd - $lineStart).Trim()
    $markerOffset = $match.Value.IndexOf($script:UpdateMarker, [StringComparison]::Ordinal)
    $markerIndex = $match.Index + $markerOffset

    try {
        $date = [datetime]::new(
            [int]$match.Groups[1].Value,
            [int]$match.Groups[2].Value,
            [int]$match.Groups[3].Value
        )
    }
    catch {
        throw "IMA 文章头部的更新日期无效：$line"
    }
    return [pscustomobject]@{
        Text = $text
        MarkerIndex = $markerIndex
        BodyStart = $lineEnd + 1
        Date = $date
    }
}

function Get-ImaBodyChunk([string]$DocumentText) {
    $header = Get-ImaUpdateHeader $DocumentText

    $body = $header.Text.Substring($header.BodyStart)
    $body = $body.Replace([string][char]0xFEFF, "").Replace([string][char]0xFFFC, "`n")
    $body = [regex]::Replace($body, "[ `t]+`n", "`n")
    $body = [regex]::Replace($body, "`n{3,}", "`n`n")
    return $body.Trim()
}

function Get-ImaUpdatedDateFromText([string]$DocumentText) {
    $header = Get-ImaUpdateHeader $DocumentText
    return $header.Date.ToString("yyyy-MM-dd", [Globalization.CultureInfo]::InvariantCulture)
}

function Get-ImaTitleDateValue([string]$Title, [datetime]$ReferenceDate = (Get-Date)) {
    $explicit = [regex]::Match($Title, '(?<!\d)(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?!\d)')
    if ($explicit.Success) {
        try {
            return [datetime]::new(
                [int]$explicit.Groups[1].Value,
                [int]$explicit.Groups[2].Value,
                [int]$explicit.Groups[3].Value
            )
        }
        catch {
            return $null
        }
    }

    $short = [regex]::Match($Title, '(?<!\d)(0[1-9]|1[0-2])([0-2]\d|3[01])$')
    if (-not $short.Success) {
        return $null
    }
    try {
        $candidate = [datetime]::new(
            $ReferenceDate.Year,
            [int]$short.Groups[1].Value,
            [int]$short.Groups[2].Value
        )
        if ($candidate -gt $ReferenceDate.Date.AddDays(45)) {
            $candidate = $candidate.AddYears(-1)
        }
        return $candidate
    }
    catch {
        return $null
    }
}

function Sort-ImaTitleRecords([object[]]$Records, [datetime]$ReferenceDate = (Get-Date)) {
    $decorated = foreach ($record in @($Records)) {
        $date = Get-ImaTitleDateValue ([string]$record.Name) $ReferenceDate
        [pscustomobject]@{
            Record = $record
            HasDate = ($null -ne $date)
            DateTicks = if ($null -ne $date) { $date.Ticks } else { [long]::MinValue }
            VisualIndex = [int]$record.VisualIndex
        }
    }
    return @($decorated | Sort-Object `
        @{ Expression = "HasDate"; Descending = $true }, `
        @{ Expression = "DateTicks"; Descending = $true }, `
        @{ Expression = "VisualIndex"; Ascending = $true } |
        ForEach-Object { $_.Record })
}

function Select-ImaRecentTitles(
    [string[]]$Titles,
    [int]$Limit,
    [datetime]$ReferenceDate = (Get-Date)
) {
    $records = for ($index = 0; $index -lt $Titles.Count; $index++) {
        [pscustomobject]@{ Name = $Titles[$index]; VisualIndex = $index }
    }
    # The folder's visual top defines recency. Freeze that candidate window
    # before date sorting so a newly re-shared article with an older title date
    # is still checked.
    $topCandidates = @($records | Select-Object -First $Limit)
    return @((Sort-ImaTitleRecords $topCandidates $ReferenceDate) | ForEach-Object { $_.Name })
}

function Test-ImaTransientExtractionError([string]$Message) {
    # 拼接/边界错误不是重新加载整篇就能解决的瞬态故障。尾部已在局部重试，
    # 不应再把几十个已读取的目录项全部读一遍。
    if ($Message -match '尾部|最后章节|衔接|重叠|文本窗口|正文.*不完整') { return $false }
    return $Message -match '(?i:等待|超时|加载|不可用|不存在|未找到 IMA 文章滚动区域|timeout|loading|not available)'
}

function Get-ImaSectionText(
    [string]$Chunk,
    [string]$Title,
    [string]$NextTitle,
    [bool]$IncludePrefix,
    [int]$TitleOccurrence = 1
) {
    $titlePosition = -1
    $searchStart = 0
    for ($occurrence = 1; $occurrence -le [Math]::Max(1, $TitleOccurrence); $occurrence++) {
        $titlePosition = $Chunk.IndexOf($Title, $searchStart, [StringComparison]::Ordinal)
        if ($titlePosition -lt 0) {
            break
        }
        $searchStart = $titlePosition + $Title.Length
    }
    if ($titlePosition -lt 0 -and $TitleOccurrence -gt 1) {
        # 虚拟化窗口可能从目标章节附近开始，不包含同名标题的较早 occurrence。
        $titlePosition = $Chunk.IndexOf($Title, [StringComparison]::Ordinal)
    }
    if ($titlePosition -lt 0) {
        throw "当前文本窗口中未找到 IMA 章节标题：$Title"
    }

    $start = if ($IncludePrefix) { 0 } else { $titlePosition }
    $end = $Chunk.Length
    if (-not [string]::IsNullOrWhiteSpace($NextTitle)) {
        $end = $Chunk.IndexOf(
            $NextTitle,
            $titlePosition + $Title.Length,
            [StringComparison]::Ordinal
        )
        if ($end -lt 0) {
            throw "当前文本窗口中未找到下一个 IMA 章节标题：$NextTitle"
        }
    }

    $section = $Chunk.Substring($start, $end - $start).Trim()
    if ([string]::IsNullOrWhiteSpace($section)) {
        throw "IMA 章节正文为空：$Title"
    }
    return $section
}

function Get-ImaTextOccurrenceCount([string]$Text, [string]$Value) {
    if ([string]::IsNullOrEmpty($Value)) {
        return 0
    }
    $count = 0
    $searchStart = 0
    while ($searchStart -lt $Text.Length) {
        $position = $Text.IndexOf($Value, $searchStart, [StringComparison]::Ordinal)
        if ($position -lt 0) {
            break
        }
        $count++
        $searchStart = $position + $Value.Length
    }
    return $count
}

function Test-ImaCanReuseTopViewport(
    [string]$BodyChunk,
    [string]$Title,
    [int]$Occurrence,
    [double]$ScrollPercent
) {
    return (
        $ScrollPercent -le 1.0 -and
        $Occurrence -ge 1 -and
        (Get-ImaTextOccurrenceCount $BodyChunk $Title) -ge $Occurrence
    )
}

function Test-ImaHasCompleteSectionWindow([string]$Chunk, [string]$Title, [string]$NextTitle) {
    if ([string]::IsNullOrWhiteSpace($NextTitle) -or $Title -ceq $NextTitle) { return $false }
    # 必须同时有当前标题和后续章节边界；只看到标题不代表正文已加载完整。
    $currentMatch = [regex]::Match($Chunk, '(?m)^' + [regex]::Escape($Title) + '\r?$')
    if (-not $currentMatch.Success) { return $false }
    $remaining = $Chunk.Substring($currentMatch.Index + $currentMatch.Length)
    return [regex]::IsMatch($remaining, '(?m)^' + [regex]::Escape($NextTitle) + '\r?$')
}

function Format-ImaSectionMarkdown([string]$Section, [string]$Title) {
    $titlePosition = $Section.IndexOf($Title, [StringComparison]::Ordinal)
    if ($titlePosition -lt 0) {
        throw "格式化 Markdown 时未找到 IMA 章节标题：$Title"
    }

    $prefix = $Section.Substring(0, $titlePosition).Trim()
    $content = $Section.Substring($titlePosition + $Title.Length).Trim()
    $parts = New-Object Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($prefix)) {
        $parts.Add($prefix)
    }
    $parts.Add("## $Title")
    if (-not [string]::IsNullOrWhiteSpace($content)) {
        $parts.Add($content)
    }
    return ($parts -join "`n`n")
}

function Merge-ImaTextWindows([string]$Left, [string]$Right) {
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
        throw "IMA 文本窗口为空，无法合并"
    }
    if ($Left.Contains($Right)) {
        return $Left
    }
    if ($Right.Contains($Left)) {
        return $Right
    }

    $leftView = Get-ImaNormalizedMergeView $Left
    $rightView = Get-ImaNormalizedMergeView $Right
    $maximumProbeLength = 20000
    $patternLength = [Math]::Min($rightView.Text.Length, $maximumProbeLength)
    if ($patternLength -lt 30) {
        throw "相邻 IMA 文本窗口没有足够的重叠内容"
    }

    $pattern = $rightView.Text.Substring(0, $patternLength)
    $prefix = New-Object 'int[]' $patternLength
    for ($index = 1; $index -lt $patternLength; $index++) {
        $candidate = $prefix[$index - 1]
        while ($candidate -gt 0 -and $pattern[$index] -cne $pattern[$candidate]) {
            $candidate = $prefix[$candidate - 1]
        }
        if ($pattern[$index] -ceq $pattern[$candidate]) {
            $candidate++
        }
        $prefix[$index] = $candidate
    }

    $matchedLength = 0
    $leftStart = [Math]::Max(0, $leftView.Text.Length - $maximumProbeLength)
    for ($index = $leftStart; $index -lt $leftView.Text.Length; $index++) {
        while ($matchedLength -gt 0 -and $leftView.Text[$index] -cne $pattern[$matchedLength]) {
            $matchedLength = $prefix[$matchedLength - 1]
        }
        if ($leftView.Text[$index] -ceq $pattern[$matchedLength]) {
            $matchedLength++
        }
        if ($matchedLength -eq $patternLength -and $index -lt ($leftView.Text.Length - 1)) {
            $matchedLength = $prefix[$matchedLength - 1]
        }
    }

    if ($matchedLength -lt 30) {
        throw "相邻 IMA 文本窗口没有足够的重叠内容"
    }
    $rightCutIndex = $rightView.EndPositions[$matchedLength - 1]
    $remaining = $Right.Substring($rightCutIndex).TrimStart()
    if ([string]::IsNullOrWhiteSpace($remaining)) {
        return $Left.TrimEnd()
    }
    return "$($Left.TrimEnd())`n$remaining"
}

function Get-ImaNormalizedMergeView([string]$Text) {
    $normalized = New-Object Text.StringBuilder
    $endPositions = New-Object Collections.Generic.List[int]
    for ($index = 0; $index -lt $Text.Length; $index++) {
        $character = $Text[$index]
        if (-not [char]::IsLetterOrDigit($character)) {
            continue
        }
        [void]$normalized.Append([char]::ToUpperInvariant($character))
        $endPositions.Add($index + 1)
    }
    return [pscustomobject]@{
        Text = $normalized.ToString()
        EndPositions = $endPositions.ToArray()
    }
}

function Add-ImaHorizontalRulesToText([string]$Text, [object[]]$Anchors) {
    $result = $Text
    $searchStart = 0
    $insertions = New-Object Collections.Generic.List[int]
    foreach ($anchor in @($Anchors)) {
        $before = [string]$anchor.Before
        $after = [string]$anchor.After
        if ([string]::IsNullOrWhiteSpace($before) -or [string]::IsNullOrWhiteSpace($after)) {
            continue
        }
        $beforeIndex = $Text.IndexOf($before, $searchStart, [StringComparison]::Ordinal)
        if ($beforeIndex -lt 0) {
            continue
        }
        $afterIndex = $Text.IndexOf($after, $beforeIndex + $before.Length, [StringComparison]::Ordinal)
        if ($afterIndex -lt 0) {
            continue
        }
        $between = $Text.Substring($beforeIndex + $before.Length, $afterIndex - $beforeIndex - $before.Length)
        if ($between -notmatch '(?m)^\s*-{3,}\s*$') {
            $insertions.Add($afterIndex)
        }
        $searchStart = $afterIndex + $after.Length
    }
    foreach ($position in @($insertions.ToArray() | Sort-Object -Descending)) {
        $existingNewlines = 0
        for ($probe = $position - 1; $probe -ge 0 -and $result[$probe] -eq "`n"; $probe--) {
            $existingNewlines++
        }
        $leadingNewlines = "`n" * [Math]::Max(0, 2 - $existingNewlines)
        $result = $result.Insert($position, "$leadingNewlines---`n`n")
    }
    return $result
}

function Get-ImaWindowRoots {
    Add-Type -AssemblyName UIAutomationClient

    $processIds = @{}
    foreach ($imaProcess in @(Get-Process -Name "ima.copilot" -ErrorAction SilentlyContinue)) {
        $processIds[[int]$imaProcess.Id] = $true
    }
    if ($processIds.Count -eq 0) {
        return @()
    }

    $roots = New-Object Collections.Generic.List[Windows.Automation.AutomationElement]
    $desktop = [Windows.Automation.AutomationElement]::RootElement
    $windows = $desktop.FindAll(
        [Windows.Automation.TreeScope]::Children,
        [Windows.Automation.Condition]::TrueCondition
    )
    foreach ($window in $windows) {
        try {
            if ($processIds.ContainsKey([int]$window.Current.ProcessId)) {
                $roots.Add($window)
            }
        }
        catch [Windows.Automation.ElementNotAvailableException] {
            continue
        }
    }
    return $roots.ToArray()
}

function Select-ImaArticleRootDescriptors([object[]]$Descriptors, [string]$Title) {
    $exact = @($Descriptors | Where-Object {
        [string]::Equals([string]$_.Name, $Title, [StringComparison]::Ordinal)
    } | Sort-Object -Property OriginalIndex)
    if ($exact.Count -gt 0) {
        return $exact
    }
    return @($Descriptors | Sort-Object -Property OriginalIndex)
}

function Get-ImaArticleWindowPresence([string]$Title) {
    try {
        $roots = @(Get-ImaWindowRoots)
    }
    catch {
        return [pscustomobject]@{ State = "Unknown"; Root = $null }
    }

    $inspectionFailed = $false
    foreach ($root in $roots) {
        try {
            if ([string]::Equals([string]$root.Current.Name, $Title, [StringComparison]::Ordinal)) {
                return [pscustomobject]@{ State = "Present"; Root = $root }
            }
        }
        catch {
            # A disappearing Chromium window makes absence uncertain. The
            # caller must not click the title while duplicate risk is unknown.
            $inspectionFailed = $true
        }
    }
    if ($inspectionFailed) {
        return [pscustomobject]@{ State = "Unknown"; Root = $null }
    }
    return [pscustomobject]@{ State = "Absent"; Root = $null }
}

function Find-ImaArticleWindow([string]$Title) {
    if ([string]::IsNullOrWhiteSpace($Title)) {
        return $null
    }
    $strictDocumentCondition = New-Object Windows.Automation.AndCondition(
        (New-Object Windows.Automation.PropertyCondition(
            [Windows.Automation.AutomationElement]::ControlTypeProperty,
            [Windows.Automation.ControlType]::Document
        )),
        (New-Object Windows.Automation.PropertyCondition(
            [Windows.Automation.AutomationElement]::NameProperty,
            $Title
        ))
    )
    $anyDocumentCondition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::ControlTypeProperty,
        [Windows.Automation.ControlType]::Document
    )
    $descriptors = New-Object Collections.Generic.List[object]
    $roots = @(Get-ImaWindowRoots)
    for ($index = 0; $index -lt $roots.Count; $index++) {
        try {
            $descriptors.Add([pscustomobject]@{
                Root = $roots[$index]
                Name = [string]$roots[$index].Current.Name
                OriginalIndex = $index
            })
        }
        catch [Windows.Automation.ElementNotAvailableException] {
            continue
        }
    }
    $preferred = @(Select-ImaArticleRootDescriptors ($descriptors.ToArray()) $Title)
    $hasExactTopLevel = @($preferred | Where-Object {
        [string]::Equals([string]$_.Name, $Title, [StringComparison]::Ordinal)
    }).Count -gt 0

    foreach ($descriptor in $preferred) {
        try {
            $root = $descriptor.Root
            $document = $root.FindFirst(
                [Windows.Automation.TreeScope]::Descendants,
                $strictDocumentCondition
            )
            if (-not $document -and $hasExactTopLevel) {
                $document = $root.FindFirst(
                    [Windows.Automation.TreeScope]::Descendants,
                    $anyDocumentCondition
                )
            }
            if ($document) {
                return [pscustomobject]@{
                    Root = $root
                    Document = $document
                }
            }
        }
        catch [Windows.Automation.ElementNotAvailableException] {
            continue
        }
    }
    return $null
}

function Test-ImaArticleWindowCacheEntry([object]$Entry) {
    if ($null -eq $Entry -or $null -eq $Entry.Root -or $null -eq $Entry.Document) {
        return $false
    }
    $rootProcessId = [int]$Entry.Root.Current.ProcessId
    $documentProcessId = [int]$Entry.Document.Current.ProcessId
    [void]$Entry.Document.GetRuntimeId()
    return $rootProcessId -gt 0 -and $rootProcessId -eq $documentProcessId
}

function Clear-ImaArticleWindowCache([string]$Title = "") {
    if ([string]::IsNullOrWhiteSpace($Title)) {
        $script:ArticleWindowCache = @{}
        return
    }
    [void]$script:ArticleWindowCache.Remove($Title)
}

function Set-ImaArticleWindowCache([string]$Title, [object]$ArticleWindow) {
    if (
        [string]::IsNullOrWhiteSpace($Title) -or
        $null -eq $ArticleWindow -or
        $null -eq $ArticleWindow.Root -or
        $null -eq $ArticleWindow.Document
    ) {
        throw "文章窗口缓存参数无效"
    }
    $script:ArticleWindowCache[$Title] = $ArticleWindow
}

function Get-ImaCachedArticleWindowEntry(
    [string]$Title,
    [scriptblock]$Resolver,
    [scriptblock]$Validator = $null
) {
    if ($script:ArticleWindowCache.ContainsKey($Title)) {
        $cached = $script:ArticleWindowCache[$Title]
        try {
            $valid = if ($null -ne $Validator) {
                [bool](& $Validator $cached)
            }
            else {
                Test-ImaArticleWindowCacheEntry $cached
            }
            if ($valid) {
                return $cached
            }
        }
        catch [Windows.Automation.ElementNotAvailableException] {
            # 文章 WebView 已重建，下面清理并重新定位。
        }
        catch [System.InvalidOperationException] {
            # Chromium UIA provider 会用该异常报告已失效元素。
        }
        catch [System.Runtime.InteropServices.COMException] {
            # UIA 远端 provider 已销毁。
        }
        catch [System.Management.Automation.MethodInvocationException] {
            $inner = $_.Exception.InnerException
            if (
                $inner -isnot [Windows.Automation.ElementNotAvailableException] -and
                $inner -isnot [System.InvalidOperationException] -and
                $inner -isnot [System.Runtime.InteropServices.COMException]
            ) {
                throw
            }
        }
        [void]$script:ArticleWindowCache.Remove($Title)
        Clear-ImaBodyScrollerCache $Title
    }

    $resolved = & $Resolver
    if ($null -ne $resolved) {
        $script:ArticleWindowCache[$Title] = $resolved
    }
    return $resolved
}

function Get-ImaArticleWindow([string]$Title) {
    $articleTitle = $Title
    return Get-ImaCachedArticleWindowEntry $Title {
        Find-ImaArticleWindow $articleTitle
    }
}

function Get-ImaRoot {
    Add-Type -AssemblyName UIAutomationClient

    if (-not [string]::IsNullOrWhiteSpace($script:CurrentArticleTitle)) {
        $articleWindow = Get-ImaArticleWindow $script:CurrentArticleTitle
        if ($articleWindow) {
            return $articleWindow.Root
        }
    }

    if ($script:MainWindowHandle -ne [IntPtr]::Zero) {
        try {
            $trackedRoot = [Windows.Automation.AutomationElement]::FromHandle($script:MainWindowHandle)
            if ([int]$trackedRoot.Current.ProcessId -eq $script:MainProcessId) {
                return $trackedRoot
            }
        }
        catch {
            $script:MainWindowHandle = [IntPtr]::Zero
            $script:MainProcessId = 0
        }
    }

    $process = Get-Process -Name "ima.copilot" -ErrorAction SilentlyContinue |
        Where-Object MainWindowHandle -ne 0 |
        Select-Object -First 1

    if (-not $process) {
        $executable = Join-Path $env:LOCALAPPDATA "ima.copilot\Application\ima.copilot.exe"
        if (-not (Test-Path -LiteralPath $executable)) {
            throw "IMA 未运行，且未找到程序文件：$executable"
        }
        Start-Process -FilePath $executable | Out-Null
        for ($attempt = 0; $attempt -lt 90 -and -not $process; $attempt++) {
            Start-ImaCancelableSleep 500
            $process = Get-Process -Name "ima.copilot" -ErrorAction SilentlyContinue |
                Where-Object MainWindowHandle -ne 0 |
                Select-Object -First 1
        }
    }

    if (-not $process) {
        throw "45 秒内未检测到 IMA 主窗口"
    }
    $root = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    $script:MainWindowHandle = [IntPtr]$process.MainWindowHandle
    $script:MainProcessId = [int]$process.Id
    return $root
}

function Invoke-ImaNamedElement([Windows.Automation.AutomationElement]$Root, [string]$Name) {
    $condition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::NameProperty,
        $Name
    )
    $matches = $Root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker

    $orderedMatches = @($matches | Sort-Object {
        $score = if ($_.Current.IsOffscreen) { 10 } else { 0 }
        $ancestor = $_
        for ($level = 0; $level -lt 8 -and $ancestor; $level++) {
            $automationId = $ancestor.Current.AutomationId
            if ($automationId -like "knowledge-note_*") {
                return $score
            }
            if ($automationId -like "knowledge-weburl_*" -or $automationId -like "knowledge-pdf_*") {
                $score += 5
                break
            }
            $ancestor = $walker.GetParent($ancestor)
        }
        return $score + 2
    })
    foreach ($match in $orderedMatches) {
        try {
            $element = $match
            for ($level = 0; $level -lt 12 -and $element; $level++) {
                $scrollItemObject = $null
                if (
                    $element.Current.IsOffscreen -and
                    $element.TryGetCurrentPattern(
                        [Windows.Automation.ScrollItemPattern]::Pattern,
                        [ref]$scrollItemObject
                    )
                ) {
                    ([Windows.Automation.ScrollItemPattern]$scrollItemObject).ScrollIntoView()
                    Start-ImaCancelableSleep 450
                }

                $pattern = $null
                if ($element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                    ([Windows.Automation.InvokePattern]$pattern).Invoke()
                    return
                }
                $element = $walker.GetParent($element)
            }
        }
        catch [Windows.Automation.ElementNotAvailableException] {
            continue
        }
        catch [System.InvalidOperationException] {
            continue
        }
    }
    throw "IMA 界面元素不存在或无法调用：$Name"
}

function Test-ImaNamedElement([Windows.Automation.AutomationElement]$Root, [string]$Name) {
    $condition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::NameProperty,
        $Name
    )
    return $null -ne $Root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}

function Close-ImaCurrentArticle([switch]$Optional) {
    $root = Get-ImaRoot
    $nameCondition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::NameProperty,
        "关闭"
    )
    $buttons = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $nameCondition)

    foreach ($button in $buttons) {
        if ($button.Current.AutomationId -eq "view_4" -or $button.Current.IsOffscreen) {
            continue
        }
        $pattern = $null
        if ($button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
            ([Windows.Automation.InvokePattern]$pattern).Invoke()
            Start-Sleep -Milliseconds 500
            Clear-ImaBodyScrollerCache $script:CurrentArticleTitle
            Clear-ImaArticleWindowCache $script:CurrentArticleTitle
            $script:CurrentArticleTitle = ""
            return $true
        }
    }

    if ($Optional) {
        Clear-ImaBodyScrollerCache $script:CurrentArticleTitle
        Clear-ImaArticleWindowCache $script:CurrentArticleTitle
        $script:CurrentArticleTitle = ""
        return $false
    }
    throw "未找到 IMA 文章关闭按钮"
}

function Close-ImaApplication {
    Add-Type -AssemblyName UIAutomationClient

    $root = $null
    if ($script:MainWindowHandle -ne [IntPtr]::Zero) {
        try {
            $candidate = [Windows.Automation.AutomationElement]::FromHandle($script:MainWindowHandle)
            $process = Get-Process -Id ([int]$candidate.Current.ProcessId) -ErrorAction SilentlyContinue
            if ($process -and $process.ProcessName -eq "ima.copilot") {
                $root = $candidate
            }
        }
        catch {
            $root = $null
        }
    }

    if (-not $root) {
        $candidates = @(
            Get-ImaWindowRoots | Where-Object {
                try {
                    $list = Get-ImaTitleListElement $_
                    return $null -ne $list
                }
                catch {
                    return $false
                }
            }
        )
        if ($candidates.Count -eq 1) {
            $root = $candidates[0]
        }
        elseif ($candidates.Count -gt 1) {
            throw "检测到多个 IMA 列表窗口，无法安全判断应关闭哪一个"
        }
    }

    if (-not $root) {
        Write-SyncLog "同步结束时 IMA 已关闭"
        return $false
    }

    $closeCondition = New-Object Windows.Automation.AndCondition(
        (New-Object Windows.Automation.PropertyCondition(
            [Windows.Automation.AutomationElement]::AutomationIdProperty,
            "view_4"
        )),
        (New-Object Windows.Automation.PropertyCondition(
            [Windows.Automation.AutomationElement]::ControlTypeProperty,
            [Windows.Automation.ControlType]::Button
        ))
    )
    $closeButton = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $closeCondition)
    if (-not $closeButton -or $closeButton.Current.IsOffscreen) {
        throw "未找到 IMA 右上角关闭按钮"
    }

    $pattern = $null
    if (-not $closeButton.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        throw "IMA 右上角关闭按钮无法调用"
    }
    ([Windows.Automation.InvokePattern]$pattern).Invoke()
    Write-SyncLog "同步结束，已点击 IMA 右上角关闭按钮"
    $script:MainWindowHandle = [IntPtr]::Zero
    $script:MainProcessId = 0
    return $true
}

function Wait-ImaText([string]$Name, [int]$TimeoutMilliseconds = 45000) {
    $condition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::NameProperty,
        $Name
    )
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    do {
        $root = Get-ImaRoot
        if ($root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)) {
            return $root
        }
        Start-ImaCancelableSleep 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "等待 IMA 界面元素超时：$Name"
}

function Open-ImaSpeedFolder {
    $root = Get-ImaRoot

    if (-not (Test-ImaNamedElement $root $script:FolderName)) {
        Close-ImaCurrentArticle -Optional | Out-Null
        $root = Get-ImaRoot
    }

    if (-not (Test-ImaNamedElement $root $script:FolderName)) {
        $root = Wait-ImaText "知识库"
        Invoke-ImaNamedElement $root "知识库"
        $root = Wait-ImaText $script:KnowledgeBaseName
    }

    if (-not (Test-ImaNamedElement $root $script:FolderName)) {
        Invoke-ImaNamedElement $root $script:KnowledgeBaseName
        $root = Wait-ImaText $script:FolderName
    }

    Invoke-ImaNamedElement $root $script:FolderName
    Start-ImaCancelableSleep 600
    $root = Get-ImaRoot
    [void](Wait-ImaTitleListStable $root)
    $script:MainWindowHandle = [IntPtr]$root.Current.NativeWindowHandle
    $script:MainProcessId = [int]$root.Current.ProcessId
    return $root
}

function Get-ImaTitleListElement([Windows.Automation.AutomationElement]$Root) {
    $condition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::AutomationIdProperty,
        "shareKnowledgeContentList"
    )
    return $Root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}

function Get-ImaVisibleTitleSnapshot(
    [Windows.Automation.AutomationElement]$Root,
    [Windows.Automation.AutomationElement]$ListElement = $null
) {
    if (-not $ListElement) {
        $ListElement = Get-ImaTitleListElement $Root
    }
    if (-not $ListElement) {
        return [pscustomobject]@{
            Records = @()
            Elements = @()
            Signature = ""
        }
    }
    if ($script:ContentMode -eq "general") { return Get-ImaGeneralTitleSnapshot $ListElement }
    $containerRectangle = $ListElement.Current.BoundingRectangle
    $textCondition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::ControlTypeProperty,
        [Windows.Automation.ControlType]::Text
    )
    $all = $ListElement.FindAll(
        [Windows.Automation.TreeScope]::Descendants,
        $textCondition
    )
    $records = New-Object Collections.Generic.List[object]
    foreach ($element in $all) {
        try {
            $name = [string]$element.Current.Name
            if ($name -notmatch $script:TitlePattern -or $element.Current.IsOffscreen) {
                continue
            }
            $rectangle = $element.Current.BoundingRectangle
            $centerX = $rectangle.X + ($rectangle.Width / 2)
            $centerY = $rectangle.Y + ($rectangle.Height / 2)
            if (
                $rectangle.Width -gt 0 -and
                $rectangle.Height -gt 0 -and
                $centerX -ge $containerRectangle.X -and
                $centerX -le ($containerRectangle.X + $containerRectangle.Width) -and
                $centerY -ge $containerRectangle.Y -and
                $centerY -le ($containerRectangle.Y + $containerRectangle.Height)
            ) {
                $records.Add([pscustomobject]@{
                    Element = $element
                    Name = $name
                    X = [double]$rectangle.X
                    Y = [double]$rectangle.Y
                })
            }
        }
        catch [Windows.Automation.ElementNotAvailableException] {
            continue
        }
    }
    $orderedRecords = @($records.ToArray() | Sort-Object -Property Y, X)
    return [pscustomobject]@{
        Records = $orderedRecords
        Elements = @($orderedRecords | ForEach-Object { $_.Element })
        Signature = (@($orderedRecords | ForEach-Object {
            "{0}@{1:N0}" -f $_.Name, $_.Y
        }) -join "|")
    }
}

function Get-ImaVisibleTitleElements(
    [Windows.Automation.AutomationElement]$Root,
    [Windows.Automation.AutomationElement]$ListElement = $null
) {
    return @((Get-ImaVisibleTitleSnapshot $Root $ListElement).Elements)
}

function Get-ImaVisibleTitleSignature([Windows.Automation.AutomationElement]$Root) {
    return [string](Get-ImaVisibleTitleSnapshot $Root).Signature
}

function Wait-ImaTitleListStable(
    [Windows.Automation.AutomationElement]$Root,
    [int]$TimeoutMilliseconds = 15000
) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $started = [DateTime]::UtcNow
    $lastSignature = ""
    $stableCount = 0
    do {
        Test-ImaCancellation
        $currentRoot = Get-ImaRoot
        $signature = Get-ImaVisibleTitleSignature $currentRoot
        if (-not [string]::IsNullOrWhiteSpace($signature) -and $signature -ceq $lastSignature) {
            $stableCount++
        }
        else {
            $lastSignature = $signature
            $stableCount = 0
        }
        if (
            $stableCount -ge 2 -and
            ([DateTime]::UtcNow - $started).TotalMilliseconds -ge 1000
        ) {
            return $currentRoot
        }
        Start-ImaCancelableSleep 400
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "等待 IMA 文章列表稳定超时"
}

function Get-ImaTitleListScrollCandidate(
    [Windows.Automation.AutomationElement]$Element,
    [Windows.Rect]$ListRectangle
) {
    try {
        $pattern = $null
        if (-not $Element.TryGetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern)) {
            return $null
        }
        $scroll = [Windows.Automation.ScrollPattern]$pattern
        if (-not $scroll.Current.VerticallyScrollable) {
            return $null
        }

        $rectangle = $Element.Current.BoundingRectangle
        if ($rectangle.Width -lt 100 -or $rectangle.Height -lt 150) {
            return $null
        }

        $listCenterX = $ListRectangle.X + ($ListRectangle.Width / 2)
        $listCenterY = $ListRectangle.Y + ($ListRectangle.Height / 2)
        if (
            $listCenterX -lt $rectangle.X -or
            $listCenterX -gt $rectangle.X + $rectangle.Width -or
            $listCenterY -lt $rectangle.Y -or
            $listCenterY -gt $rectangle.Y + $rectangle.Height
        ) {
            return $null
        }

        return [pscustomobject]@{
            Element = $Element
            Pattern = $scroll
            Rectangle = $rectangle
            Area = [double]($rectangle.Width * $rectangle.Height)
        }
    }
    catch [Windows.Automation.ElementNotAvailableException] {
        return $null
    }
}

function Get-ImaTitleListScroller([Windows.Automation.AutomationElement]$Root) {
    $listElement = Get-ImaTitleListElement $Root
    if (-not $listElement) {
        return $null
    }

    $listRectangle = $listElement.Current.BoundingRectangle
    $best = $null

    # A scroll provider for the list normally lives on the list itself or one of
    # its wrappers.  That bounded path is much cheaper than materializing the
    # complete Electron accessibility tree (which may contain hundreds of notes).
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    $ancestor = $listElement
    for ($level = 0; $level -lt 16 -and $ancestor; $level++) {
        if ($ancestor.Equals($Root)) {
            break
        }
        $candidate = Get-ImaTitleListScrollCandidate $ancestor $listRectangle
        if ($candidate -and (-not $best -or $candidate.Area -lt $best.Area)) {
            $best = $candidate
        }
        $ancestor = $walker.GetParent($ancestor)
    }

    if (-not $best) {
        Write-SyncLog "文章列表祖先路径未暴露滚动器，正在执行兼容性全树回退"
        $all = $Root.FindAll(
            [Windows.Automation.TreeScope]::Descendants,
            [Windows.Automation.Condition]::TrueCondition
        )
        foreach ($element in $all) {
            $candidate = Get-ImaTitleListScrollCandidate $element $listRectangle
            if ($candidate -and (-not $best -or $candidate.Area -lt $best.Area)) {
                $best = $candidate
            }
        }
    }

    if ($best) {
        $rectangle = $listRectangle
        $best.Rectangle = $rectangle
        [void]$best.PSObject.Properties.Remove("Area")
        $best | Add-Member -NotePropertyName RangePattern -NotePropertyValue (
            Get-ImaTitleListRangePattern $Root $rectangle
        )
        Write-SyncLog (
            "文章列表滚动区域：{0:N0}x{1:N0}，可见比例 {2:N1}%" -f
            $rectangle.Width,
            $rectangle.Height,
            $best.Pattern.Current.VerticalViewSize
        )
    }
    return $best
}

function Get-ImaTitleListRangePattern(
    [Windows.Automation.AutomationElement]$Root,
    [Windows.Rect]$ContainerRectangle
) {
    $condition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::ControlTypeProperty,
        [Windows.Automation.ControlType]::ScrollBar
    )
    $scrollbars = $Root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
    $bestPattern = $null
    $bestDistance = [double]::PositiveInfinity
    foreach ($scrollbar in $scrollbars) {
        try {
            $rectangle = $scrollbar.Current.BoundingRectangle
            if ($rectangle.Height -lt 100 -or $rectangle.Height -le $rectangle.Width) {
                continue
            }
            $overlapsVertically = (
                $rectangle.Y -lt $ContainerRectangle.Y + $ContainerRectangle.Height -and
                $rectangle.Y + $rectangle.Height -gt $ContainerRectangle.Y
            )
            if (-not $overlapsVertically) {
                continue
            }

            $rangeValueObject = $null
            if (-not $scrollbar.TryGetCurrentPattern(
                [Windows.Automation.RangeValuePattern]::Pattern,
                [ref]$rangeValueObject
            )) {
                continue
            }
            $rangeValue = [Windows.Automation.RangeValuePattern]$rangeValueObject
            if ($rangeValue.Current.IsReadOnly) {
                continue
            }

            $containerRight = $ContainerRectangle.X + $ContainerRectangle.Width
            $distance = [Math]::Abs(($rectangle.X + ($rectangle.Width / 2)) - $containerRight)
            if ($distance -lt $bestDistance) {
                $bestDistance = $distance
                $bestPattern = $rangeValue
            }
        }
        catch [Windows.Automation.ElementNotAvailableException] {
            continue
        }
    }
    if ($bestPattern) {
        Write-SyncLog (
            "文章列表滚动条：范围 {0:N1}–{1:N1}" -f
            $bestPattern.Current.Minimum,
            $bestPattern.Current.Maximum
        )
    }
    return $bestPattern
}

function Set-ImaTitleListScrollPercent([object]$ScrollTarget, [double]$Percent) {
    $boundedPercent = [Math]::Max(0, [Math]::Min(100, $Percent))
    if ($ScrollTarget.RangePattern) {
        $minimum = $ScrollTarget.RangePattern.Current.Minimum
        $maximum = $ScrollTarget.RangePattern.Current.Maximum
        $value = $minimum + (($maximum - $minimum) * $boundedPercent / 100)
        $ScrollTarget.RangePattern.SetValue($value)
        return
    }
    $ScrollTarget.Pattern.SetScrollPercent(
        [Windows.Automation.ScrollPattern]::NoScroll,
        $boundedPercent
    )
}

function Invoke-ImaTitleListMouseWheel([object]$ScrollTarget, [int]$Delta) {
    $root = Get-ImaRoot
    $beforeSignature = Get-ImaVisibleTitleSignature $root
    $beforePercent = [double]$ScrollTarget.Pattern.Current.VerticalScrollPercent
    $rectangle = $ScrollTarget.Rectangle
    $x = [int]($rectangle.X + ($rectangle.Width / 2))
    $y = [int]($rectangle.Y + ($rectangle.Height / 2))
    $windowHandle = [IntPtr]$root.Current.NativeWindowHandle
    Invoke-ImaTargetWheel $windowHandle $x $y $Delta
    Start-ImaCancelableSleep 450
    $afterSignature = Get-ImaVisibleTitleSignature (Get-ImaRoot)
    $afterPercent = [double]$ScrollTarget.Pattern.Current.VerticalScrollPercent
    return (
        $afterSignature -cne $beforeSignature -or
        ($beforePercent -ge 0 -and $afterPercent -ge 0 -and [Math]::Abs($afterPercent - $beforePercent) -ge 0.01)
    )
}

function Reset-ImaTitleListToTop([object]$ScrollTarget, [switch]$Thorough) {
    if ($ScrollTarget.RangePattern) {
        for ($attempt = 0; $attempt -lt 5; $attempt++) {
            Set-ImaTitleListScrollPercent $ScrollTarget 0
            Start-ImaCancelableSleep 350
            $minimum = [double]$ScrollTarget.RangePattern.Current.Minimum
            $maximum = [double]$ScrollTarget.RangePattern.Current.Maximum
            $value = [double]$ScrollTarget.RangePattern.Current.Value
            $rangeTolerance = [Math]::Max(0.01, [Math]::Abs($maximum - $minimum) * 0.001)
            if ([Math]::Abs($value - $minimum) -le $rangeTolerance) {
                $script:CurrentTitleScrollStep = 0
                return
            }
        }
        throw "设置 IMA 文章列表到顶部后未检测到预期滚动位置"
    }

    if (-not $Thorough) {
        try {
            $currentPercent = [double]$ScrollTarget.Pattern.Current.VerticalScrollPercent
            if (Test-ImaTitleListScrollPercentAtTop $currentPercent) {
                $script:CurrentTitleScrollStep = 0
                return
            }
        }
        catch {
            # provider 未暴露可靠百分比时继续使用滚轮位移确认。
        }
    }

    # ScrollPattern already exposes an absolute percentage. Prefer one verified
    # jump over walking back through every page; broken Electron providers still
    # fall through to the conservative mouse-wheel confirmation below.
    try {
        $currentPercent = [double]$ScrollTarget.Pattern.Current.VerticalScrollPercent
        if (Test-ImaTitleListScrollPercentKnown $currentPercent) {
            $ScrollTarget.Pattern.SetScrollPercent(
                [Windows.Automation.ScrollPattern]::NoScroll,
                0
            )
            Start-ImaCancelableSleep 250
            $verifiedPercent = [double]$ScrollTarget.Pattern.Current.VerticalScrollPercent
            if (Test-ImaTitleListScrollPercentAtTop $verifiedPercent) {
                $script:CurrentTitleScrollStep = 0
                Write-SyncLog "IMA 文章列表已通过滚动百分比直接复位到顶部"
                return
            }
        }
    }
    catch {
        Write-SyncLog "IMA 文章列表不支持直接复位，正在使用滚轮确认顶部"
    }

    $maximumAttempts = 120
    $stalledCount = 0
    $confirmedTop = $false
    for ($attempt = 0; $attempt -lt $maximumAttempts; $attempt++) {
        $moved = Invoke-ImaTitleListMouseWheel $ScrollTarget 1200
        if ($moved) {
            $stalledCount = 0
        }
        else {
            $stalledCount++
            if ($stalledCount -ge 2) {
                $confirmedTop = $true
                break
            }
        }
    }
    if (-not $confirmedTop) {
        throw "滚动 IMA 文章列表后仍无法确认已到达顶部"
    }
    $script:CurrentTitleScrollStep = 0
}

function Test-ImaTitleListScrollPercentKnown([double]$Percent) {
    return (
        -not [double]::IsNaN($Percent) -and
        -not [double]::IsInfinity($Percent) -and
        $Percent -ge 0 -and
        $Percent -le 100
    )
}

function Test-ImaTitleListScrollPercentAtTop([double]$Percent) {
    return (
        -not [double]::IsNaN($Percent) -and
        -not [double]::IsInfinity($Percent) -and
        $Percent -ge 0 -and
        $Percent -le 0.1
    )
}

function Test-ImaShouldSkipTitleListRestore(
    [bool]$ScanMoved,
    [double]$StartingPercent,
    [double]$CurrentPercent
) {
    return (
        -not $ScanMoved -and
        (Test-ImaTitleListScrollPercentAtTop $CurrentPercent)
    )
}

function Add-ImaVisibleTitles(
    [Windows.Automation.AutomationElement]$Root,
    [hashtable]$Seen,
    [Collections.Generic.List[string]]$Titles,
    [double]$ScrollPercent,
    [int]$ScrollStep,
    [object]$Snapshot = $null
) {
    if (-not $Snapshot) {
        $Snapshot = Get-ImaVisibleTitleSnapshot $Root
    }
    foreach ($record in @($Snapshot.Records)) {
        Test-ImaCancellation
        $name = [string]$record.Name
        if ($Seen.ContainsKey($name)) {
            continue
        }
        $Seen[$name] = $true
        $script:TitleScrollPercentByName[$name] = $ScrollPercent
        $script:TitleScrollStepByName[$name] = $ScrollStep
        $Titles.Add($name)
    }
}

function Invoke-ImaVisibleListTitle(
    [Windows.Automation.AutomationElement]$Root,
    [string]$Title
) {
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    foreach ($element in @(Get-ImaVisibleTitleElements $Root)) {
        if ($element.Current.Name -cne $Title) {
            continue
        }
        $candidate = $element
        for ($level = 0; $level -lt 10 -and $candidate; $level++) {
            $pattern = $null
            if ($candidate.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                ([Windows.Automation.InvokePattern]$pattern).Invoke()
                return
            }
            $candidate = $walker.GetParent($candidate)
        }
    }
    throw "IMA 目标文章在列表容器中不可见或无法调用：$Title"
}

function Get-ImaRecentTitles([Windows.Automation.AutomationElement]$Root, [int]$Limit) {
    $script:TitleScrollPercentByName = @{}
    $script:TitleScrollStepByName = @{}
    $script:CurrentTitleScrollStep = 0
    $seen = @{}
    $titles = New-Object Collections.Generic.List[string]
    $scrollTarget = Get-ImaTitleListScroller $Root

    if (-not $scrollTarget) {
        Add-ImaVisibleTitles $Root $seen $titles 0 0
        return @(Select-ImaRecentTitles $titles.ToArray() $Limit)
    }

    $scroller = $scrollTarget.Pattern
    $originalPercent = [double]$scroller.Current.VerticalScrollPercent
    $scanMoved = $false
    try {
        Reset-ImaTitleListToTop $scrollTarget
        Start-ImaCancelableSleep 350

        $requestedPercent = 0.0
        for ($page = 0; $page -lt 100; $page++) {
            Test-ImaCancellation
            $rootAtPage = Get-ImaRoot
            Add-ImaVisibleTitles $rootAtPage $seen $titles $requestedPercent $page

            if ($titles.Count -ge $Limit) {
                if ($page -eq 0) {
                    Write-SyncLog "首屏已满足检查数量，跳过全量扫描"
                }
                break
            }

            if ($scrollTarget.RangePattern -and $requestedPercent -ge 99.9) {
                break
            }

            $step = [Math]::Max(5, $scroller.Current.VerticalViewSize * 0.75)
            $nextPercent = [Math]::Min(100, $requestedPercent + $step)
            if ($scrollTarget.RangePattern) {
                Set-ImaTitleListScrollPercent $scrollTarget $nextPercent
                Start-ImaCancelableSleep 350
                $moved = $true
            }
            else {
                $moved = Invoke-ImaTitleListMouseWheel $scrollTarget -900
            }
            if ($moved) {
                $scanMoved = $true
            }
            $requestedPercent = $nextPercent

            if (-not $moved) {
                Write-SyncLog "IMA 文章列表滚动未产生可验证的位移，已停止继续翻页"
                break
            }
        }
    }
    finally {
        try {
            $currentPercent = try {
                [double]$scroller.Current.VerticalScrollPercent
            }
            catch {
                [double]::NaN
            }
            if (Test-ImaShouldSkipTitleListRestore $scanMoved $originalPercent $currentPercent) {
                $script:CurrentTitleScrollStep = 0
                Write-SyncLog "IMA 文章列表本轮未移动且已确认位于顶部，已跳过重复复位"
            }
            else {
                Reset-ImaTitleListToTop $scrollTarget
                Start-ImaCancelableSleep 350
            }
        }
        catch {
            Write-SyncLog "恢复 IMA 文章列表位置时出错：$($_.Exception.Message)"
        }
    }

    $recent = @(Select-ImaRecentTitles $titles.ToArray() $Limit)
    Write-SyncLog "文章列表：在目标容器内发现 $($titles.Count) 篇匹配标题，选取最近 $($recent.Count) 篇"
    return $recent
}

function Invoke-ImaArticleTitle([string]$Title) {
    # A previous attempt can leave the article window open even though the
    # caller is about to invoke this title again. Reuse that exact window so
    # retries and resumed syncs cannot create a duplicate article window.
    $presence = Get-ImaArticleWindowPresence $Title
    if ($presence.State -eq "Unknown") {
        throw "无法确认 $Title 是否已打开；为避免重复窗口，本轮不再点击该标题"
    }

    $existingArticleWindow = $null
    if ($presence.State -eq "Present") {
        try {
            $existingArticleWindow = Find-ImaArticleWindow $Title
        }
        catch {
            # The exact top-level window is sufficient proof that the article
            # is open; Wait-ImaDocument will resolve a rebuilding Document.
            $existingArticleWindow = $null
        }
        $script:CurrentArticleTitle = $Title
        if ($existingArticleWindow) {
            Set-ImaArticleWindowCache $Title $existingArticleWindow
        }
        else {
            [void]$script:StableDocumentTitles.Remove($Title)
            Clear-ImaBodyScrollerCache $Title
            Clear-ImaArticleWindowCache $Title
        }
        Write-SyncLog "$Title 已处于打开状态，直接复用现有文章窗口"
        return
    }

    try {
        $existingArticleWindow = Find-ImaArticleWindow $Title
    }
    catch {
        throw "无法确认 $Title 是否已打开；为避免重复窗口，本轮不再点击该标题：$($_.Exception.Message)"
    }
    if ($existingArticleWindow) {
        $script:CurrentArticleTitle = $Title
        Set-ImaArticleWindowCache $Title $existingArticleWindow
        Write-SyncLog "$Title 已处于打开状态，直接复用现有文章窗口"
        return
    }

    $script:CurrentArticleTitle = ""
    [void]$script:StableDocumentTitles.Remove($Title)
    Clear-ImaBodyScrollerCache $Title
    Clear-ImaArticleWindowCache $Title
    $root = Get-ImaRoot
    $targetStep = if ($script:TitleScrollStepByName.ContainsKey($Title)) {
        [int]$script:TitleScrollStepByName[$Title]
    }
    else {
        0
    }
    if (@(Get-ImaVisibleTitleElements $root | Where-Object { $_.Current.Name -ceq $Title }).Count -gt 0) {
        try {
            Invoke-ImaVisibleListTitle $root $Title
            $script:CurrentTitleScrollStep = $targetStep
            return
        }
        catch {
            # InvokePattern may complete the click before its provider throws.
            # Retrying through the recorded position could therefore open a
            # second window, so defer this title to the next sync instead.
            throw "打开 $Title 时无法确认标题点击是否成功；本轮不再次点击：$($_.Exception.Message)"
        }
    }

    if (-not $script:TitleScrollPercentByName.ContainsKey($Title)) {
        throw "IMA 文章列表中未记录标题位置：$Title"
    }

    $scrollTarget = Get-ImaTitleListScroller $root
    if (-not $scrollTarget) {
        throw "未找到 IMA 文章列表滚动区域：$Title"
    }
    if ($scrollTarget.RangePattern) {
        Set-ImaTitleListScrollPercent $scrollTarget ([double]$script:TitleScrollPercentByName[$Title])
        Start-ImaCancelableSleep 350
    }
    else {
        $stepDelta = $targetStep - $script:CurrentTitleScrollStep
        if ($stepDelta -ne 0) {
            $wheelDelta = if ($stepDelta -gt 0) { -900 } else { 900 }
            for ($step = 0; $step -lt [Math]::Abs($stepDelta); $step++) {
                Test-ImaCancellation
                if (-not (Invoke-ImaTitleListMouseWheel $scrollTarget $wheelDelta)) {
                    throw "滚动文章列表时没有检测到实际位移：$Title"
                }
            }
        }
    }
    $script:CurrentTitleScrollStep = $targetStep
    Invoke-ImaVisibleListTitle (Get-ImaRoot) $Title
}

function Read-ImaCompleteArticleWithRetry([string]$Title) {
    try {
        return Read-ImaCompleteArticle $Title
    }
    catch [OperationCanceledException] {
        throw
    }
    catch {
        $firstError = $_.Exception.Message
        if (-not (Test-ImaTransientExtractionError $firstError)) {
            throw
        }

        # Keep the current article open. Re-resolve its UIA elements because
        # Chromium may have rebuilt the Document or scroll provider while the
        # first read was in progress, but never click the list title again.
        Write-SyncLog "$Title 首次正文提取遇到瞬态错误，保留当前文章窗口并清理缓存后原位重试一次：$firstError"
        Clear-ImaBodyScrollerCache $Title
        Clear-ImaArticleWindowCache $Title
        [void]$script:StableDocumentTitles.Remove($Title)
        Start-ImaCancelableSleep 500

        $presence = Get-ImaArticleWindowPresence $Title
        if ($presence.State -eq "Unknown") {
            throw "$Title 首次正文提取失败后无法确认原文章窗口是否仍存在；本轮不重新打开"
        }
        if ($presence.State -eq "Absent") {
            try {
                $existingArticleWindow = Find-ImaArticleWindow $Title
            }
            catch {
                throw "$Title 首次正文提取失败后无法确认原文章窗口是否仍存在；本轮不重新打开：$($_.Exception.Message)"
            }
            if (-not $existingArticleWindow) {
                throw "$Title 首次正文提取失败后原文章窗口已不存在；本轮不重新打开"
            }
        }
        [void](Wait-ImaDocument $Title)
        return Read-ImaCompleteArticle $Title
    }
}

function Get-ImaDocumentReadinessState([string]$Text, [bool]$HasBodyScroller) {
    try {
        $header = Get-ImaUpdateHeader $Text
        $tocText = $header.Text.Substring(0, $header.MarkerIndex)
        $tocNames = @(Get-ImaTocCandidateNames $tocText)
        $body = Get-ImaBodyChunk $header.Text
        if (-not $HasBodyScroller) {
            return [pscustomobject]@{ Ready = $false; Signature = ""; Reason = "正文滚动器尚未就绪" }
        }
        if ($tocNames.Count -lt 1) {
            return [pscustomobject]@{ Ready = $false; Signature = ""; Reason = "目录尚未加载" }
        }
        if ($body.Length -lt 50) {
            return [pscustomobject]@{ Ready = $false; Signature = ""; Reason = "正文顶部内容尚未加载" }
        }

        # 初始就绪只依赖可验证的结构边界：更新时间、TOC 数量、正文和滚动器存在。
        # IMA 会持续改写正文可见文本和部分 TOC 文案；这些内容会在逐视窗读取时
        # 再验证，不能作为打开文章的硬阻塞条件。
        $signatureText = "{0}|{1}" -f `
            $header.Date.ToString("yyyy-MM-dd", [Globalization.CultureInfo]::InvariantCulture),
            $tocNames.Count
        return [pscustomobject]@{
            Ready = $true
            Signature = Get-ImaViewportFingerprint $signatureText
            Reason = ""
            TocCount = $tocNames.Count
        }
    }
    catch {
        return [pscustomobject]@{ Ready = $false; Signature = ""; Reason = $_.Exception.Message }
    }
}

function Get-ImaBodyScrollerCacheKey(
    [string]$Title,
    [int]$ProcessId,
    [long]$WindowHandle,
    [string]$DocumentRuntimeId = ""
) {
    return "{0}{1}{2}{1}{3}{1}{4}" -f `
        $Title,
        ([char]0x001F),
        $ProcessId,
        $WindowHandle,
        $DocumentRuntimeId
}

function Clear-ImaBodyScrollerCache([string]$Title = "") {
    if ([string]::IsNullOrWhiteSpace($Title)) {
        $script:BodyScrollerCache = @{}
        return
    }

    $prefix = "$Title$([char]0x001F)"
    foreach ($key in @($script:BodyScrollerCache.Keys)) {
        if (([string]$key).StartsWith($prefix, [StringComparison]::Ordinal)) {
            [void]$script:BodyScrollerCache.Remove($key)
        }
    }
}

function Test-ImaBodyScrollerCacheEntry([object]$Entry) {
    if ($null -eq $Entry -or $null -eq $Entry.Pattern) {
        return $false
    }
    if ($null -ne $Entry.Element) {
        [void]$Entry.Element.Current.ProcessId
    }
    return [bool]$Entry.Pattern.Current.VerticallyScrollable
}

function Get-ImaCachedBodyScrollerEntry(
    [string]$Key,
    [scriptblock]$Resolver,
    [scriptblock]$Validator = $null
) {
    if ($script:BodyScrollerCache.ContainsKey($Key)) {
        $cached = $script:BodyScrollerCache[$Key]
        try {
            $valid = if ($null -ne $Validator) {
                [bool](& $Validator $cached)
            }
            else {
                Test-ImaBodyScrollerCacheEntry $cached
            }
            if ($valid) {
                return $cached
            }
        }
        catch [Windows.Automation.ElementNotAvailableException] {
            # IMA 重建文章 WebView 后，旧 AutomationElement/Pattern 会失效。
        }
        catch [System.InvalidOperationException] {
            # UIA provider 也可能把同一种失效报告为 InvalidOperationException。
        }
        catch [System.Runtime.InteropServices.COMException] {
            # Chromium UIA provider 偶尔用 COMException 表示远端元素已销毁。
        }
        catch [System.Management.Automation.MethodInvocationException] {
            $inner = $_.Exception.InnerException
            if (
                $inner -isnot [Windows.Automation.ElementNotAvailableException] -and
                $inner -isnot [System.InvalidOperationException] -and
                $inner -isnot [System.Runtime.InteropServices.COMException]
            ) {
                throw
            }
        }
        [void]$script:BodyScrollerCache.Remove($Key)
    }

    $resolved = & $Resolver
    if ($null -eq $resolved) {
        throw "正文滚动器解析器未返回有效元素"
    }
    $script:BodyScrollerCache[$Key] = $resolved
    return $resolved
}

function Get-ImaBodyScrollerReadinessState([scriptblock]$Resolver) {
    try {
        $scroller = & $Resolver
        if ($null -eq $scroller) {
            return [pscustomobject]@{
                Ready = $false
                Reason = "正文滚动器解析结果为空"
            }
        }
        if (-not [bool]$scroller.Current.VerticallyScrollable) {
            return [pscustomobject]@{
                Ready = $false
                Reason = "正文滚动器不支持垂直滚动"
            }
        }
        return [pscustomobject]@{ Ready = $true; Reason = "" }
    }
    catch {
        return [pscustomobject]@{
            Ready = $false
            Reason = "正文滚动器解析失败：$($_.Exception.Message)"
        }
    }
}

function Get-ImaDocumentReadinessProbe([object]$ArticleWindow) {
    $text = Get-ImaRawDocumentText $ArticleWindow.Document
    $bodyRoot = $ArticleWindow.Root
    $bodyDocument = $ArticleWindow.Document
    $scrollerState = Get-ImaBodyScrollerReadinessState {
        Get-ImaBodyScroller $bodyRoot $bodyDocument
    }
    if (-not $scrollerState.Ready) {
        return [pscustomobject]@{
            Ready = $false
            Signature = ""
            Reason = [string]$scrollerState.Reason
        }
    }
    return Get-ImaDocumentReadinessState $text $true
}

function New-ImaArticleStabilityTracker([datetime]$Now = ([DateTime]::UtcNow)) {
    return [pscustomobject]@{
        Started = $Now
        LastGrowth = $Now
        MaximumTocCount = 0
        CurrentTocCount = -1
        MaximumCountSamples = 0
        TemporaryFailures = 0
        LastReason = "尚未找到文章窗口"
    }
}

function Update-ImaArticleStabilityTracker(
    [object]$Tracker,
    [object]$Probe,
    [string]$FailureReason = "",
    [datetime]$Now = ([DateTime]::UtcNow)
) {
    if ($null -eq $Probe -or -not $Probe.Ready) {
        $Tracker.CurrentTocCount = -1
        $Tracker.TemporaryFailures++
        $Tracker.LastReason = if (-not [string]::IsNullOrWhiteSpace($FailureReason)) {
            $FailureReason
        }
        elseif ($null -ne $Probe) {
            [string]$Probe.Reason
        }
        else {
            "文章结构探测暂时不可用"
        }
        return
    }

    $count = [int]$Probe.TocCount
    $Tracker.CurrentTocCount = $count
    if ($count -gt $Tracker.MaximumTocCount) {
        $Tracker.MaximumTocCount = $count
        $Tracker.MaximumCountSamples = 1
        $Tracker.LastGrowth = $Now
        $Tracker.LastReason = "目录增长到 $count 项，等待高水位稳定"
    }
    elseif ($count -eq $Tracker.MaximumTocCount) {
        $Tracker.MaximumCountSamples++
        $Tracker.LastReason = "目录高水位 $count 项已观测 $($Tracker.MaximumCountSamples) 次"
    }
    else {
        $Tracker.TemporaryFailures++
        $Tracker.LastReason = "目录瞬时回落到 $count 项，已保留高水位 $($Tracker.MaximumTocCount) 项"
    }
}

function Test-ImaArticleStabilityReady(
    [object]$Tracker,
    [datetime]$Now,
    [int]$MinimumObservationMilliseconds,
    [int]$QuietMilliseconds,
    [int]$StableSamples
) {
    return (
        $Tracker.MaximumTocCount -gt 0 -and
        $Tracker.CurrentTocCount -eq $Tracker.MaximumTocCount -and
        $Tracker.MaximumCountSamples -ge $StableSamples -and
        ($Now - $Tracker.Started).TotalMilliseconds -ge $MinimumObservationMilliseconds -and
        ($Now - $Tracker.LastGrowth).TotalMilliseconds -ge $QuietMilliseconds
    )
}

function Format-ImaArticleStabilityTimeout([string]$Title, [object]$Tracker) {
    $template = (
        "等待 IMA 文章结构稳定超时：$Title（最大目录 {0} 项，当前 {1} 项，" +
        "高水位有效样本 {2} 次，临时失败 {3} 次；最后状态：{4}）"
    )
    return ($template -f
        $Tracker.MaximumTocCount,
        $Tracker.CurrentTocCount,
        $Tracker.MaximumCountSamples,
        $Tracker.TemporaryFailures,
        $Tracker.LastReason
    )
}

function Wait-ImaArticleStable(
    [string]$Title,
    [int]$TimeoutMilliseconds = 90000,
    [int]$MinimumObservationMilliseconds = 3000,
    [int]$QuietMilliseconds = 2000,
    [int]$StableSamples = 3,
    [int]$PollMilliseconds = 250
) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $started = [DateTime]::UtcNow
    $tracker = New-ImaArticleStabilityTracker $started
    do {
        $articleWindow = Find-ImaArticleWindow $Title
        if ($articleWindow) {
            $script:CurrentArticleTitle = $Title
            try {
                $probe = Get-ImaDocumentReadinessProbe $articleWindow
                $now = [DateTime]::UtcNow
                [void](Update-ImaArticleStabilityTracker $tracker $probe "" $now)
                if (Test-ImaArticleStabilityReady `
                    $tracker `
                    $now `
                    $MinimumObservationMilliseconds `
                    $QuietMilliseconds `
                    $StableSamples
                ) {
                    Set-ImaArticleWindowCache $Title $articleWindow
                    return [pscustomobject]@{
                        Root = $articleWindow.Root
                        Document = $articleWindow.Document
                        TocCount = $tracker.MaximumTocCount
                    }
                }
            }
            catch [Windows.Automation.ElementNotAvailableException] {
                [void](Update-ImaArticleStabilityTracker `
                    $tracker `
                    $null `
                    "文章窗口正在重建" `
                    ([DateTime]::UtcNow)
                )
            }
            catch {
                [void](Update-ImaArticleStabilityTracker `
                    $tracker `
                    $null `
                    $_.Exception.Message `
                    ([DateTime]::UtcNow)
                )
            }
        }
        else {
            [void](Update-ImaArticleStabilityTracker `
                $tracker `
                $null `
                "尚未找到文章窗口" `
                ([DateTime]::UtcNow)
            )
        }
        Start-ImaCancelableSleep $PollMilliseconds
    } while ([DateTime]::UtcNow -lt $deadline)
    throw (Format-ImaArticleStabilityTimeout $Title $tracker)
}

function Wait-ImaDocument([string]$Title, [int]$TimeoutMilliseconds = 90000) {
    if ($script:StableDocumentTitles.ContainsKey($Title)) {
        $articleWindow = Get-ImaArticleWindow $Title
        if ($articleWindow) {
            $script:CurrentArticleTitle = $Title
            return $articleWindow.Document
        }
        [void]$script:StableDocumentTitles.Remove($Title)
        Clear-ImaArticleWindowCache $Title
        Clear-ImaBodyScrollerCache $Title
    }

    $stableArticle = Wait-ImaArticleStable $Title $TimeoutMilliseconds
    $script:StableDocumentTitles[$Title] = $true
    Write-SyncLog "$Title 文章结构已稳定：目录 $($stableArticle.TocCount) 项"
    return $stableArticle.Document
}

function Get-ImaRectangleMetrics([object]$CandidateRectangle, [object]$DocumentRectangle) {
    $left = [Math]::Max([double]$CandidateRectangle.X, [double]$DocumentRectangle.X)
    $top = [Math]::Max([double]$CandidateRectangle.Y, [double]$DocumentRectangle.Y)
    $right = [Math]::Min(
        [double]$CandidateRectangle.X + [double]$CandidateRectangle.Width,
        [double]$DocumentRectangle.X + [double]$DocumentRectangle.Width
    )
    $bottom = [Math]::Min(
        [double]$CandidateRectangle.Y + [double]$CandidateRectangle.Height,
        [double]$DocumentRectangle.Y + [double]$DocumentRectangle.Height
    )
    $intersectionWidth = [Math]::Max(0, $right - $left)
    $intersectionHeight = [Math]::Max(0, $bottom - $top)
    $intersectionArea = $intersectionWidth * $intersectionHeight
    $candidateArea = [double]$CandidateRectangle.Width * [double]$CandidateRectangle.Height
    $documentArea = [double]$DocumentRectangle.Width * [double]$DocumentRectangle.Height
    $documentCenterX = [double]$DocumentRectangle.X + ([double]$DocumentRectangle.Width / 2)
    $documentCenterY = [double]$DocumentRectangle.Y + ([double]$DocumentRectangle.Height / 2)
    return [pscustomobject]@{
        IntersectionArea = $intersectionArea
        DocumentCoverage = if ($documentArea -gt 0) { $intersectionArea / $documentArea } else { 0 }
        WidthCoverage = if ([double]$DocumentRectangle.Width -gt 0) {
            $intersectionWidth / [double]$DocumentRectangle.Width
        }
        else {
            0
        }
        ContainsDocumentCenter = (
            $documentCenterX -ge [double]$CandidateRectangle.X -and
            $documentCenterX -le ([double]$CandidateRectangle.X + [double]$CandidateRectangle.Width) -and
            $documentCenterY -ge [double]$CandidateRectangle.Y -and
            $documentCenterY -le ([double]$CandidateRectangle.Y + [double]$CandidateRectangle.Height)
        )
        CandidateArea = $candidateArea
    }
}

function Select-ImaBodyScrollerCandidate([object[]]$Candidates, [object]$DocumentRectangle) {
    $eligible = New-Object Collections.Generic.List[object]
    foreach ($candidate in @($Candidates)) {
        if (
            -not $candidate.VerticallyScrollable -or
            $candidate.IsOffscreen -or
            $candidate.IsTitleList
        ) {
            continue
        }
        $rectangle = $candidate.Rectangle
        if ([double]$rectangle.Width -lt 250 -or [double]$rectangle.Height -lt 150) {
            continue
        }
        $metrics = Get-ImaRectangleMetrics $rectangle $DocumentRectangle
        if (
            -not $candidate.IsAncestor -and
            (
                $metrics.IntersectionArea -le 0 -or
                $metrics.WidthCoverage -lt 0.45 -or
                (-not $metrics.ContainsDocumentCenter -and $metrics.DocumentCoverage -lt 0.35)
            )
        ) {
            continue
        }
        $eligible.Add([pscustomobject]@{
            Candidate = $candidate
            Priority = if ($candidate.IsAncestor) {
                0
            }
            elseif ($candidate.IsDomScrollContent -and $candidate.IsDocumentDescendant) {
                1
            }
            elseif ($candidate.IsDocumentDescendant) {
                2
            }
            else {
                3
            }
            Area = [double]$metrics.CandidateArea
        })
    }
    $selected = @($eligible.ToArray() | Sort-Object -Property Priority, Area | Select-Object -First 1)
    if ($selected.Count -eq 0) {
        return $null
    }
    return $selected[0].Candidate
}

function Test-ImaTitleListScrollerGeometry([object]$Rectangle, [object]$TitleListRectangle) {
    if (
        $null -eq $TitleListRectangle -or
        [double]$TitleListRectangle.Width -le 0 -or
        [double]$TitleListRectangle.Height -le 0
    ) {
        return $false
    }
    $metrics = Get-ImaRectangleMetrics $Rectangle $TitleListRectangle
    $listArea = [double]$TitleListRectangle.Width * [double]$TitleListRectangle.Height
    return (
        $listArea -gt 0 -and
        ($metrics.IntersectionArea / $listArea) -ge 0.7 -and
        [double]$Rectangle.Width -le ([double]$TitleListRectangle.Width * 1.6)
    )
}

function Select-ImaKnownBodyScrollerCandidate([object[]]$Candidates) {
    $selected = @($Candidates | Where-Object {
        $_.IsDomScrollContent -and
        $_.IsDocumentDescendant -and
        $_.VerticallyScrollable -and
        -not $_.IsTitleList
    } | Select-Object -First 1)
    if ($selected.Count -eq 0) {
        return $null
    }
    return $selected[0]
}

function Get-ImaKnownBodyScrollerCandidate(
    [Windows.Automation.AutomationElement]$Root,
    [Windows.Automation.AutomationElement]$Document,
    [object]$DocumentRectangle
) {
    $script:LastKnownBodyScrollerReason = "正在检查 Document 祖先路径"
    # 祖先路径是有界且最可靠的绑定，先检查它，不触发任何全树枚举。
    $ancestorCandidates = New-Object Collections.Generic.List[object]
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    $element = $Document
    for ($level = 0; $level -lt 24 -and $element; $level++) {
        try {
            $pattern = $null
            if ($element.TryGetCurrentPattern(
                [Windows.Automation.ScrollPattern]::Pattern,
                [ref]$pattern
            )) {
                $scroll = [Windows.Automation.ScrollPattern]$pattern
                $ancestorCandidates.Add([pscustomobject]@{
                    Element = $element
                    Pattern = $scroll
                    Rectangle = $element.Current.BoundingRectangle
                    IsAncestor = $true
                    IsDocumentDescendant = $false
                    IsDomScrollContent = ($element.Current.AutomationId -eq "dom-scroll-content")
                    IsOffscreen = [bool]$element.Current.IsOffscreen
                    VerticallyScrollable = [bool]$scroll.Current.VerticallyScrollable
                    IsTitleList = ($element.Current.AutomationId -eq "shareKnowledgeContentList")
                    Resolution = "ancestor"
                })
            }
            if ($element -eq $Root) {
                break
            }
            $element = $walker.GetParent($element)
        }
        catch [Windows.Automation.ElementNotAvailableException] {
            break
        }
        catch [System.InvalidOperationException] {
            break
        }
        catch [System.Runtime.InteropServices.COMException] {
            break
        }
        catch [System.Management.Automation.MethodInvocationException] {
            $inner = $_.Exception.InnerException
            if (
                $inner -isnot [Windows.Automation.ElementNotAvailableException] -and
                $inner -isnot [System.InvalidOperationException] -and
                $inner -isnot [System.Runtime.InteropServices.COMException]
            ) {
                throw
            }
            break
        }
    }
    $ancestor = Select-ImaBodyScrollerCandidate ($ancestorCandidates.ToArray()) $DocumentRectangle
    if ($ancestor) {
        $script:LastKnownBodyScrollerReason = "已命中 Document 祖先滚动器"
        return $ancestor
    }

    # 当前版 IMA 在文章 Document 下直接暴露这个正文容器。FindFirst 会在
    # 命中后立即停止，避免原先 FindAll(TrueCondition) 的 15–30 秒遍历。
    $automationIdCondition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::AutomationIdProperty,
        "dom-scroll-content"
    )
    try {
        $domScrollContent = $Document.FindFirst(
            [Windows.Automation.TreeScope]::Descendants,
            $automationIdCondition
        )
    }
    catch [Windows.Automation.ElementNotAvailableException] {
        $script:LastKnownBodyScrollerReason = "查找 dom-scroll-content 时 Document 已失效"
        return $null
    }
    catch [System.InvalidOperationException] {
        $script:LastKnownBodyScrollerReason = "查找 dom-scroll-content 时 UIA provider 暂时不可用"
        return $null
    }
    catch [System.Runtime.InteropServices.COMException] {
        $script:LastKnownBodyScrollerReason = "查找 dom-scroll-content 时 Chromium UIA 连接已失效"
        return $null
    }
    catch [System.Management.Automation.MethodInvocationException] {
        $inner = $_.Exception.InnerException
        if (
            $inner -isnot [Windows.Automation.ElementNotAvailableException] -and
            $inner -isnot [System.InvalidOperationException] -and
            $inner -isnot [System.Runtime.InteropServices.COMException]
        ) {
            throw
        }
        $script:LastKnownBodyScrollerReason = "查找 dom-scroll-content 时 UIA 元素已失效"
        return $null
    }
    if (-not $domScrollContent) {
        $script:LastKnownBodyScrollerReason = "当前 Document 下未找到 dom-scroll-content"
        return $null
    }
    try {
        $pattern = $null
        if (-not $domScrollContent.TryGetCurrentPattern(
            [Windows.Automation.ScrollPattern]::Pattern,
            [ref]$pattern
        )) {
            $script:LastKnownBodyScrollerReason = "dom-scroll-content 未提供 ScrollPattern"
            return $null
        }
        $scroll = [Windows.Automation.ScrollPattern]$pattern
        $candidate = [pscustomobject]@{
            Element = $domScrollContent
            Pattern = $scroll
            # Chromium 对这个已知容器的 BoundingRectangle/IsOffscreen 报告并不可靠；
            # 层级（当前 Document 后代）+ 唯一 AutomationId 已足以安全绑定。
            Rectangle = $DocumentRectangle
            IsAncestor = $false
            IsDocumentDescendant = $true
            IsDomScrollContent = $true
            IsOffscreen = $false
            VerticallyScrollable = [bool]$scroll.Current.VerticallyScrollable
            IsTitleList = $false
            Resolution = "dom-scroll-content"
        }
        $selected = Select-ImaKnownBodyScrollerCandidate @($candidate)
        if ($selected) {
            $script:LastKnownBodyScrollerReason = "已命中 dom-scroll-content"
            return $selected
        }
        $script:LastKnownBodyScrollerReason = "dom-scroll-content 的 ScrollPattern 不支持垂直滚动"
        return $null
    }
    catch [Windows.Automation.ElementNotAvailableException] {
        $script:LastKnownBodyScrollerReason = "读取 dom-scroll-content 时元素已失效"
        return $null
    }
    catch [System.InvalidOperationException] {
        $script:LastKnownBodyScrollerReason = "读取 dom-scroll-content 时 UIA provider 暂时不可用"
        return $null
    }
    catch [System.Runtime.InteropServices.COMException] {
        $script:LastKnownBodyScrollerReason = "读取 dom-scroll-content 时 Chromium UIA 连接已失效"
        return $null
    }
    catch [System.Management.Automation.MethodInvocationException] {
        $inner = $_.Exception.InnerException
        if (
            $inner -isnot [Windows.Automation.ElementNotAvailableException] -and
            $inner -isnot [System.InvalidOperationException] -and
            $inner -isnot [System.Runtime.InteropServices.COMException]
        ) {
            throw
        }
        $script:LastKnownBodyScrollerReason = "读取 dom-scroll-content 时 UIA 元素已失效"
        return $null
    }
}

function Resolve-ImaBodyScroller(
    [Windows.Automation.AutomationElement]$Root,
    [Windows.Automation.AutomationElement]$Document
) {
    if (-not $Document) {
        throw "IMA 文章 Document 为空，无法绑定正文滚动区域"
    }
    $documentRectangle = $Document.Current.BoundingRectangle
    if ($documentRectangle.Width -le 0 -or $documentRectangle.Height -le 0) {
        throw "IMA 文章 Document 没有有效的屏幕区域"
    }

    $knownScroller = Get-ImaKnownBodyScrollerCandidate $Root $Document $documentRectangle
    if ($knownScroller) {
        if ($knownScroller.Resolution -eq "dom-scroll-content") {
            Write-SyncLog (
                "正文滚动器使用 dom-scroll-content 快速路径：{0:N0}x{1:N0}" -f
                $knownScroller.Rectangle.Width,
                $knownScroller.Rectangle.Height
            )
        }
        return $knownScroller
    }

    $titleListElement = Get-ImaTitleListElement $Root
    $titleListRectangle = if ($titleListElement) {
        $titleListElement.Current.BoundingRectangle
    }
    else {
        $null
    }
    $candidates = New-Object Collections.Generic.List[object]
    $ancestorRuntimeIds = @{}
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    $element = $Document
    for ($level = 0; $level -lt 24 -and $element; $level++) {
        try {
            $runtimeId = ($element.GetRuntimeId() -join ".")
            $ancestorRuntimeIds[$runtimeId] = $true
            $pattern = $null
            if ($element.TryGetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern)) {
                $scroll = [Windows.Automation.ScrollPattern]$pattern
                $rectangle = $element.Current.BoundingRectangle
                $candidates.Add([pscustomobject]@{
                    Element = $element
                    Pattern = $scroll
                    Rectangle = $rectangle
                    IsAncestor = $true
                    IsDocumentDescendant = $false
                    IsDomScrollContent = ($element.Current.AutomationId -eq "dom-scroll-content")
                    IsOffscreen = [bool]$element.Current.IsOffscreen
                    VerticallyScrollable = [bool]$scroll.Current.VerticallyScrollable
                    IsTitleList = (
                        $element.Current.AutomationId -eq "shareKnowledgeContentList" -or
                        (Test-ImaTitleListScrollerGeometry $rectangle $titleListRectangle)
                    )
                })
            }
            $element = $walker.GetParent($element)
        }
        catch [Windows.Automation.ElementNotAvailableException] {
            break
        }
    }

    $knownRuntimeIds = @{}
    foreach ($runtimeId in $ancestorRuntimeIds.Keys) {
        $knownRuntimeIds[$runtimeId] = $true
    }
    $documentDescendants = $Document.FindAll(
        [Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.Condition]::TrueCondition
    )
    foreach ($candidateElement in $documentDescendants) {
        try {
            $runtimeId = ($candidateElement.GetRuntimeId() -join ".")
            $knownRuntimeIds[$runtimeId] = $true
            $pattern = $null
            if (-not $candidateElement.TryGetCurrentPattern(
                [Windows.Automation.ScrollPattern]::Pattern,
                [ref]$pattern
            )) {
                continue
            }
            $scroll = [Windows.Automation.ScrollPattern]$pattern
            $rectangle = $candidateElement.Current.BoundingRectangle
            $candidates.Add([pscustomobject]@{
                Element = $candidateElement
                Pattern = $scroll
                Rectangle = $rectangle
                IsAncestor = $false
                IsDocumentDescendant = $true
                IsDomScrollContent = ($candidateElement.Current.AutomationId -eq "dom-scroll-content")
                IsOffscreen = [bool]$candidateElement.Current.IsOffscreen
                VerticallyScrollable = [bool]$scroll.Current.VerticallyScrollable
                IsTitleList = $false
            })
        }
        catch [Windows.Automation.ElementNotAvailableException] {
            continue
        }
    }

    $all = $Root.FindAll(
        [Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.Condition]::TrueCondition
    )
    foreach ($candidateElement in $all) {
        try {
            $runtimeId = ($candidateElement.GetRuntimeId() -join ".")
            if ($knownRuntimeIds.ContainsKey($runtimeId)) {
                continue
            }
            $pattern = $null
            if (-not $candidateElement.TryGetCurrentPattern(
                [Windows.Automation.ScrollPattern]::Pattern,
                [ref]$pattern
            )) {
                continue
            }
            $scroll = [Windows.Automation.ScrollPattern]$pattern
            $rectangle = $candidateElement.Current.BoundingRectangle
            $candidates.Add([pscustomobject]@{
                Element = $candidateElement
                Pattern = $scroll
                Rectangle = $rectangle
                IsAncestor = $false
                IsDocumentDescendant = $false
                IsDomScrollContent = ($candidateElement.Current.AutomationId -eq "dom-scroll-content")
                IsOffscreen = [bool]$candidateElement.Current.IsOffscreen
                VerticallyScrollable = [bool]$scroll.Current.VerticallyScrollable
                IsTitleList = (
                    $candidateElement.Current.AutomationId -eq "shareKnowledgeContentList" -or
                    (Test-ImaTitleListScrollerGeometry $rectangle $titleListRectangle)
                )
            })
        }
        catch [Windows.Automation.ElementNotAvailableException] {
            continue
        }
    }

    $selected = Select-ImaBodyScrollerCandidate ($candidates.ToArray()) $documentRectangle
    if (-not $selected) {
        throw (
            "未找到与当前 IMA 文章 Document 绑定的正文滚动区域" +
            "（快路：$script:LastKnownBodyScrollerReason；几何候选 $($candidates.Count) 项；" +
            "Document $([Math]::Round($documentRectangle.Width))x$([Math]::Round($documentRectangle.Height))）"
        )
    }
    if (-not $selected.IsAncestor) {
        Write-SyncLog (
            "正文滚动器使用文章窗口几何回退：{0:N0}x{1:N0}" -f
            $selected.Rectangle.Width,
            $selected.Rectangle.Height
        )
    }
    return $selected
}

function Get-ImaBodyScroller(
    [Windows.Automation.AutomationElement]$Root,
    [Windows.Automation.AutomationElement]$Document
) {
    $title = $script:CurrentArticleTitle
    if ([string]::IsNullOrWhiteSpace($title)) {
        $title = [string]$Root.Current.Name
    }
    $processId = [int]$Root.Current.ProcessId
    $windowHandle = [long]$Root.Current.NativeWindowHandle
    $documentRuntimeId = ($Document.GetRuntimeId() -join ".")
    $cacheKey = Get-ImaBodyScrollerCacheKey `
        $title `
        $processId `
        $windowHandle `
        $documentRuntimeId
    $bodyRoot = $Root
    $bodyDocument = $Document
    $entry = Get-ImaCachedBodyScrollerEntry $cacheKey {
        Resolve-ImaBodyScroller $bodyRoot $bodyDocument
    }
    return $entry.Pattern
}

function Merge-ImaTextWindowsAcrossScrollRange(
    [string]$Title,
    [string]$Left,
    [string]$Right,
    [double]$StartPercent,
    [double]$EndPercent
) {
    if (
        $StartPercent -lt 0 -or
        $EndPercent -lt 0 -or
        $EndPercent -le $StartPercent
    ) {
        throw "IMA 正文滚动位置无效：$StartPercent → $EndPercent"
    }

    $document = Wait-ImaDocument $Title
    $scroller = Get-ImaBodyScroller (Get-ImaRoot) $document
    $viewSize = [double]$scroller.Current.VerticalViewSize
    if ($viewSize -le 0 -or $viewSize -gt 100) {
        throw "IMA 正文可见比例无效：$viewSize"
    }

    $distance = $EndPercent - $StartPercent
    $desiredStep = [Math]::Max(0.05, $viewSize * 0.35)
    $segmentCount = [Math]::Max(2, [int][Math]::Ceiling($distance / $desiredStep))
    if ($segmentCount -gt 200) {
        throw "IMA 正文补读窗口异常过多：$segmentCount"
    }

    $merged = $Left
    for ($segment = 1; $segment -lt $segmentCount; $segment++) {
        Test-ImaCancellation
        $percent = $StartPercent + (($distance * $segment) / $segmentCount)
        $before = Get-ImaViewportSnapshot $Title
        $before.Scroller.SetScrollPercent([Windows.Automation.ScrollPattern]::NoScroll, $percent)
        $previousSignature = if ([Math]::Abs(([double]$before.ScrollPercent) - $percent) -ge 0.1) {
            [string]$before.Signature
        }
        else {
            ""
        }
        $viewport = Wait-ImaViewportStable `
            $Title `
            $percent `
            "" `
            $previousSignature `
            ([double]$before.ScrollPercent)
        $chunk = Get-ImaBodyChunk (Get-ImaDocumentText $viewport.Document)
        try {
            $merged = Merge-ImaTextWindows $merged $chunk
        }
        catch {
            throw "补读到 $([Math]::Round($percent, 2))% 时仍无法衔接：$($_.Exception.Message)"
        }
    }

    $merged = Merge-ImaTextWindows $merged $Right
    Write-SyncLog "$Title 已补读 $($segmentCount - 1) 个中间正文窗口"
    return $merged
}

function Normalize-ImaBodyScrollPercent([double]$Percent) {
    if (
        [double]::IsNaN($Percent) -or
        [double]::IsInfinity($Percent) -or
        $Percent -lt 0 -or
        $Percent -gt 105
    ) {
        throw "IMA 正文尾部起始滚动位置无效：$Percent"
    }
    return [Math]::Min(100.0, $Percent)
}

function Wait-ImaTailViewportAtPercent(
    [string]$Title,
    [double]$TargetPercent,
    [int]$InitialTimeoutMilliseconds = 10000,
    [int]$RetryTimeoutMilliseconds = 30000,
    [int]$MinimumObservationMilliseconds = 600,
    [int]$StableSamples = 2
) {
    $lastContext = ""
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        Test-ImaCancellation
        $before = Get-ImaViewportSnapshot $Title
        $beforePercent = [double]$before.ScrollPercent
        # Chromium 会把接近底部的多个百分比折算到同一个实际视口。如果当前
        # 位置已经位于目标之后，SetScrollPercent 合理地不会改变签名，此时允许
        # Wait-ImaViewportStable 仅验证视口稳定，避免把正常的 no-op 当成超时。
        $allowUnchanged = (
            $beforePercent -ge ($TargetPercent - 0.05) -or
            ($TargetPercent -ge 99.9 -and $beforePercent -ge 99.0)
        )

        try {
            $before.Scroller.SetScrollPercent(
                [Windows.Automation.ScrollPattern]::NoScroll,
                $TargetPercent
            )
        }
        catch {
            $lastContext = (
                "目标 {0}%，第 {1} 次设置失败，命令前 {2}%" -f
                [Math]::Round($TargetPercent, 2),
                $attempt,
                [Math]::Round($beforePercent, 2)
            )
            if ($attempt -ge 2) {
                throw "IMA 正文尾部滚动失败（$lastContext）：$($_.Exception.Message)"
            }
            Write-SyncLog "$Title 正文尾部滚动首次设置失败（$lastContext），刷新滚动器后重试"
            Clear-ImaBodyScrollerCache $Title
            continue
        }

        $timeout = if ($attempt -eq 1) {
            $InitialTimeoutMilliseconds
        }
        else {
            $RetryTimeoutMilliseconds
        }
        try {
            $viewport = Wait-ImaViewportStable `
                $Title `
                $TargetPercent `
                "" `
                ([string]$before.Signature) `
                $beforePercent `
                $timeout `
                $MinimumObservationMilliseconds `
                $StableSamples `
                250 `
                $allowUnchanged
            if ($attempt -gt 1) {
                Write-SyncLog (
                    "$Title 正文尾部滚动重试成功：目标 {0}%，实际 {1}%" -f
                    [Math]::Round($TargetPercent, 2),
                    [Math]::Round(([double]$viewport.ScrollPercent), 2)
                )
            }
            return $viewport
        }
        catch {
            $message = $_.Exception.Message
            if (-not $message.StartsWith("等待 IMA 正文视图稳定超时：", [StringComparison]::Ordinal)) {
                throw
            }

            $observedPercent = "不可用"
            try {
                $observed = Get-ImaViewportSnapshot $Title
                $observedPercent = "{0}%" -f [Math]::Round(([double]$observed.ScrollPercent), 2)
            }
            catch {
                # 诊断读取失败不覆盖最初的稳定等待错误。
            }
            $lastContext = (
                "目标 {0}%，第 {1} 次等待 {2}ms，命令前 {3}%，最后观察 {4}，允许无变化 {5}" -f
                [Math]::Round($TargetPercent, 2),
                $attempt,
                $timeout,
                [Math]::Round($beforePercent, 2),
                $observedPercent,
                $allowUnchanged
            )
            if ($attempt -ge 2) {
                throw "IMA 正文尾部滚动稳定失败（$lastContext）：$message"
            }
            Write-SyncLog "$Title 正文尾部滚动首次等待超时（$lastContext），刷新滚动器并延长等待后重试"
            Clear-ImaBodyScrollerCache $Title
        }
    }
    throw "IMA 正文尾部滚动稳定失败（$lastContext）"
}

function Test-ImaForegroundAllowed([bool]$Allowed, [double]$SpentMilliseconds, [long]$IdleMilliseconds) {
    return $Allowed -and $SpentMilliseconds -lt 8000 -and $IdleMilliseconds -ge 2000
}

function Invoke-ImaTargetWheel([IntPtr]$WindowHandle, [int]$X, [int]$Y, [int]$Delta) {
    Initialize-ImaNativeMethods
    Test-ImaCancellation
    # Posting to the verified IMA child window does not require moving the shared pointer.
    if ([ImaSpeedSync.NativeMethods]::PostMouseWheelToWindow($X, $Y, $Delta, $WindowHandle)) { return }
    $idle = [ImaSpeedSync.NativeMethods]::GetInputIdleMilliseconds()
    if (-not (Test-ImaForegroundAllowed $script:AllowForeground $script:ForegroundMilliseconds $idle)) {
        throw "需要 IMA 窗口可见才能继续；低干扰保护已停止前台操作。请手动显示 IMA 后重试，或允许短时前台操作并暂停输入。"
    }
    $oldForeground = [ImaSpeedSync.NativeMethods]::GetForegroundWindow()
    $started = [DateTime]::UtcNow
    try {
        [void][ImaSpeedSync.NativeMethods]::ShowWindow($WindowHandle, 5)
        [void][ImaSpeedSync.NativeMethods]::SetForegroundWindow($WindowHandle)
        Start-ImaCancelableSleep 150
        if ([ImaSpeedSync.NativeMethods]::GetInputIdleMilliseconds() -lt 2000) {
            throw "检测到用户正在操作电脑，已停止前台操作"
        }
        if (-not [ImaSpeedSync.NativeMethods]::PostMouseWheelToWindow($X, $Y, $Delta, $WindowHandle)) {
            throw "IMA 被遮挡或窗口位置已变化，已停止输入，不重试点击"
        }
    }
    finally {
        $script:ForegroundMilliseconds += ([DateTime]::UtcNow - $started).TotalMilliseconds
        if ($oldForeground -ne [IntPtr]::Zero -and $oldForeground -ne $WindowHandle -and
            [ImaSpeedSync.NativeMethods]::GetForegroundWindow() -eq $WindowHandle -and
            [ImaSpeedSync.NativeMethods]::GetInputIdleMilliseconds() -ge 2000) {
            [void][ImaSpeedSync.NativeMethods]::SetForegroundWindow($oldForeground)
        }
    }
}

function Invoke-ImaBodyMouseWheel([string]$Title, [int]$Delta) {
    $article = Get-ImaArticleWindow $Title
    if (-not $article) { throw "IMA 正文尾部滚轮操作未找到原文章窗口：$Title" }
    $windowHandle = [IntPtr]$article.Root.Current.NativeWindowHandle
    if ($windowHandle -eq [IntPtr]::Zero) { throw "IMA 正文尾部滚轮操作缺少文章窗口句柄" }
    $rectangle = $article.Document.Current.BoundingRectangle
    if ($rectangle.Width -lt 200 -or $rectangle.Height -lt 200) { throw "IMA 正文没有足够的可见区域" }
    Invoke-ImaTargetWheel $windowHandle ([int]($rectangle.X + $rectangle.Width * 0.6)) ([int]($rectangle.Y + $rectangle.Height * 0.6)) $Delta
    Start-ImaCancelableSleep 450
}

function Move-ImaTailViewportDown([string]$Title) {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        Test-ImaCancellation
        $before = Get-ImaViewportSnapshot $Title
        try {
            # Chromium 的 Scroll 和 SetScrollPercent 共用异常的 UIA 范围，
            # 不能用其中一个修复另一个。正文底部改走真正的鼠标滚轮事件。
            Invoke-ImaBodyMouseWheel $Title -600
            return Wait-ImaViewportStable $Title -1 "" $before.Signature `
                ([double]$before.ScrollPercent) 30000 2000 4 250 $true
        }
        catch [OperationCanceledException] { throw }
        catch {
            if ($attempt -ge 2) { throw "IMA 正文尾部向下滚动失败：$($_.Exception.Message)" }
            Write-SyncLog "$Title 正文尾部局部重试，保留已读取内容：$($_.Exception.Message)"
            Clear-ImaBodyScrollerCache $Title
        }
    }
}

function Merge-ImaTextWindowsToBottom(
    [string]$Title,
    [string]$StartingChunk,
    [double]$StartingPercent,
    [object]$StartingTocItem = $null
) {
    [void](Normalize-ImaBodyScrollPercent $StartingPercent)
    $viewport = Get-ImaViewportSnapshot $Title
    # 顶部/中间补读可能挪走了当前视口。回到最后章节的语义锚点，而不是把
    # 历史记录中的 103% 强行变成 100%（二者并不对应同一个位置）。
    if ([Math]::Abs([double]$viewport.ScrollPercent - $StartingPercent) -gt 0.05) {
        if ($StartingTocItem) {
            Invoke-ImaTocItem $StartingTocItem
            $viewport = Wait-ImaViewportStable $Title -1 $StartingTocItem.Title `
                $viewport.Signature ([double]$viewport.ScrollPercent) 10000 600 2 250 $true
        }
        elseif ($StartingPercent -le 100) {
            $viewport = Wait-ImaTailViewportAtPercent $Title $StartingPercent
        }
        else {
            throw "IMA 正文尾部位置已改变且缺少最后章节锚点，不能按异常百分比定位"
        }
    }
    $merged = Merge-ImaTextWindows $StartingChunk (Get-ImaBodyChunk (Get-ImaDocumentText $viewport.Document))
    $unchangedBottomSamples = 0
    Write-SyncLog "$Title 正文尾部向下补读：起始位置 $($viewport.ScrollPercent)%"
    for ($windowCount = 1; $windowCount -le 250; $windowCount++) {
        $before = $viewport
        $viewport = Move-ImaTailViewportDown $Title
        [void](Normalize-ImaBodyScrollPercent ([double]$viewport.ScrollPercent))
        $chunk = Get-ImaBodyChunk (Get-ImaDocumentText $viewport.Document)
        try { $merged = Merge-ImaTextWindows $merged $chunk }
        catch {
            $reverseOverlap = try { [void](Merge-ImaTextWindows $chunk $merged); $true } catch { $false }
            Write-SyncLog (
                "$Title 尾部窗口无法衔接：位置 {0}% → {1}%，字符 {2} → {3}，反向重叠 {4}" -f
                $before.ScrollPercent, $viewport.ScrollPercent, $merged.Length, $chunk.Length, $reverseOverlap
            )
            throw
        }
        $unchanged = (
            $viewport.Signature -ceq $before.Signature -and
            [Math]::Abs([double]$viewport.ScrollPercent - [double]$before.ScrollPercent) -lt 0.05
        )
        if ($unchanged) {
            if ([double]$viewport.ScrollPercent -lt 99 -and [double]$viewport.ViewSize -lt 99) {
                throw "IMA 正文尾部未到达底部且向下滚动没有前进：$($viewport.ScrollPercent)%"
            }
            $unchangedBottomSamples++
        }
        else { $unchangedBottomSamples = 0 }
        # 连续两次向下操作、每次至少两秒稳定观察，确认底部不再移动/加载。
        if ($unchangedBottomSamples -ge 2) {
            Write-SyncLog "$Title 已确认正文底部：$($viewport.ScrollPercent)%，检查 $windowCount 个尾部窗口"
            return $merged
        }
    }
    throw "补读 IMA 正文尾部的窗口数量异常：250"
}

function Get-ImaHorizontalRuleAnchors([Windows.Automation.AutomationElement]$Document) {
    $all = $Document.FindAll(
        [Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.Condition]::TrueCondition
    )
    $anchors = New-Object Collections.Generic.List[object]
    for ($index = 0; $index -lt $all.Count; $index++) {
        if ($all[$index].Current.ControlType -ne [Windows.Automation.ControlType]::Separator) {
            continue
        }

        $before = $null
        for ($beforeIndex = $index - 1; $beforeIndex -ge 0; $beforeIndex--) {
            $candidate = [string]$all[$beforeIndex].Current.Name
            $candidate = $candidate.Replace([string][char]0xFEFF, "").Replace([string][char]0xFFFC, "").Trim()
            if (-not [string]::IsNullOrWhiteSpace($candidate)) {
                $before = $candidate
                break
            }
        }

        $after = $null
        for ($afterIndex = $index + 1; $afterIndex -lt $all.Count; $afterIndex++) {
            $candidate = [string]$all[$afterIndex].Current.Name
            $candidate = $candidate.Replace([string][char]0xFEFF, "").Replace([string][char]0xFFFC, "").Trim()
            if (-not [string]::IsNullOrWhiteSpace($candidate)) {
                $after = $candidate
                break
            }
        }

        if ($before -and $after) {
            $anchors.Add([pscustomobject]@{ Before = $before; After = $after })
        }
    }
    return $anchors.ToArray()
}

function Get-ImaDocumentText([Windows.Automation.AutomationElement]$Document) {
    $text = Get-ImaRawDocumentText $Document
    $anchors = @(Get-ImaHorizontalRuleAnchors $Document)
    return Add-ImaHorizontalRulesToText $text $anchors
}

function Get-ImaRawDocumentText([Windows.Automation.AutomationElement]$Document) {
    $pattern = $null
    if (-not $Document.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
        throw "IMA 文章未提供 TextPattern 文本接口"
    }
    return ([Windows.Automation.TextPattern]$pattern).DocumentRange.GetText(-1)
}

function Get-ImaViewportFingerprint([string]$Text) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return [Convert]::ToBase64String($hasher.ComputeHash($bytes))
    }
    finally {
        $hasher.Dispose()
    }
}

function Get-ImaViewportSnapshot([string]$Title) {
    $articleWindow = Get-ImaArticleWindow $Title
    if (-not $articleWindow) {
        throw "等待 IMA 文章视图时未找到 Document：$Title"
    }
    try {
        $document = $articleWindow.Document
        $text = Get-ImaRawDocumentText $document
        $scroller = Get-ImaBodyScroller $articleWindow.Root $document
        return [pscustomobject]@{
            Document = $document
            Text = $text
            Signature = Get-ImaViewportFingerprint $text
            ScrollPercent = [double]$scroller.Current.VerticalScrollPercent
            ViewSize = [double]$scroller.Current.VerticalViewSize
            Scroller = $scroller
        }
    }
    catch [Windows.Automation.ElementNotAvailableException] {
        Clear-ImaArticleWindowCache $Title
        Clear-ImaBodyScrollerCache $Title
        throw
    }
    catch [System.InvalidOperationException] {
        Clear-ImaArticleWindowCache $Title
        Clear-ImaBodyScrollerCache $Title
        throw
    }
    catch [System.Runtime.InteropServices.COMException] {
        Clear-ImaArticleWindowCache $Title
        Clear-ImaBodyScrollerCache $Title
        throw
    }
    catch [System.Management.Automation.MethodInvocationException] {
        $inner = $_.Exception.InnerException
        if (
            $inner -is [Windows.Automation.ElementNotAvailableException] -or
            $inner -is [System.InvalidOperationException] -or
            $inner -is [System.Runtime.InteropServices.COMException]
        ) {
            Clear-ImaArticleWindowCache $Title
            Clear-ImaBodyScrollerCache $Title
        }
        throw
    }
}

function Wait-ImaViewportStable(
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
) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $started = [DateTime]::UtcNow
    $lastSignature = ""
    $lastPercent = [double]::NaN
    $stableCount = 0
    do {
        Test-ImaCancellation
        try {
            $snapshot = Get-ImaViewportSnapshot $Title
            $percent = [double]$snapshot.ScrollPercent
            $positionTolerance = [Math]::Max(1.0, ([double]$snapshot.ViewSize * 0.25))
            $positionMatches = (
                $ExpectedPercent -lt 0 -or
                ($ExpectedPercent -le 0.1 -and $percent -le 1.0) -or
                ($ExpectedPercent -ge 99.9 -and $percent -ge 99.0) -or
                [Math]::Abs($percent - $ExpectedPercent) -le $positionTolerance
            )
            $textMatches = (
                [string]::IsNullOrWhiteSpace($ExpectedText) -or
                $snapshot.Text.IndexOf($ExpectedText, [StringComparison]::Ordinal) -ge 0
            )
            $hasBaseline = (
                -not [string]::IsNullOrWhiteSpace($PreviousSignature) -or
                $PreviousPercent -ge 0
            )
            $viewportChanged = (
                -not $hasBaseline -or
                $AllowUnchanged -or
                $snapshot.Signature -cne $PreviousSignature -or
                ($PreviousPercent -ge 0 -and [Math]::Abs($percent - $PreviousPercent) -ge 0.1) -or
                $snapshot.ViewSize -ge 99.0
            )

            if ($positionMatches -and $textMatches -and $viewportChanged) {
                $snapshotReturnedAt = [DateTime]::UtcNow
                if (
                    $snapshotReturnedAt -ge $deadline -and
                    ($snapshotReturnedAt - $started).TotalMilliseconds -ge $MinimumObservationMilliseconds
                ) {
                    # UIA 的一次有效读取可能比整个等待预算还慢。此时样本已经满足
                    # 位置、文本和跳转变化条件，不能仅因调用返回时越过 deadline 丢弃它。
                    return $snapshot
                }
                if (
                    $snapshot.Signature -ceq $lastSignature -and
                    -not [double]::IsNaN($lastPercent) -and
                    [Math]::Abs($percent - $lastPercent) -lt 0.05
                ) {
                    $stableCount++
                }
                else {
                    $lastSignature = $snapshot.Signature
                    $lastPercent = $percent
                    $stableCount = 0
                }
                if (
                    $stableCount -ge $StableSamples -and
                    ([DateTime]::UtcNow - $started).TotalMilliseconds -ge $MinimumObservationMilliseconds
                ) {
                    return $snapshot
                }
            }
            else {
                $lastSignature = ""
                $lastPercent = [double]::NaN
                $stableCount = 0
            }
        }
        catch [Windows.Automation.ElementNotAvailableException] {
            $lastSignature = ""
            $lastPercent = [double]::NaN
            $stableCount = 0
        }
        catch [System.InvalidOperationException] {
            $lastSignature = ""
            $lastPercent = [double]::NaN
            $stableCount = 0
        }
        catch [System.Runtime.InteropServices.COMException] {
            $lastSignature = ""
            $lastPercent = [double]::NaN
            $stableCount = 0
        }
        catch [System.Management.Automation.MethodInvocationException] {
            $inner = $_.Exception.InnerException
            if (
                $inner -isnot [Windows.Automation.ElementNotAvailableException] -and
                $inner -isnot [System.InvalidOperationException] -and
                $inner -isnot [System.Runtime.InteropServices.COMException]
            ) {
                throw
            }
            $lastSignature = ""
            $lastPercent = [double]::NaN
            $stableCount = 0
        }
        Start-ImaCancelableSleep $PollMilliseconds
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "等待 IMA 正文视图稳定超时：$Title"
}

function Get-ImaTocCandidateNames([string]$TocText) {
    return @($TocText.Replace("`r`n", "`n").Replace("`r", "`n").Split("`n") |
        ForEach-Object { $_.Trim() } |
        Where-Object {
            -not [string]::IsNullOrWhiteSpace($_) -and
            $_ -notmatch "https?://" -and
            $_ -notmatch ('^\s*' + [regex]::Escape($script:UpdateMarker)) -and
            $_ -cne "目录" -and
            $_ -cne "Contents"
        })
}

function Test-ImaTocCandidateName([string]$Name, [string]$TocText) {
    return (
        -not [string]::IsNullOrWhiteSpace($Name) -and
        $Name.Length -ge 20 -and
        $TocText.Contains($Name) -and
        $Name -notmatch "https?://"
    )
}

function Get-ImaTocItems(
    [Windows.Automation.AutomationElement]$Root,
    [Windows.Automation.AutomationElement]$Document
) {
    $documentText = Get-ImaDocumentText $Document
    $header = Get-ImaUpdateHeader $documentText
    $tocText = $header.Text.Substring(0, $header.MarkerIndex)
    # 恢复 08:55 已真实验证可完整提取 20/20 章节的选择规则。IMA 的目录和
    # 正文会共享同一个 Document UIA 分支，不能按祖先结构排除候选。
    $all = $Root.FindAll(
        [Windows.Automation.TreeScope]::Descendants,
        [Windows.Automation.Condition]::TrueCondition
    )
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    $items = New-Object Collections.Generic.List[object]
    $seen = @{}

    for ($elementIndex = 0; $elementIndex -lt $all.Count; $elementIndex++) {
        Test-ImaCancellation
        $element = $all[$elementIndex]
        $name = [string]$element.Current.Name
        if (
            $element.Current.ControlType -ne [Windows.Automation.ControlType]::Text -or
            -not (Test-ImaTocCandidateName $name $tocText) -or
            $name -ceq $script:CurrentArticleTitle -or
            $seen.ContainsKey($name)
        ) {
            continue
        }

        $ancestor = $element
        $invokeElement = $null
        for ($level = 0; $level -lt 8 -and $ancestor; $level++) {
            $pattern = $null
            if ($ancestor.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                $invokeElement = $ancestor
                break
            }
            $ancestor = $walker.GetParent($ancestor)
        }
        if (-not $invokeElement) {
            continue
        }

        # 与已验证旧版一致：Root 遍历中每个同名标题只取首个可调用节点。
        # 这会优先保证稳定完整提取；相同标题的后续 TOC occurrence 暂不区分。
        $seen[$name] = $true
        $items.Add([pscustomobject]@{
            Title = [string]$name
            Element = $element
            InvokeElement = $invokeElement
            Identity = "toc-$elementIndex"
            Occurrence = 1
            OriginalIndex = $items.Count
        })
    }

    if ($items.Count -lt 1) {
        throw "IMA 目录条目异常过少：$($items.Count) 项"
    }
    return $items.ToArray()
}

function Invoke-ImaTocItem([object]$Item) {
    $element = $Item.Element
    $scrollItemObject = $null
    if (
        $element.Current.IsOffscreen -and
        $element.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scrollItemObject)
    ) {
        ([Windows.Automation.ScrollItemPattern]$scrollItemObject).ScrollIntoView()
        Start-ImaCancelableSleep 350
    }
    $pattern = $null
    if (-not $Item.InvokeElement.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        throw "IMA 目录项无法调用：$($Item.Title)"
    }
    ([Windows.Automation.InvokePattern]$pattern).Invoke()
}

function Read-ImaCompleteArticle([string]$Title) {
    $document = Wait-ImaDocument $Title
    $beforeTop = Get-ImaViewportSnapshot $Title
    $beforeTop.Scroller.SetScrollPercent([Windows.Automation.ScrollPattern]::NoScroll, 0)
    $previousTopSignature = if ([double]$beforeTop.ScrollPercent -gt 0.1) {
        [string]$beforeTop.Signature
    }
    else {
        ""
    }
    $topViewport = Wait-ImaViewportStable `
        $Title `
        0 `
        "" `
        $previousTopSignature `
        ([double]$beforeTop.ScrollPercent)
    $document = $topViewport.Document
    $topChunk = Get-ImaBodyChunk (Get-ImaDocumentText $document)
    $tocItems = @(Get-ImaTocItems (Get-ImaRoot) $document)
    Write-SyncLog "$Title 目录：在当前文章容器内发现 $($tocItems.Count) 个候选项"
    $bodyItems = New-Object Collections.Generic.List[object]
    $cachedViewport = $topViewport
    $cachedChunk = $topChunk
    $reusedWindows = 0
    $invokedWindows = 0

    for ($index = 0; $index -lt $tocItems.Count; $index++) {
        $candidateItem = $tocItems[$index]
        $candidateTitle = [string]$candidateItem.Title
        Test-ImaCancellation
        if ($candidateTitle -ceq $Title) {
            Write-SyncLog "$Title 已跳过文章标题目录项 $($index + 1)/$($tocItems.Count)"
            continue
        }
        $nextCandidateTitle = if ($index + 1 -lt $tocItems.Count) { [string]$tocItems[$index + 1].Title } else { "" }
        if (
            [int]$candidateItem.Occurrence -eq 1 -and
            (Test-ImaHasCompleteSectionWindow $cachedChunk $candidateTitle $nextCandidateTitle)
        ) {
            $viewport = $cachedViewport
            $chunk = $cachedChunk
            $reusedWindows++
        }
        else {
            $beforeInvoke = Get-ImaViewportSnapshot $Title
            $beforeBodyChunk = try { Get-ImaBodyChunk $beforeInvoke.Text } catch { "" }
            $allowUnchanged = Test-ImaCanReuseTopViewport `
                $beforeBodyChunk $candidateTitle ([int]$candidateItem.Occurrence) ([double]$beforeInvoke.ScrollPercent)
            Invoke-ImaTocItem $candidateItem
            $viewport = Wait-ImaViewportStable `
                $Title -1 $candidateTitle ([string]$beforeInvoke.Signature) `
                ([double]$beforeInvoke.ScrollPercent) 10000 600 2 250 $allowUnchanged
            $chunk = Get-ImaBodyChunk (Get-ImaDocumentText $viewport.Document)
            $cachedViewport = $viewport
            $cachedChunk = $chunk
            $invokedWindows++
        }
        $scrollPercent = [double]$viewport.ScrollPercent

        if ($chunk.IndexOf($candidateTitle, [StringComparison]::Ordinal) -lt 0) {
            Write-SyncLog "$Title 已忽略非正文目录项 $($index + 1)/$($tocItems.Count)：$candidateTitle"
            continue
        }

        $bodyItems.Add([pscustomobject]@{
            Title = $candidateTitle
            Identity = $candidateItem.Identity
            Occurrence = [int]$candidateItem.Occurrence
            Chunk = $chunk
            ScrollPercent = $scrollPercent
            OriginalIndex = $index
        })
    }

    if ($bodyItems.Count -lt 1) {
        throw "$Title 的正文中没有出现任何目录条目"
    }
    Write-SyncLog "$Title 正文窗口：实际目录跳转 $invokedWindows 次，复用完整章节 $reusedWindows 项"

    $originalOrder = @($bodyItems.ToArray())
    $bodyItems = @($originalOrder | Sort-Object -Property ScrollPercent, OriginalIndex)
    $reorderedCount = 0
    for ($index = 0; $index -lt $bodyItems.Count; $index++) {
        if ($bodyItems[$index].OriginalIndex -ne $originalOrder[$index].OriginalIndex) {
            $reorderedCount++
        }
    }
    if ($reorderedCount -gt 0) {
        Write-SyncLog "$Title 已按正文位置校正 $reorderedCount 个错序目录项"
    }

    try {
        $firstItem = $bodyItems[0]
        if (-not $topChunk.Contains($firstItem.Chunk)) {
            try {
                $firstItem.Chunk = Merge-ImaTextWindows $topChunk $firstItem.Chunk
            }
            catch {
                if ([double]$firstItem.ScrollPercent -le ([double]$topViewport.ScrollPercent + 0.01)) {
                    throw
                }
                $firstItem.Chunk = Merge-ImaTextWindowsAcrossScrollRange `
                    $Title `
                    $topChunk `
                    $firstItem.Chunk `
                    ([double]$topViewport.ScrollPercent) `
                    ([double]$firstItem.ScrollPercent)
            }
        }
        else {
            $firstItem.Chunk = $topChunk
        }
        Write-SyncLog "$Title 已将顶部正文窗口合并到第一章节"
    }
    catch {
        throw "$Title 的顶部前言无法与第一章节衔接：$($_.Exception.Message)"
    }

    $lastItem = $bodyItems[$bodyItems.Count - 1]
    try {
        $lastItem.Chunk = Merge-ImaTextWindowsToBottom `
            $Title `
            $lastItem.Chunk `
            ([double]$lastItem.ScrollPercent) `
            $tocItems[$lastItem.OriginalIndex]
    }
    catch {
        throw "$Title 的最后章节未能完整读取到正文底部：$($_.Exception.Message)"
    }

    $sections = New-Object Collections.Generic.List[string]
    $capturedLength = 0
    for ($index = 0; $index -lt $bodyItems.Count; $index++) {
        Test-ImaCancellation
        $item = $bodyItems[$index]
        $nextTitle = if ($index -lt ($bodyItems.Count - 1)) { $bodyItems[$index + 1].Title } else { $null }
        try {
            $sectionChunk = $item.Chunk
            if (
                -not [string]::IsNullOrWhiteSpace($nextTitle) -and
                $sectionChunk.IndexOf($nextTitle, [StringComparison]::Ordinal) -lt 0
            ) {
                try {
                    $sectionChunk = Merge-ImaTextWindows $sectionChunk $bodyItems[$index + 1].Chunk
                    Write-SyncLog "$Title 第 $($index + 1) 项已合并相邻虚拟化文本窗口"
                }
                catch {
                    Write-SyncLog "$Title 第 $($index + 1) 项存在正文跨度，正在补读中间文本窗口"
                    $sectionChunk = Merge-ImaTextWindowsAcrossScrollRange `
                        $Title `
                        $sectionChunk `
                        $bodyItems[$index + 1].Chunk `
                        ([double]$item.ScrollPercent) `
                        ([double]$bodyItems[$index + 1].ScrollPercent)
                }
            }
            $section = Get-ImaSectionText `
                $sectionChunk `
                $item.Title `
                $nextTitle `
                ($index -eq 0) `
                ([int]$item.Occurrence)
            $section = Format-ImaSectionMarkdown $section $item.Title
            $sections.Add($section)
            $capturedLength += $section.Length
        }
        catch {
            throw "$Title 的正文在第 $($index + 1)/$($bodyItems.Count) 项附近不完整：$($_.Exception.Message)"
        }
        if ((($index + 1) % 10) -eq 0 -or $index -eq ($bodyItems.Count - 1)) {
            Write-SyncLog "$Title 进度：$($index + 1)/$($bodyItems.Count)，已读取 $capturedLength 个字符"
        }
    }

    $merged = ($sections -join "`n").Trim()
    if (-not $merged.Contains($bodyItems[0].Title)) {
        throw "$Title 未包含第一个正文条目：$($bodyItems[0].Title)"
    }
    if (-not $merged.Contains($bodyItems[-1].Title)) {
        throw "$Title 未包含最后一个正文条目：$($bodyItems[-1].Title)"
    }
    if ($merged.Length -lt 1000) {
        throw "$Title 的正文长度异常：仅 $($merged.Length) 个字符"
    }
    return $merged
}

function Test-ImaGeneralTitle([string]$Title) {
    if ([string]::IsNullOrWhiteSpace($Title)) { return $false }
    switch ($script:TitleFilterMode) {
        "all" { return $true }
        "contains" { return $Title.IndexOf($script:TitleFilter, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
        "prefix" { return $Title.StartsWith($script:TitleFilter, [StringComparison]::OrdinalIgnoreCase) }
        "regex" {
            try { return $script:TitleRegex.IsMatch($Title) }
            catch { throw "标题正则匹配超时或失败，请简化筛选表达式" }
        }
    }
    throw "标题筛选方式无效"
}

function Get-ImaCardIdentity([string]$AutomationId) {
    $match = [regex]::Match($AutomationId, '^knowledge-(note|weburl|pdf|file|image)_(.+)$')
    if (-not $match.Success) { return $null }
    $id = $match.Groups[2].Value
    # Do not persist short numeric UI row indexes as article identities.
    $sourceId = if ($id -match '^[A-Za-z0-9_-]{16,}$' -and $id -notmatch '^\d+$') { $AutomationId } else { "" }
    return [pscustomobject]@{ Kind = $match.Groups[1].Value; SourceId = $sourceId; AutomationId = $AutomationId }
}

function Get-ImaCardTitleIndex([string[]]$Names, [string]$Kind) {
    $labels = @{ note='笔记'; weburl='网页'; pdf='PDF'; file='文件'; image='图片' }
    # IMA can expose a thumbnail's entire preview before the actual title.
    # The verified card layout ends in title, kind, update time, not title first.
    if ($Names.Count -ge 3 -and $Names[-2] -ceq $labels[$Kind] -and $Names[-1] -match '更新$') {
        return $Names.Count - 3
    }
    throw "IMA 文章卡片结构变化，无法可靠区分标题与摘要"
}

function Get-ImaGeneralTitleSnapshot([Windows.Automation.AutomationElement]$ListElement) {
    $condition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Text)
    $allRecords = New-Object Collections.Generic.List[object]
    $listRectangle = $ListElement.Current.BoundingRectangle
    foreach ($card in $ListElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)) {
        Test-ImaCancellation
        try {
            $identity = Get-ImaCardIdentity ([string]$card.Current.AutomationId)
            if (-not $identity) { continue }
            $cardRectangle = $card.Current.BoundingRectangle
            if ($cardRectangle.Bottom -le $listRectangle.Y -or $cardRectangle.Y -ge $listRectangle.Bottom) { continue }
            $texts = @($card.FindAll([Windows.Automation.TreeScope]::Descendants, $condition))
            $names = @($texts | ForEach-Object { [string]$_.Current.Name })
            $titleIndex = Get-ImaCardTitleIndex $names $identity.Kind
            $textElement = $texts[$titleIndex]
            $key = $identity.AutomationId + ':' + ($card.GetRuntimeId() -join '.')
            $name = [string]$textElement.Current.Name
            $rectangle = $textElement.Current.BoundingRectangle
            if ($textElement.Current.IsOffscreen -or $rectangle.Width -le 0 -or $rectangle.Height -le 0 -or
                $rectangle.Y -ge $listRectangle.Bottom -or $rectangle.Bottom -le $listRectangle.Y) { continue }
            $allRecords.Add([pscustomobject]@{
                Name = $name; Element = $textElement; Card = $card
                SourceId = $identity.SourceId; AutomationId = $identity.AutomationId; Kind = $identity.Kind
                Key = if ($identity.SourceId) { $identity.SourceId } else { "$key`:$name" }
                X = [double]$rectangle.X; Y = [double]$rectangle.Y; ScrollPercent = 0.0; ScrollStep = 0
            })
        }
        catch [Windows.Automation.ElementNotAvailableException] { continue }
    }
    $allOrdered = @($allRecords.ToArray() | Sort-Object Y, X)
    $records = @($allOrdered | Where-Object { Test-ImaGeneralTitle $_.Name })
    return [pscustomobject]@{
        Records = $records
        Elements = @($records | ForEach-Object { $_.Element })
        Signature = (@($allOrdered | ForEach-Object { "$($_.Key)@$([Math]::Round($_.Y))" }) -join '|')
    }
}

function Get-ImaRecentArticleRecords([Windows.Automation.AutomationElement]$Root, [int]$Limit) {
    $records = New-Object Collections.Generic.List[object]
    $seen = @{}
    $scrollTarget = Get-ImaTitleListScroller $Root
    if ($scrollTarget) { Reset-ImaTitleListToTop $scrollTarget }
    $percent = 0.0
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    for ($page = 0; $page -lt 30; $page++) {
        Test-ImaCancellation
        $snapshot = Get-ImaVisibleTitleSnapshot (Get-ImaRoot)
        foreach ($record in @($snapshot.Records)) {
            if ($seen.ContainsKey($record.Key)) { continue }
            $seen[$record.Key] = $true
            $record.ScrollPercent = $percent
            $record.ScrollStep = $page
            $records.Add($record)
            if ($records.Count -ge $Limit) { break }
        }
        if ($records.Count -ge $Limit -or -not $scrollTarget) { break }
        if ($scrollTarget.RangePattern -and $percent -ge 99.9) { break }
        if ([DateTime]::UtcNow -ge $deadline) { throw "标题筛选检查超过 30 秒，请缩小检查范围或简化筛选" }
        if ($scrollTarget.RangePattern) {
            $percent = [Math]::Min(100, $percent + [Math]::Max(5, $scrollTarget.Pattern.Current.VerticalViewSize * 0.75))
            Set-ImaTitleListScrollPercent $scrollTarget $percent
            Start-ImaCancelableSleep 250
        }
        elseif (-not (Invoke-ImaTitleListMouseWheel $scrollTarget -900)) { break }
        $script:CurrentTitleScrollStep = $page + 1
    }
    return $records.ToArray()
}

function Invoke-ImaArticleRecord([object]$Record) {
    # A pre-existing same-title window cannot safely be attributed to this card.
    $presence = Get-ImaArticleWindowPresence $Record.Name
    if ($presence.State -ne "Absent" -or (Find-ImaArticleWindow $Record.Name)) {
        throw "同名文章窗口已打开或身份无法确认，请先关闭该文章窗口后重试：$($Record.Name)"
    }
    $root = Get-ImaRoot
    $snapshot = Get-ImaVisibleTitleSnapshot $root
    $matches = @($snapshot.Records | Where-Object { $_.Key -ceq $Record.Key })
    if ($matches.Count -eq 0) {
        $target = Get-ImaTitleListScroller $root
        if (-not $target) { throw "目标文章已不在列表可见范围" }
        if ($target.RangePattern) { Set-ImaTitleListScrollPercent $target $Record.ScrollPercent }
        else {
            $distance = $Record.ScrollStep - $script:CurrentTitleScrollStep
            $delta = if ($distance -gt 0) { -900 } else { 900 }
            for ($step = 0; $step -lt [Math]::Abs($distance); $step++) {
                [void](Invoke-ImaTitleListMouseWheel $target $delta)
            }
        }
        Start-ImaCancelableSleep 250
        $snapshot = Get-ImaVisibleTitleSnapshot (Get-ImaRoot)
        $matches = @($snapshot.Records | Where-Object { $_.Key -ceq $Record.Key })
    }
    if ($matches.Count -ne 1) { throw "文章条目已变化或来源 ID 不唯一，本轮不点击：$($Record.Name)" }
    # The card container's InvokePattern can be a silent no-op. Resolve the
    # nearest invokable title/ancestor, bounded by this exact identity's card.
    $pattern = $null
    $candidate = $matches[0].Element
    $cardRuntimeId = $matches[0].Card.GetRuntimeId() -join '.'
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    for ($level = 0; $level -lt 12 -and $candidate; $level++) {
        if ($candidate.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { break }
        if (($candidate.GetRuntimeId() -join '.') -ceq $cardRuntimeId) { break }
        $candidate = $walker.GetParent($candidate)
    }
    if (-not $pattern) { throw "文章条目未提供可安全调用的打开操作：$($Record.Name)" }
    $script:CurrentTitleScrollStep = $Record.ScrollStep
    try { ([Windows.Automation.InvokePattern]$pattern).Invoke() }
    catch { throw "无法确认文章是否已打开，本轮不重复点击：$($Record.Name)" }
    $script:CurrentArticleTitle = $Record.Name
    Clear-ImaArticleWindowCache $Record.Name
    Clear-ImaBodyScrollerCache $Record.Name
    [void]$script:GeneralBodyCache.Remove($Record.Name)
}

function Get-ImaOptionalUpdatedDate([string]$Text) {
    # Metadata is optional; an invalid or absent date must not reject a short note.
    $match = [regex]::Match($Text, '(?m)^更新时间[：:]\s*(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s*$')
    if (-not $match.Success) { return $null }
    try {
        return ([datetime]::new([int]$match.Groups[1].Value, [int]$match.Groups[2].Value, [int]$match.Groups[3].Value)).ToString('yyyy-MM-dd')
    }
    catch { return $null }
}

function Convert-ImaGeneralDecorations([string]$Text, [object[]]$Decorations) {
    $previousStart = $Text.Length + 1
    foreach ($decoration in @($Decorations | Sort-Object Start -Descending)) {
        $start = [int]$decoration.Start
        $length = [int]$decoration.Length
        if ($start -lt 0 -or $length -lt 0 -or $start + $length -gt $Text.Length -or
            $start + $length -gt $previousStart) { throw "正文结构范围重叠或越界，未保存不确定内容" }
        $Text = $Text.Remove($start, $length).Insert($start, [string]$decoration.Markdown)
        $previousStart = $start
    }
    return $Text
}

function Get-ImaGeneralMarkdown([object]$Binding, [object]$BodyRange, [string]$RawText) {
    # PowerShell 5.1 does not load the range-endpoint enum with UIAutomationClient alone.
    Add-Type -AssemblyName UIAutomationTypes
    $condition = New-Object Windows.Automation.OrCondition(
        (New-Object Windows.Automation.PropertyCondition(
            [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Hyperlink)),
        (New-Object Windows.Automation.PropertyCondition(
            [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Separator)))
    $decorations = New-Object Collections.Generic.List[object]
    foreach ($element in $Binding.Body.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
        Test-ImaCancellation
        $range = $Binding.TextPattern.RangeFromChild($element)
        $prefix = $BodyRange.Clone()
        $prefix.MoveEndpointByRange([Windows.Automation.Text.TextPatternRangeEndpoint]::End, $range, [Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
        $prefixText = $prefix.GetText(-1)
        $label = $range.GetText(-1)
        if (-not $RawText.StartsWith($prefixText, [StringComparison]::Ordinal) -or
            $prefixText.Length + $label.Length -gt $RawText.Length -or
            $RawText.Substring($prefixText.Length, $label.Length) -cne $label) {
            throw "正文正在变化，链接或分隔线位置暂时无法确认"
        }
        if ($element.Current.ControlType -eq [Windows.Automation.ControlType]::Separator) {
            $replacement = "`n`n---`n`n"
        }
        else {
            $url = [string]$element.Current.Name
            if ($url -notmatch '^(https?://|mailto:)[^\s<>]+$') {
                $value = $null
                if ($element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$value)) {
                    $url = [string]([Windows.Automation.ValuePattern]$value).Current.Value
                }
                if ($url -notmatch '^(https?://|mailto:)[^\s<>]+$') {
                    throw "文字链接未提供可读取的目标地址，已停止保存，避免只保留链接名称"
                }
            }
            if ($label.Trim() -ceq $url) { continue } # Already a complete literal URL.
            $safeLabel = $label.Trim().Replace('\', '\\').Replace('[', '\[').Replace(']', '\]')
            if (-not $safeLabel -or $safeLabel -eq [string][char]0xFFFC) { $safeLabel = $url }
            $replacement = "[$safeLabel](<$url>)"
        }
        $decorations.Add([pscustomobject]@{ Start=$prefixText.Length; Length=$label.Length; Markdown=$replacement })
    }
    return Convert-ImaGeneralDecorations $RawText ($decorations.ToArray())
}

function Resolve-ImaGeneralBinding([string]$Title) {
    $article = Get-ImaArticleWindow $Title
    if (-not $article) { throw "文字文章尚未提供 Document" }
    $document = $article.Document
    $documentKey = $document.GetRuntimeId() -join '.'
    if ($script:GeneralBodyCache.ContainsKey($Title)) {
        $cached = $script:GeneralBodyCache[$Title]
        try {
            if ($cached.DocumentKey -ceq $documentKey) {
                [void]$cached.Body.GetRuntimeId()
                [void]$cached.Scroll.Current.VerticallyScrollable
                return $cached
            }
        }
        catch { [void]$script:GeneralBodyCache.Remove($Title) }
    }
    $bodyCondition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::AutomationIdProperty, 'dom-scroll-content')
    $scrollElement = $document.FindFirst([Windows.Automation.TreeScope]::Descendants, $bodyCondition)
    if (-not $scrollElement) {
        # A Document that itself exposes ScrollPattern can be a plain-note body.
        $scrollElement = $document
    }
    $scrollObject = $null
    if (-not $scrollElement.TryGetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern, [ref]$scrollObject)) {
        throw "当前文字视图没有可验证的正文滚动边界，不能确认完整性"
    }
    $editorCondition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::AutomationIdProperty, 'qb-editor-content')
    $bodyElement = $scrollElement.FindFirst([Windows.Automation.TreeScope]::Descendants, $editorCondition)
    if (-not $bodyElement) {
        if ($scrollElement -ne $document) { throw "未找到可独立读取的文字正文区域，不能混入标题与工具栏" }
        $bodyElement = $document
    }
    $textObject = $null
    $ownText = $bodyElement.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$textObject)
    if (-not $ownText) {
        if (-not $document.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$textObject)) {
            throw "当前文字视图没有 TextPattern 正文接口"
        }
    }
    $binding = [pscustomobject]@{
        DocumentKey=$documentKey; Document=$document; Body=$bodyElement; OwnText=$ownText
        TextPattern=[Windows.Automation.TextPattern]$textObject; Scroll=[Windows.Automation.ScrollPattern]$scrollObject
        UpdatedDate=$null
    }
    $documentText = $null
    if ($document.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$documentText)) {
        $binding.UpdatedDate = Get-ImaOptionalUpdatedDate (([Windows.Automation.TextPattern]$documentText).DocumentRange.GetText(-1))
    }
    $script:GeneralBodyCache[$Title] = $binding
    return $binding
}

function Get-ImaGeneralSnapshot([string]$Title) {
    try {
        $binding = Resolve-ImaGeneralBinding $Title
        $range = if ($binding.OwnText) { $binding.TextPattern.DocumentRange } else { $binding.TextPattern.RangeFromChild($binding.Body) }
        $rawText = $range.GetText(-1)
        $text = $rawText
        $scroll = $binding.Scroll
        $contentRectangle = $binding.Body.Current.BoundingRectangle
        $viewportRectangle = $binding.Document.Current.BoundingRectangle
    }
    catch {
        [void]$script:GeneralBodyCache.Remove($Title)
        throw
    }
    $text = $text.Replace("`r`n", "`n").Replace("`r", "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($text) -or $text -match '^(加载中[.。…]*|正在加载[.。…]*|Loading[.。…]*)$') {
        throw "文字正文仍在加载或为空"
    }
    return [pscustomobject]@{
        Text = $text; Signature = Get-ImaViewportFingerprint $text
        Scrollable = [bool]$scroll.Current.VerticallyScrollable
        ScrollPercent = [double]$scroll.Current.VerticalScrollPercent
        ViewSize = [double]$scroll.Current.VerticalViewSize
        Scroller = $scroll; Document = $binding.Document
        Binding = $binding; BodyRange = $range; RawText = $rawText; UpdatedDate = $binding.UpdatedDate
        ContentEndVisible = Test-ImaContentEndVisible $contentRectangle $viewportRectangle
        ContentBottom = [double]$contentRectangle.Bottom; ContentHeight = [double]$contentRectangle.Height
        ViewportBottom = [double]$viewportRectangle.Bottom
    }
}

function Wait-ImaGeneralSnapshot([string]$Title, [int]$TimeoutMilliseconds = 12000) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $last = ""
    $stable = 0
    $lastError = "尚未读到正文"
    do {
        Test-ImaCancellation
        try {
            $snapshot = Get-ImaGeneralSnapshot $Title
            $signature = "$($snapshot.Signature)|$($snapshot.ScrollPercent)|$($snapshot.Scrollable)"
            if ($signature -ceq $last) { $stable++ } else { $stable = 0; $last = $signature }
            if ($stable -ge 3) {
                # Resolve rich-text ranges once after stability, not on every poll.
                if ($snapshot.PSObject.Properties['Binding']) {
                    $snapshot.Text = (Get-ImaGeneralMarkdown $snapshot.Binding $snapshot.BodyRange $snapshot.RawText).Replace("`r`n", "`n").Replace("`r", "`n").Trim()
                    $snapshot.Signature = Get-ImaViewportFingerprint $snapshot.Text
                }
                return $snapshot
            }
        }
        catch [OperationCanceledException] { throw }
        catch { $lastError = $_.Exception.Message; $stable = 0; $last = "" }
        Start-ImaCancelableSleep 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "等待通用文字正文稳定超时：$Title（$lastError）"
}

function Merge-ImaGeneralText([string]$Left, [string]$Right) {
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { throw "通用正文窗口为空" }
    if ($Left.EndsWith($Right, [StringComparison]::Ordinal)) { return $Left }
    if ($Right.StartsWith($Left, [StringComparison]::Ordinal)) { return $Right }
    # Exact overlap preserves punctuation, formulas and code; unlike the speed-reader
    # normalizer it never equates two windows merely by their letters/digits.
    $limit = [Math]::Min(20000, $Right.Length)
    if ($limit -lt 16) { throw "通用正文重叠过短，无法可靠拼接" }
    $prefix = New-Object 'int[]' $limit
    for ($index = 1; $index -lt $limit; $index++) {
        $candidate = $prefix[$index - 1]
        while ($candidate -gt 0 -and $Right[$index] -cne $Right[$candidate]) { $candidate = $prefix[$candidate - 1] }
        if ($Right[$index] -ceq $Right[$candidate]) { $candidate++ }
        $prefix[$index] = $candidate
    }
    $matched = 0
    for ($index = [Math]::Max(0, $Left.Length - $limit); $index -lt $Left.Length; $index++) {
        while ($matched -gt 0 -and $Left[$index] -cne $Right[$matched]) { $matched = $prefix[$matched - 1] }
        if ($Left[$index] -ceq $Right[$matched]) { $matched++ }
        if ($matched -eq $limit -and $index -lt $Left.Length - 1) { $matched = $prefix[$matched - 1] }
    }
    if ($matched -lt 16) { throw "相邻通用正文窗口缺少可靠重叠，已停止保存，避免漏字" }
    return $Left + $Right.Substring($matched)
}

function Test-ImaContentEndVisible([object]$Content, [object]$Viewport) {
    # Only an un-clipped, full-height editor extent can prove its own end. A
    # viewport-sized/clipped rectangle is not evidence that virtual text is complete.
    return $Viewport.Height -gt 100 -and $Content.Width -gt 0 -and
        $Content.Height -gt $Viewport.Height + 8 -and $Content.Top -lt $Viewport.Top -and
        $Content.Bottom -gt $Viewport.Top -and $Content.Bottom -le $Viewport.Bottom + 2
}

function Test-ImaGeneralBottom([object]$Snapshot) {
    if (-not $Snapshot.Scrollable) { return $true }
    if ($Snapshot.PSObject.Properties['ContentEndVisible'] -and $Snapshot.ContentEndVisible) { return $true }
    return -not [double]::IsNaN($Snapshot.ScrollPercent) -and $Snapshot.ScrollPercent -ge 99 -and $Snapshot.ScrollPercent -le 105
}

function Read-ImaGeneralArticle([string]$Title) {
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    $snapshot = Wait-ImaGeneralSnapshot $Title
    if ($snapshot.Scrollable -and $snapshot.ScrollPercent -gt 0.5) {
        $snapshot.Scroller.SetScrollPercent([Windows.Automation.ScrollPattern]::NoScroll, 0)
        $snapshot = Wait-ImaGeneralSnapshot $Title
    }
    if ($snapshot.Scrollable -and ($snapshot.ScrollPercent -lt 0 -or $snapshot.ScrollPercent -gt 0.5)) {
        throw "无法确认通用文章从正文顶部开始，已停止保存"
    }
    $body = $snapshot.Text
    $updatedDate = if ($snapshot.PSObject.Properties['UpdatedDate']) { $snapshot.UpdatedDate } else { Get-ImaOptionalUpdatedDate $snapshot.Text }
    $bottomObservations = 0
    Write-SyncLog "$Title 通用正文开始：位置 $($snapshot.ScrollPercent)，可见比例 $($snapshot.ViewSize)，已读 $($body.Length) 字符"
    for ($window = 0; $window -lt 300; $window++) {
        Test-ImaCancellation
        if ([DateTime]::UtcNow -ge $deadline) { throw "通用文章读取超过 120 秒，保留未完成状态，不重复打开" }
        if (-not $snapshot.Scrollable) {
            return [pscustomobject]@{ body = $body; updatedDate = $updatedDate; complete = $true }
        }
        $before = $snapshot
        if ($before.PSObject.Properties['ContentEndVisible'] -and $before.ContentEndVisible) {
            # Full editor geometry is independent proof of the end. Confirm it
            # through two subsequent stable reads without desktop mouse input.
            Start-ImaCancelableSleep 200
        }
        elseif (-not (Test-ImaGeneralBottom $before) -and $before.ScrollPercent -lt 99) {
            $step = [Math]::Max(0.01, [Math]::Min(10, $before.ViewSize * 0.5))
            $next = [Math]::Min(100, $before.ScrollPercent + $step)
            try { $before.Scroller.SetScrollPercent([Windows.Automation.ScrollPattern]::NoScroll, $next) }
            catch { Invoke-ImaBodyMouseWheel $Title -300 }
        }
        else { Invoke-ImaBodyMouseWheel $Title -300 }
        $snapshot = Wait-ImaGeneralSnapshot $Title
        if ($snapshot.Signature -ceq $before.Signature -and [Math]::Abs($snapshot.ScrollPercent - $before.ScrollPercent) -lt 0.05) {
            if (Test-ImaGeneralBottom $snapshot) {
                $bottomObservations++
                if ($bottomObservations -ge 2) {
                    return [pscustomobject]@{ body = $body; updatedDate = $updatedDate; complete = $true }
                }
                continue
            }
            # A provider can silently ignore SetScrollPercent. One scoped wheel
            # fallback, never a second full-article traversal.
            Invoke-ImaBodyMouseWheel $Title -300
            $snapshot = Wait-ImaGeneralSnapshot $Title
            if ($snapshot.Signature -ceq $before.Signature -and [Math]::Abs($snapshot.ScrollPercent - $before.ScrollPercent) -lt 0.05) {
                $bounds = if ($snapshot.PSObject.Properties['ContentBottom']) { "，正文底部 $($snapshot.ContentBottom)，正文高度 $($snapshot.ContentHeight)，视口底部 $($snapshot.ViewportBottom)" } else { '' }
                throw "通用正文在中途停止滚动，不能当作已到末尾（位置 $($snapshot.ScrollPercent)，可见比例 $($snapshot.ViewSize)，第 $($window + 1) 窗口，已读 $($body.Length) 字符$bounds）"
            }
        }
        $bottomObservations = 0
        if ($snapshot.ScrollPercent -lt $before.ScrollPercent - 0.1) { throw "正文滚动倒退，已停止保存，避免内容错序" }
        $body = Merge-ImaGeneralText $body $snapshot.Text
        if (($window + 1) % 10 -eq 0) { Write-SyncLog "$Title 通用正文进度：$($window + 1) 窗口，位置 $($snapshot.ScrollPercent)，已读 $($body.Length) 字符" }
    }
    throw "通用正文超过读取窗口上限，未确认完整，不保存"
}

function Invoke-ImaGeneralSync([Windows.Automation.AutomationElement]$Root) {
    $records = @(Get-ImaRecentArticleRecords $Root $MaxItems)
    $canceled = $false
    $checkedCount = 0
    foreach ($record in $records) {
        $checkedCount++
        Write-ImaProgress "正在检查第 $checkedCount / $($records.Count) 篇文章：$($record.Name)"
        $opened = $false
        try {
            Test-ImaCancellation
            if ($record.SourceId -and $script:SkipSourceIds.ContainsKey($record.SourceId)) {
                $script:CompletedSkippedTitles.Add($record.Name)
                Write-SyncLog "$($record.Name) 来源 ID 已同步，打开前跳过"
                continue
            }
            if ($record.Kind -ne "note") { throw "当前通用文字阶段暂不支持 $($record.Kind) 类型，未打开该条目" }
            Invoke-ImaArticleRecord $record
            $opened = $true
            $article = Read-ImaGeneralArticle $record.Name
            $result = [ordered]@{ sourceTitle = $record.Name; updatedDate = $article.updatedDate; body = $article.body; complete = $article.complete }
            if ($record.SourceId) { $result.sourceId = $record.SourceId }
            $script:CompletedItems.Add([pscustomobject]$result)
            Write-SyncLog "$($record.Name) 通用文字已读取：$($article.body.Length) 字符"
        }
        catch [OperationCanceledException] { $canceled = $true }
        catch {
            $script:CompletedErrors.Add([pscustomobject]@{ title = $record.Name; message = $_.Exception.Message })
            Write-SyncLog "通用文字错误 $($record.Name)：$($_.Exception.Message)"
        }
        finally {
            if ($opened) { try { Close-ImaCurrentArticle | Out-Null } catch { Write-SyncLog "关闭文章失败：$($_.Exception.Message)" } }
        }
        if ($canceled) { break }
    }
    return [pscustomobject]@{
        busy = $false; canceled = $canceled
        items = @($script:CompletedItems.ToArray()); errors = @($script:CompletedErrors.ToArray())
        skippedTitles = @($script:CompletedSkippedTitles.ToArray())
    }
}

function Invoke-ImaSync {
    $script:CompletedItems = New-Object Collections.Generic.List[object]
    $script:CompletedErrors = New-Object Collections.Generic.List[object]
    $script:CompletedSkippedTitles = New-Object Collections.Generic.List[string]
    if ([string]::IsNullOrWhiteSpace($script:KnowledgeBaseName) -or [string]::IsNullOrWhiteSpace($script:FolderName)) {
        throw "IMA 知识库名称和文件夹名称不能为空"
    }
    if ($MaxItems -lt 1 -or $MaxItems -gt 1000) {
        throw "文章检查数量必须在 1–1000 之间：$MaxItems"
    }
    try {
        [void][regex]::new($script:TitlePattern)
    }
    catch {
        throw "IMA 标题匹配规则无效：$($script:TitlePattern)"
    }

    Write-SyncLog "同步开始：已加载 $($script:SkipTitles.Count) 个提取前跳过标题"
    Write-ImaProgress '正在打开 IMA 并定位分享文件夹…'
    $root = Open-ImaSpeedFolder
    if ($script:ContentMode -eq "general") { return Invoke-ImaGeneralSync $root }
    $recentTitles = @(Get-ImaRecentTitles $root $MaxItems)
    if ($recentTitles.Count -eq 0) {
        throw "最近的 IMA 文章中没有标题匹配：$($script:TitlePattern)"
    }

    $titles = New-Object Collections.Generic.List[string]
    $skippedTitles = $script:CompletedSkippedTitles
    foreach ($title in $recentTitles) {
        if ($script:SkipTitles.ContainsKey($title)) {
            $skippedTitles.Add($title)
            Write-SyncLog "$title 已存在且选择了同名不覆盖，提取前跳过"
        }
        else {
            $titles.Add($title)
        }
    }

    $items = $script:CompletedItems
    $errors = $script:CompletedErrors
    $canceled = $false
    $checkedCount = $skippedTitles.Count
    foreach ($title in $titles) {
        $checkedCount++
        Write-ImaProgress "正在检查第 $checkedCount / $($recentTitles.Count) 篇文章：$title"
        $opened = $false
        try {
            Test-ImaCancellation
            Invoke-ImaArticleTitle $title
            $opened = $true
            Write-SyncLog "$title 已打开"
            $document = Wait-ImaDocument $title
            $updatedDate = Get-ImaUpdatedDateFromText (Get-ImaDocumentText $document)
            $body = Read-ImaCompleteArticleWithRetry $title
            $items.Add([pscustomobject]@{
                sourceTitle = $title
                updatedDate = $updatedDate
                body = $body
            })
            Write-SyncLog "$title 已提取：$($body.Length) 个字符，更新日期 $updatedDate"
        }
        catch [OperationCanceledException] {
            $canceled = $true
        }
        catch {
            $message = $_.Exception.Message
            $errors.Add([pscustomobject]@{
                title = $title
                message = $message
            })
            Write-SyncLog "错误 $title：$message"
        }
        finally {
            if ($opened) {
                try {
                    Close-ImaCurrentArticle | Out-Null
                }
                catch {
                    Write-SyncLog "关闭 $title 时出错：$($_.Exception.Message)"
                }
            }
        }
        if ($canceled) {
            break
        }
    }

    if ($canceled) {
        Write-SyncLog "同步已由用户取消：保留已提取 $($items.Count) 篇"
    }
    else {
        Write-SyncLog "同步完成：成功提取 $($items.Count) 篇，提取前跳过 $($skippedTitles.Count) 篇，失败 $($errors.Count) 篇"
    }
    return [pscustomobject]@{
        busy = $false
        canceled = $canceled
        items = @($items.ToArray())
        errors = @($errors.ToArray())
        skippedTitles = @($skippedTitles.ToArray())
    }
}

if (
    -not (Get-Variable -Name ImaSpeedSyncSkipMain -ErrorAction SilentlyContinue) -and
    $MyInvocation.InvocationName -ne '.'
) {
    $mutex = New-Object Threading.Mutex($false, "Local\ImaSpeedSync")
    $locked = $false
    $syncStarted = $false
    try {
        $locked = Enter-ImaMutex $mutex
        if (-not $locked) {
            Write-ImaResult ([pscustomobject]@{
                busy = $true
                canceled = $false
                items = @()
                errors = @()
                skippedTitles = @()
            })
            exit 0
        }
        $syncStarted = $true
        Write-ImaResult (Invoke-ImaSync)
    }
    catch [OperationCanceledException] {
        Write-SyncLog "同步已由用户取消"
        Write-ImaResult ([pscustomobject]@{
            busy = $false
            canceled = $true
            items = @($script:CompletedItems.ToArray())
            errors = @($script:CompletedErrors.ToArray())
            skippedTitles = @($script:CompletedSkippedTitles.ToArray())
        })
    }
    catch {
        $message = $_.Exception.Message
        Write-SyncLog "错误：$message"
        Write-ImaResult ([pscustomobject]@{
            busy = $false
            canceled = $false
            items = @($script:CompletedItems.ToArray())
            errors = @($script:CompletedErrors.ToArray()) + @([pscustomobject]@{
                title = $script:CurrentArticleTitle
                message = $message
            })
            skippedTitles = @($script:CompletedSkippedTitles.ToArray())
        })
        throw
    }
    finally {
        if ($syncStarted) {
            Write-ImaProgress '正在结束 IMA 自动操作…'
            try {
                Close-ImaApplication | Out-Null
            }
            catch {
                Write-SyncLog "同步结束后关闭 IMA 失败：$($_.Exception.Message)"
            }
        }
        if ($locked) {
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}
