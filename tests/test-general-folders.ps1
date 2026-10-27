$ErrorActionPreference = 'Stop'
$ImaSpeedSyncSkipMain = $true
$sourcePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\sync.ps1'
# Replace only UI parameter types so offline fake objects can exercise the real
# collector. All native entry points below are guarded against desktop access.
. ([scriptblock]::Create([IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8).Replace('[Windows.Automation.AutomationElement]$', '[object]$')))
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Get-ImaRoot { throw 'OFFLINE TEST: desktop access is forbidden' }
function Get-ImaWindowRoots { throw 'OFFLINE TEST: desktop access is forbidden' }
function Write-SyncLog {}
function Write-ImaProgress {}
$script:Checks=0
function Check($Expected, $Actual, [string]$Name) {
    $script:Checks++
    if ($Expected -cne $Actual) { throw "$Name : expected <$Expected>, got <$Actual>" }
}
function Check-Throws([scriptblock]$Action, [string]$Name) {
    $script:Checks++
    try { & $Action } catch { return }
    throw "$Name : expected a failure"
}

Check 0 (Get-ImaCardTitleIndex @('研报.pdf','PDF','08:52') 'pdf') 'files have upload time without update suffix'
Check 0 (Get-ImaCardTitleIndex @('子目录','12','项','昨天更新') 'folder') 'folder card layout'
Check-Throws { Get-ImaCardTitleIndex @('摘要','不确定的标签','时间') 'pdf' } 'unknown card is not guessed'
$now = [datetime]::new(2026,1,2,10,0,0)
Check '2026-01-02 08:52' (Convert-ImaListTime '08:52' $now).ToString('yyyy-MM-dd HH:mm') 'today upload'
Check '2026-01-01' (Convert-ImaListTime '昨天更新' $now).ToString('yyyy-MM-dd') 'yesterday'
Check '2025-12-31' (Convert-ImaListTime '12/31' $now).ToString('yyyy-MM-dd') 'year rollover'
Check '2024-01-01' (Convert-ImaListTime '2024/1/1更新' $now).ToString('yyyy-MM-dd') 'explicit year'
Check-Throws { Convert-ImaListTime '13/32' $now } 'invalid calendar date'
Check-Throws { Convert-ImaListTime '25:70' $now } 'invalid clock'
Check-Throws { Convert-ImaListTime '未知时间' $now } 'unknown date does not invent recency'
Check 'A／B.md' (Get-ImaLocalRelativePath ([pscustomobject]@{Name='A/B';Kind='note';RelativeFolder=@()})) 'same filename normalization as vault'
Check '日报/研报.pdf' (Get-ImaLocalRelativePath ([pscustomobject]@{Name='研报.pdf';Kind='pdf';RelativeFolder=@('日报')})) 'relative binary destination'
Check 'A／B.pdf' (Get-ImaLocalRelativePath ([pscustomobject]@{Name='A/B.pdf';Kind='pdf';RelativeFolder=@()})) 'binary title slash is sanitized, not discarded'
$left = Get-ImaLocalRelativePath ([pscustomobject]@{Name='纪要';Kind='note';RelativeFolder=@('A/B')})
$right = Get-ImaLocalRelativePath ([pscustomobject]@{Name='纪要';Kind='note';RelativeFolder=@('A／B')})
Check $true ($left -cne $right) 'sanitized folder collision has stable suffix'

& {
    function Get-ImaWindowRoots { return [pscustomobject]@{Current=[pscustomobject]@{Name='A B.pdf'}} }
    Check 'Present' (Get-ImaOriginalWindowPresence ("A" + [char]0xA0 + 'B.pdf')).State 'reader accepts NBSP to space transformation'
    Check 'Absent' (Get-ImaOriginalWindowPresence 'A C.pdf').State 'reader does not fuzzy-match other titles'
    function Get-ImaWindowRoots { return @([pscustomobject]@{Current=[pscustomobject]@{Name='A B.pdf'}},[pscustomobject]@{Current=[pscustomobject]@{Name='A B.pdf'}}) }
    Check 'Unknown' (Get-ImaOriginalWindowPresence 'A B.pdf').State 'ambiguous reader is never chosen'
}

& {
    $script:testPercent=0; $script:scrollCalls=0
    $scroller=[pscustomobject]@{RangePattern=$null;Pattern=[pscustomobject]@{Current=[pscustomobject]@{VerticalViewSize=50;VerticalScrollPercent=0}}}
    function Get-ImaRoot { return [pscustomobject]@{} }
    function Get-ImaTitleListElement { return [pscustomobject]@{Current=[pscustomobject]@{BoundingRectangle=[pscustomobject]@{Height=100;Y=0}}} }
    function Get-ImaTitleListScroller { return $scroller }
    function Reset-ImaTitleListToTop { $script:testPercent=0 }
    function Set-ImaTitleListScrollPercent { param($Target,$Percent) $script:testPercent=$Percent; $script:scrollCalls++; $scroller.Pattern.Current.VerticalScrollPercent=$Percent }
    function Start-ImaCancelableSleep {}
    function Test-ImaNamedElement { return $true } # Footer is present even before all rows are exposed.
    function Get-ImaGeneralTitleSnapshot {
        $count=if ($script:testPercent -lt 50) {16} else {21}
        return [pscustomobject]@{AllRecords=@(1..$count | ForEach-Object { [pscustomobject]@{Key="$_";Y=0;ScrollPercent=0;ScrollStep=0} })}
    }
    $script:GeneralScanStarted=[DateTime]::UtcNow; $script:GeneralScannedFolders=0
    $rows=@(Get-ImaFolderRecords $null 21)
    Check 21 $rows.Count 'virtual footer does not truncate 21 rows to 16'
    Check 2 $script:scrollCalls 'continues metadata scrolling until expected count is complete'
    $script:scrollCalls=0
    function Set-ImaTitleListScrollPercent {
        param($Target,$Percent)
        $script:scrollCalls++
        $scroller.Pattern.Current.VerticalScrollPercent = if ($script:scrollCalls -eq 1) {99} elseif ($script:scrollCalls -eq 2) {88.3} else {100}
    }
    function Get-ImaGeneralTitleSnapshot {
        $count=if ($script:scrollCalls -lt 1) {16} elseif ($script:scrollCalls -lt 2) {70} else {78}
        return [pscustomobject]@{AllRecords=@(1..$count | ForEach-Object { [pscustomobject]@{Key="$_";Y=0;ScrollPercent=0;ScrollStep=0} })}
    }
    $rows=@(Get-ImaFolderRecords $null 78)
    Check 78 $rows.Count 'lazy loading percentage regression still completes all metadata'
    Check 2 $script:scrollCalls 'does not mistake expanded scroll extent for failed scrolling'
    # 模拟用户现场：预期 19 项，首屏读到 16 项，滚动位置卡在 0->0 不动
    $scroller.Pattern.Current.VerticalScrollPercent = 0
    function Set-ImaTitleListScrollPercent { $scroller.Pattern.Current.VerticalScrollPercent=0 }
    function Get-ImaGeneralTitleSnapshot { return [pscustomobject]@{AllRecords=@(1..16 | ForEach-Object { [pscustomobject]@{Key="$_";Y=0;ScrollPercent=0;ScrollStep=0} })} }
    $partialRows = @(Get-ImaFolderRecords $null 19)
    Check 16 $partialRows.Count 'stalled scroll retains 16 read records instead of aborting whole sync'

    function Get-ImaGeneralTitleSnapshot { return [pscustomobject]@{AllRecords=@()} }
    function Set-ImaTitleListScrollPercent { $scroller.Pattern.Current.VerticalScrollPercent=0 }
    Check-Throws { Get-ImaFolderRecords $null 78 } 'genuine no-progress still stops safely'
    $script:GeneralScanStarted=$null
}

& {
    function Get-ImaRoot { return [pscustomobject]@{} }
    function Get-ImaTitleListElement { return [pscustomobject]@{Current=[pscustomobject]@{BoundingRectangle=[pscustomobject]@{Height=100;Y=0}}} }
    function Get-ImaTitleListScroller { return $null }
    function Reset-ImaTitleListToTop {}
    function Test-ImaNamedElement { return $false } # No footer element on short folders
    function Get-ImaGeneralTitleSnapshot {
        return [pscustomobject]@{AllRecords=@(1..3 | ForEach-Object { [pscustomobject]@{Key="$_";Y=0;ScrollPercent=0;ScrollStep=0} })}
    }
    $script:GeneralScanStarted=[DateTime]::UtcNow; $script:GeneralScannedFolders=0
    $rows = @(Get-ImaFolderRecords $null -1)
    Check 3 $rows.Count 'non-scrollable short folder returns all items without requiring footer element'
    $script:GeneralScanStarted=$null
}

function Make-Record($Name,$Kind,$Time,$Id='', $Count=0) {
    return [pscustomobject]@{Name=$Name;Kind=$Kind;TimeLabel=$Time;SourceId=$Id;Key=$Name;ChildCount=$Count}
}
& {
    $script:FolderName='根目录'; $script:IncludeSubfolders=$true
    $script:GeneralSelectionMode='per-folder'
    $script:MaxFolders=1; $script:MaxFolderDepth=1
    $script:visited=@(); $script:testFolder=''
    function Open-ImaGeneralPath { param($Parts) $script:testFolder=$Parts -join '/'; $script:visited += $script:testFolder; $script:GeneralFolderPath=@($Parts); return $null }
    function Get-ImaFolderRecords {
        if (-not $script:fixture.ContainsKey($script:testFolder)) { throw "Unexpected directory visited: $script:testFolder" }
        return $script:fixture[$script:testFolder]
    }
    $script:fixture=@{
        ''=@((Make-Record 'B' 'folder' '昨天更新' '' 3),(Make-Record 'A' 'folder' '09:00更新' '' 2),(Make-Record '根文章' 'note' '10:00' 'root'))
        A=@((Make-Record '标题-0101' 'note' '09:00' 'a'),(Make-Record '标题-1231' 'note' '前天' 'old'))
        B=@((Make-Record '同一文章另一位置' 'note' '09:00' 'a'),(Make-Record '第二新' 'pdf' '08:00' 'b'),(Make-Record '不得补抓' 'note' '昨天' 'no-backfill'))
    }
    $result = @(Get-ImaGeneralCandidates $null 2)
    Check 2 $result.Count 'one directory uses its own file limit'
    Check 'a,old' (($result | ForEach-Object SourceId) -join ',') 'file list time wins over title date'
    Check 'A' ($result[0].RelativeFolder -join '/') 'relative folder preserved'
    Check ',A' ($script:visited -join ',') 'older sibling is never entered despite more recent files inside it'
    Check 2 $script:GeneralScannedFolders 'default visits root metadata and only the latest child'
    $script:visited=@(); $script:MaxFolders=2
    $result = @(Get-ImaGeneralCandidates $null 2)
    Check 'a,old,b' (($result | ForEach-Object SourceId) -join ',') 'per-directory quotas and cross-directory identity deduplication'
    Check ',A,B' ($script:visited -join ',') 'two selected directories share one total budget'
    Check $false ('no-backfill' -in @($result | ForEach-Object SourceId)) 'cross-directory duplicates do not backfill older files'
    $script:IncludeSubfolders=$false
    $result = @(Get-ImaGeneralCandidates $null 7)
    Check 1 $result.Count 'subfolders switch excludes nested contents'
    Check 'root' $result[0].SourceId 'folders never count as items'

    $script:IncludeSubfolders=$true; $script:MaxFolders=1; $script:MaxFolderDepth=0; $script:visited=@()
    $result = @(Get-ImaGeneralCandidates $null 7)
    Check 'root' $result[0].SourceId 'depth zero reads root files even with child folders'
    Check 1 $script:visited.Count 'depth zero does not navigate to children'

    $script:MaxFolderDepth=1
    $script:fixture=@{''=@(1..10 | ForEach-Object { Make-Record "file-$_" 'note' ('09:{0:D2}' -f $_) "id-$_" })}
    $result = @(Get-ImaGeneralCandidates $null 7)
    Check 7 $result.Count 'flat folders read seven files without requiring child directories'
    Check 'id-10' $result[0].SourceId 'flat folder newest file first'

    # A disposable synthetic month with 24 folders, each containing 60 files.
    # Unselected directories are deliberately absent: visiting one throws.
    $script:fixture=@{
        ''=@(1..24 | ForEach-Object { Make-Record "day-$_" 'folder' ('08:{0:D2}更新' -f $_) '' 60 })
        'day-24'=@(1..60 | ForEach-Object { Make-Record "file-$_" 'pdf' ('09:{0:D2}' -f ($_ - 1)) "new-$_" })
    }
    $script:visited=@()
    $result = @(Get-ImaGeneralCandidates $null 7)
    Check 7 $result.Count '1440-file month selects only seven from newest folder'
    Check ',day-24' ($script:visited -join ',') '1440-file fixture requires only two list reads'
    Check 'new-60' $result[0].SourceId 'newest seven are selected from the chosen directory'
    $MaxItems=7; $script:SkipSourceIds=@{}; $script:ExistingFiles=@{}
    foreach ($number in 54..60) { $script:SkipSourceIds["new-$number"]=$true }
    $script:CompletedItems=New-Object Collections.Generic.List[object]
    $script:CompletedErrors=New-Object Collections.Generic.List[object]
    $script:CompletedSkippedTitles=New-Object Collections.Generic.List[string]
    function Invoke-ImaArticleRecord { throw 'OFFLINE TEST: existing source must not be opened' }
    function Save-ImaOriginalFile { throw 'simulated download failure' }
    $script:visited=@()
    $run = Invoke-ImaGeneralSync $null
    Check 7 $run.skippedTitles.Count 'real collector plus sync skips all seven existing sources before opening'
    Check 0 $run.errors.Count 'all existing is not a failure'
    Check ',day-24' ($script:visited -join ',') 'existing files never trigger older directory backfill'
    $script:SkipSourceIds.Remove('new-60')
    $script:CompletedItems.Clear(); $script:CompletedErrors.Clear(); $script:CompletedSkippedTitles.Clear(); $script:visited=@()
    $run = Invoke-ImaGeneralSync $null
    Check 6 $run.skippedTitles.Count 'other existing files still skip after one failure'
    Check 1 $run.errors.Count 'failed selected file is reported once'
    Check ',day-24' ($script:visited -join ',') 'failure does not select another directory or older files'
    $script:SkipSourceIds=@{}
    $script:MaxFolders=2
    $script:fixture['day-23']=@(1..60 | ForEach-Object { Make-Record "second-$_" 'pdf' ('08:{0:D2}' -f ($_ - 1)) "second-$_" })
    $script:visited=@()
    $result = @(Get-ImaGeneralCandidates $null 7)
    Check 14 $result.Count 'two directories times seven is fourteen, not seven globally'
    Check ',day-24,day-23' ($script:visited -join ',') 'does not visit a third content directory'

    $script:GeneralSelectionMode='total'; $script:visited=@(); $script:testLogs=@()
    function Write-SyncLog { param($Text) $script:testLogs += $Text }
    $script:fixture=@{
        ''=@((Make-Record 'A' 'folder' '09:00' '' 7),(Make-Record 'B' 'folder' '08:00' '' 7),(Make-Record 'C' 'folder' '昨天' '' 7),(Make-Record '不选根文件' 'pdf' '11:00' 'root'))
        A=@(1..7 | ForEach-Object { Make-Record "A-$_" 'pdf' ('09:{0:D2}' -f ($_ * 2)) "a-$_" })
        B=@(1..7 | ForEach-Object { Make-Record "B-$_" 'pdf' ('09:{0:D2}' -f ($_ * 2 + 1)) "b-$_" })
    }
    $result = @(Get-ImaGeneralCandidates $null 7)
    Check 7 $result.Count 'total mode merges two times seven candidates into seven overall'
    Check 'b-7,a-7,b-6,a-6,b-5,a-5,b-4' (($result | ForEach-Object SourceId) -join ',') 'total mode ranks files across selected directories by source time'
    Check ',A,B' ($script:visited -join ',') 'total mode keeps selected-directory budget and root-with-children rule'
    Check 'B' ($result[0].RelativeFolder -join '/') 'global order preserves each candidate relative path'
    Check $true ($script:testLogs[-1] -like '*整轮最多 7 条*') 'total mode log states overall limit'
    $script:SkipSourceIds=@{}
    foreach ($record in $result) { $script:SkipSourceIds[$record.SourceId]=$true }
    $script:CompletedItems.Clear(); $script:CompletedErrors.Clear(); $script:CompletedSkippedTitles.Clear(); $script:visited=@()
    $run = Invoke-ImaGeneralSync $null
    Check 7 $run.skippedTitles.Count 'total mode existing candidates consume all seven slots'
    Check 0 $run.errors.Count 'total mode all-existing selection never opens another item'
    Check ',A,B' ($script:visited -join ',') 'total mode existing selection does not inspect older directories'
    $script:SkipSourceIds.Remove('b-7')
    $script:CompletedItems.Clear(); $script:CompletedErrors.Clear(); $script:CompletedSkippedTitles.Clear(); $script:visited=@()
    $run = Invoke-ImaGeneralSync $null
    Check 6 $run.skippedTitles.Count 'total mode other existing candidates still skip after failure'
    Check 1 $run.errors.Count 'total mode failed newest candidate is not replaced'
    Check 0 $run.items.Count 'total mode never backfills beyond selected seven'
    Check ',A,B' ($script:visited -join ',') 'total mode failure does not expand directory scope'
    $script:SkipSourceIds=@{}

    $script:fixture=@{
        ''=@((Make-Record 'A' 'folder' '09:00' '' 3),(Make-Record 'B' 'folder' '09:00' '' 4))
        A=@(1..3 | ForEach-Object { Make-Record "A-$_" 'note' '10:00' "a-$_" })
        B=@(1..4 | ForEach-Object { Make-Record "B-$_" 'note' '10:00' "b-$_" })
    }
    $script:visited=@()
    $result = @(Get-ImaGeneralCandidates $null 5)
    Check 'a-1,a-2,a-3,b-1,b-2' (($result | ForEach-Object SourceId) -join ',') 'equal times preserve directory selection and original list order'
    Check ',A,B' ($script:visited -join ',') 'equal folder times preserve original folder order'

    $script:fixture=@{
        ''=@((Make-Record 'A' 'folder' '09:00' '' 2),(Make-Record 'B' 'folder' '08:00' '' 2))
        A=@((Make-Record '同来源最新位置' 'note' '10:04' 'shared'),(Make-Record 'A较旧不补抓' 'note' '10:01' 'older-a'))
        B=@((Make-Record '同来源另一位置' 'note' '10:03' 'shared'),(Make-Record 'B较旧不补抓' 'note' '10:02' 'older-b'))
    }
    $result = @(Get-ImaGeneralCandidates $null 2)
    Check 1 $result.Count 'cross-directory duplicate consumes a total-mode candidate slot before deduplication'
    Check 'shared' $result[0].SourceId 'total mode does not backfill the cross-directory duplicate'
    Check 'A' ($result[0].RelativeFolder -join '/') 'duplicate keeps the newest source location'
    $script:MaxFolderDepth=0; $script:visited=@()
    $script:fixture[''] += Make-Record '根文件' 'note' '11:00' 'root'
    $result = @(Get-ImaGeneralCandidates $null 7)
    Check 'root' $result[0].SourceId 'total depth zero reads root files with child folders present'
    Check 1 $script:visited.Count 'total depth zero never enters child folders'
    Check 1 (@(Get-ImaGeneralCandidates $null 1000).Count) '1000 total candidates is an accepted upper bound'
    Check-Throws { Get-ImaGeneralCandidates $null 0 } 'zero total candidate limit rejected'
    Check-Throws { Get-ImaGeneralCandidates $null 1001 } 'more than 1000 total candidates rejected'
    $script:GeneralSelectionMode='per-folder'

    $script:MaxFolders=1; $script:MaxFolderDepth=1; $script:visited=@()
    $script:fixture=@{
        ''=@((Make-Record 'A' 'folder' '09:00' '' 2),(Make-Record 'B' 'folder' '昨天' '' 1))
        A=@((Make-Record 'C' 'folder' '10:00' '' 1),(Make-Record '父目录文件' 'note' '09:00' 'parent'))
        'A/C'=@((Make-Record '深层文件' 'note' '10:00' 'deep'))
    }
    $result = @(Get-ImaGeneralCandidates $null 7)
    Check 'parent' $result[0].SourceId 'depth one excludes grandchildren'
    Check ',A' ($script:visited -join ',') 'underfilled directory does not add another directory'
    $script:MaxFolderDepth=2; $script:visited=@()
    $result = @(Get-ImaGeneralCandidates $null 7)
    Check 'deep' $result[0].SourceId 'newer discovered child takes priority within depth two'
    Check ',A,A/C' ($script:visited -join ',') 'navigation directories do not consume content-directory budget'
    $script:MaxFolders=2; $script:visited=@()
    $result = @(Get-ImaGeneralCandidates $null 7)
    Check 'deep,parent' (($result | ForEach-Object SourceId) -join ',') 'content-directory quota is global across levels'
    Check 3 $script:visited.Count 'cached parent selection does not re-open a directory'

    $script:MaxFolders=1; $script:TitleFilterMode='contains'; $script:TitleFilter='不存在的标题'; $script:visited=@()
    $result = @(Get-ImaGeneralCandidates $null 7)
    Check 0 $result.Count 'filter-empty selected folder does not expand scope'
    Check 3 $script:visited.Count 'title filtering does not backfill from another folder'
    $script:TitleFilterMode='all'; $script:TitleFilter=''
    $script:fixture=@{''=@((Make-Record 'A' 'folder' '未知时间' '' 1))}
    Check-Throws { Get-ImaGeneralCandidates $null 7 } 'unavailable folder timestamps are not invented from names'
    Check $null $script:GeneralScanStarted 'scan timer is cleaned up on failure'
}

& {
    # Every input fixture lives in its own throwaway file; never load plugin data.
    $testInput = [IO.Path]::GetTempFileName()
    try {
        $InputPath = $testInput
        [IO.File]::WriteAllText($testInput, '{"maxFolders":2,"maxFolderDepth":3}', [Text.Encoding]::UTF8)
        Initialize-ImaInput
        Check 2 $script:MaxFolders 'directory quota parsed from plugin input'
        Check 3 $script:MaxFolderDepth 'depth parsed from plugin input'
        Check 'per-folder' $script:GeneralSelectionMode 'missing selection mode preserves legacy per-folder behavior'
        foreach ($invalid in @('{"maxFolders":0}','{"maxFolders":21}','{"maxFolders":1.5}','{"maxFolderDepth":-1}','{"maxFolderDepth":6}','{"maxFolderDepth":"2"}')) {
            [IO.File]::WriteAllText($testInput, $invalid, [Text.Encoding]::UTF8)
            Check-Throws { Initialize-ImaInput } 'invalid traversal bounds rejected'
        }
        [IO.File]::WriteAllText($testInput, '{"includeSubfolders":true,"maxFolderDepth":0}', [Text.Encoding]::UTF8)
        Initialize-ImaInput
        Check $false $script:IncludeSubfolders 'explicit depth zero overrides old traversal switch'
        foreach ($mode in @('total', 'per-folder')) {
            [IO.File]::WriteAllText($testInput, ('{"contentMode":"speed-reader","generalSelectionMode":"' + $mode + '"}'), [Text.Encoding]::UTF8)
            Initialize-ImaInput
            Check $mode $script:GeneralSelectionMode 'selection mode parsed exactly'
            Check 'speed-reader' $script:ContentMode 'general selection field is accepted for speed-reader input'
        }
        foreach ($invalid in @('null','true','false','0','1','1.5','{}','[]','["total"]','["total","per-folder"]','""','"newest"','"TOTAL"','"Per-Folder"','" total "')) {
            [IO.File]::WriteAllText($testInput, ('{"generalSelectionMode":' + $invalid + '}'), [Text.Encoding]::UTF8)
            Check-Throws { Initialize-ImaInput } 'invalid selection mode type or value rejected'
        }
        $script:GeneralSelectionMode='total'
        [IO.File]::WriteAllText($testInput, '{}', [Text.Encoding]::UTF8)
        Initialize-ImaInput
        Check 'per-folder' $script:GeneralSelectionMode 'absent mode resets to legacy even after a previous total-mode input'
    } finally { [IO.File]::Delete($testInput) }
}
& {
    $script:KnowledgeBaseName='offline'; $script:FolderName='offline'
    $script:ContentMode='general'
    function Open-ImaSpeedFolder { throw 'OFFLINE TEST: invalid item limit must fail before desktop access' }
    foreach ($invalidLimit in @(0,1001)) {
        $MaxItems=$invalidLimit
        $message=''
        try { Invoke-ImaSync } catch { $message=$_.Exception.Message }
        Check $true ($message -like '*1–1000*') 'invalid item limit fails before opening IMA'
    }
    $script:ContentMode='speed-reader'
    foreach ($invalidLimit in @(0,1001)) {
        $MaxItems=$invalidLimit
        $message=''
        try { Invoke-ImaSync } catch { $message=$_.Exception.Message }
        Check $true ($message -like '*1–1000*') 'invalid speed-reader limit uses historical range before desktop access'
    }
    function Open-ImaSpeedFolder { return $null }
    function Get-ImaRecentTitles { param($Root,$Limit) $script:acceptedSpeedLimit=$Limit; return 'existing-speed-article' }
    function Invoke-ImaGeneralSync { throw 'OFFLINE TEST: general selection mode must not change speed-reader routing' }
    $script:SkipTitles=@{'existing-speed-article'=$true}
    foreach ($mode in @('total', 'per-folder')) {
        $script:GeneralSelectionMode=$mode
        foreach ($validLimit in @(31,1000)) {
            $MaxItems=$validLimit
            $script:acceptedSpeedLimit=0
            $result=Invoke-ImaSync
            Check $validLimit $script:acceptedSpeedLimit 'speed-reader keeps standalone limits regardless of general selection mode'
            Check 1 $result.skippedTitles.Count 'speed-reader still uses legacy title skipping with general selection field present'
        }
    }
    $script:SkipTitles=@{}
}
& {
    $script:GeneralScanStarted=[DateTime]::UtcNow.AddSeconds(-181)
    Check-Throws { Test-ImaGeneralScanBudget } 'partial scan does not claim global latest'
    $script:GeneralScanStarted=$null
}
& {
    $script:CompletedItems=New-Object Collections.Generic.List[object]
    $script:CompletedErrors=New-Object Collections.Generic.List[object]
    $script:CompletedSkippedTitles=New-Object Collections.Generic.List[string]
    $script:SkipSourceIds=@{}
    $script:ExistingFiles=@{'日报/已有.md'=$true}
    $script:GeneralFolderPath=@('日报')
    function Get-ImaGeneralCandidates { $r=Make-Record '已有' 'note' '09:00' 'id'; $r | Add-Member NoteProperty RelativeFolder @('日报'); return $r }
    function Invoke-ImaArticleRecord { throw 'existing filename must not be opened' }
    $result = Invoke-ImaGeneralSync $null
    Check 1 $result.skippedTitles.Count 'same name skips without opening even with unknown identity'
    Check 0 $result.items.Count 'no older-item backfill'
    Check 0 $result.errors.Count 'skip is not failure'
}
& {
    # 验证严格的位置确认（严格按面包屑状态，拒绝盲目放行）
    $script:FolderName = '2026年10月【最新】'
    $script:GeneralFolderPath = @()

    $fakeRoot = [pscustomobject]@{
        Current = [pscustomobject]@{ NativeWindowHandle = 1; ProcessId = 1234 }
    }

    function Get-ImaRoot { return $fakeRoot }
    function Get-ImaTitleListElement { param($Root) return [pscustomobject]@{ Current = [pscustomobject]@{ IsOffscreen = $false }; GetRuntimeId = { return @(99, 99) } } }
    function Start-ImaCancelableSleep { param($Ms) }
    function Test-ImaGeneralScanBudget {}

    # 1. 模拟停留在“内容”首页时：面包屑只有“内容(17763)”，绝不能把首页误判为目标文件夹
    function Get-ImaBreadcrumbItems {
        param($Root)
        return @([pscustomobject]@{ Current = [pscustomobject]@{ Name = '内容(17763)' } })
    }
    function Test-ImaNamedElement { param($Root, $Name) return $false }
    Check $false (Test-ImaFolderSelected '2026年10月【最新】') 'home page must not be mistaken for selected target folder'

    # 2. 模拟到达目标文件夹：面包屑末项匹配
    function Get-ImaBreadcrumbItems {
        param($Root)
        return @(
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '内容(17763)' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '2026年10月【最新】' } }
        )
    }
    Check $true (Test-ImaFolderSelected '2026年10月【最新】') 'target folder is recognized when breadcrumb end matches'

    # 3. 模拟 Wait-ImaFolderSelected 延迟切换：前 2 次停留在首页，第 3 次切换成功
    $script:pollCount = 0
    function Get-ImaBreadcrumbItems {
        param($Root)
        $script:pollCount++
        if ($script:pollCount -lt 3) {
            return @([pscustomobject]@{ Current = [pscustomobject]@{ Name = '内容(17763)' } })
        }
        return @(
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '内容(17763)' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '2026年10月【最新】' } }
        )
    }
    function Wait-ImaTitleListStable { param($Root, $TimeoutMilliseconds=8000, $Recover=$null) return $fakeRoot }
    $waitRes = Wait-ImaFolderSelected '2026年10月【最新】'
    Check $fakeRoot $waitRes 'Wait-ImaFolderSelected safely waits for navigation to complete before returning'

    # 4. 模拟超时未进入时，抛错附带诊断信息
    function Get-ImaBreadcrumbItems {
        param($Root)
        return @([pscustomobject]@{ Current = [pscustomobject]@{ Name = '内容(17763)' } })
    }
    $timeoutMsg = ''
    try {
        # 模拟超短 deadline 抛错
        $deadline = [DateTime]::UtcNow.AddMilliseconds(-100)
        Wait-ImaFolderSelected '不存在的目录'
    } catch {
        $timeoutMsg = $_.Exception.Message
    }
    Check $true ($timeoutMsg -like '*当前停留在：内容(17763)*') 'timeout error includes current breadcrumb diagnostic text'

    # 5. 模拟进入子文件夹时的多级面包屑路径比对
    function Get-ImaBreadcrumbItems {
        param($Root)
        return @(
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '内容(17763)' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '2026年10月【最新】' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '261019' } }
        )
    }
    $script:GeneralFolderPath = @('261019')
    $resSub = Open-ImaGeneralPath @('261019')
    Check $fakeRoot $resSub 'Open-ImaGeneralPath matches active subfolder breadcrumb without reload'
}
& {
    # -------------------------------------------------------------
    # 2026-10-26 文件夹导航状态机与受控恢复深度离线验证套件
    # -------------------------------------------------------------
    $script:FolderName = '研报分享'
    $fakeRoot = [pscustomobject]@{
        Current = [pscustomobject]@{ NativeWindowHandle = [IntPtr]1234; ProcessId = 5678; IsOffscreen = $false }
    }
    function Get-ImaRoot { return $fakeRoot }
    function Start-ImaCancelableSleep { param($Ms) }
    function Test-ImaGeneralScanBudget {}
    function Wait-ImaTitleListStable { param($Root, $TimeoutMilliseconds=8000, $Recover=$null) return $fakeRoot }

    # 场景 1：正常父目录 -> 目标目录：1 次进入，无无谓重试
    $script:retryInvoked = 0
    function Get-ImaBreadcrumbItems {
        param($Root)
        return @(
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '研报分享' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '2026年10月【最新】' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '261025' } }
        )
    }
    function Get-ImaTitleListElement { param($Root) return [pscustomobject]@{ Current = [pscustomobject]@{ IsOffscreen = $false } } }
    $res1 = Wait-ImaFolderSelected '261025' -ExpectedPath @('研报分享', '2026年10月【最新】', '261025') -ParentPath @('研报分享', '2026年10月【最新】') -RetryAction { $script:retryInvoked++ }
    Check $fakeRoot $res1 'Scene 1: clean navigation confirms full expected path without retries'
    Check 0 $script:retryInvoked 'Scene 1: zero retry count on direct match'

    # 场景 2：Invoke 返回后旧父目录短暂保持稳定，随后目标出现（过渡延迟），等待期间不重复提交
    $script:probeStep = 0
    $script:retryInvoked = 0
    function Get-ImaBreadcrumbItems {
        param($Root)
        $script:probeStep++
        if ($script:probeStep -le 2) {
            return @(
                [pscustomobject]@{ Current = [pscustomobject]@{ Name = '研报分享' } },
                [pscustomobject]@{ Current = [pscustomobject]@{ Name = '2026年10月【最新】' } }
            )
        }
        return @(
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '研报分享' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '2026年10月【最新】' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '261025' } }
        )
    }
    $res2 = Wait-ImaFolderSelected '261025' -ExpectedPath @('研报分享', '2026年10月【最新】', '261025') -ParentPath @('研报分享', '2026年10月【最新】') -RetryAction { $script:retryInvoked++ }
    Check $fakeRoot $res2 'Scene 2: transient old parent stability does not falsely succeed nor trigger eager retries'
    Check 0 $script:retryInvoked 'Scene 2: zero retries during normal delay'

    # 场景 3：面包屑和列表同时暂时消失（Navigating 状态），随后恢复目标，严禁补点击
    $script:navStep = 0
    $script:retryInvoked = 0
    function Get-ImaBreadcrumbItems {
        param($Root)
        $script:navStep++
        if ($script:navStep -le 2) {
            return @()
        }
        return @(
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '研报分享' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '2026年10月【最新】' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '261025' } }
        )
    }
    function Get-ImaTitleListElement {
        param($Root)
        if ($script:navStep -le 2) { return $null }
        return [pscustomobject]@{ Current = [pscustomobject]@{ IsOffscreen = $false } }
    }
    $res3 = Wait-ImaFolderSelected '261025' -ExpectedPath @('研报分享', '2026年10月【最新】', '261025') -ParentPath @('研报分享', '2026年10月【最新】') -RetryAction { $script:retryInvoked++ }
    Check $fakeRoot $res3 'Scene 3: temporary loss of breadcrumbs and list correctly identified as Navigating and recovers'
    Check 0 $script:retryInvoked 'Scene 3: zero retries when navigating transition observed'

    # 场景 4：面包屑和列表永久缺失，到时明确失败且包含诊断，不无限重试
    function Get-ImaBreadcrumbItems { param($Root) return @() }
    function Get-ImaTitleListElement { param($Root) return $null }
    $errMsg4 = ''
    try {
        Wait-ImaFolderSelected '261025' -ExpectedPath @('研报分享', '2026年10月【最新】', '261025') -ParentPath @('研报分享', '2026年10月【最新】') -TimeoutSeconds 1
    } catch {
        $errMsg4 = $_.Exception.Message
    }
    Check $true ($errMsg4 -like '*文件夹跳转未完成：261025*') 'Scene 4: permanent loss safely times out'
    Check $true ($errMsg4 -like '*当前停留在：（无面包屑）*') 'Scene 4: reports empty breadcrumb diagnostic'
    Check $true ($errMsg4 -like '*状态：Navigating*') 'Scene 4: reports navigating state diagnostic'

    # 场景 5：明确终态错误（如“当前文件夹不存在”），不等到统一超时才报错，立即退出
    $missingElement = [pscustomobject]@{ Current = [pscustomobject]@{ Name = '当前文件夹不存在'; IsOffscreen = $false } }
    $fakeRootWithErr = [pscustomobject]@{
        Current = [pscustomobject]@{ NativeWindowHandle = [IntPtr]1234; ProcessId = 5678; IsOffscreen = $false }
    }
    $fakeRootWithErr | Add-Member -MemberType ScriptMethod -Name 'FindFirst' -Value { param($scope, $cond) return $missingElement }
    function Get-ImaRoot { return $fakeRootWithErr }
    $errMsg5 = ''
    $startT5 = [DateTime]::UtcNow
    try {
        Wait-ImaFolderSelected '261025' -ExpectedPath @('研报分享', '2026年10月【最新】', '261025') -TimeoutSeconds 10
    } catch {
        $errMsg5 = $_.Exception.Message
    }
    $elapsedT5 = ([DateTime]::UtcNow - $startT5).TotalSeconds
    Check $true ($errMsg5 -like '*当前文件夹不存在*') 'Scene 5: terminal error is recognized immediately'
    Check $true ($elapsedT5 -lt 5) 'Scene 5: terminates fast without waiting for full 10s budget'
    function Get-ImaRoot { return $fakeRoot }

    # 场景 6：目标目录合法为空（空列表容器可见但 0 条目），确认完整路径后安全就绪
    function Get-ImaBreadcrumbItems {
        param($Root)
        return @(
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '研报分享' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '2026年10月【最新】' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '合法空目录' } }
        )
    }
    function Get-ImaTitleListElement { param($Root) return [pscustomobject]@{ Current = [pscustomobject]@{ IsOffscreen = $false } } }
    function Wait-ImaTitleListStable { param($Root, $TimeoutMilliseconds=8000, $Recover=$null) throw "列表已找到，但没有识别到可见标题" }
    $res6 = Wait-ImaFolderSelected '合法空目录' -ExpectedPath @('研报分享', '2026年10月【最新】', '合法空目录')
    Check $fakeRoot $res6 'Scene 6: legitimate empty folder with visible container succeeds after path confirmed'
    function Wait-ImaTitleListStable { param($Root, $TimeoutMilliseconds=8000, $Recover=$null) return $fakeRoot }

    # 场景 7：同名目录位于不同父级（路径歧义防护）
    function Get-ImaBreadcrumbItems {
        param($Root)
        return @(
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '研报分享' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '2026年09月【旧】' } },
            [pscustomobject]@{ Current = [pscustomobject]@{ Name = '261025' } }
        )
    }
    $errMsg7 = ''
    try {
        Wait-ImaFolderSelected '261025' -ExpectedPath @('研报分享', '2026年10月【最新】', '261025') -ParentPath @('研报分享', '2026年10月【最新】') -TimeoutSeconds 1
    } catch {
        $errMsg7 = $_.Exception.Message
    }
    Check $true ($errMsg7 -like '*文件夹跳转未完成：261025*') 'Scene 7: rejects same leaf name when parent path mismatches'

    # 场景 8：窗口隐藏（WindowHidden）时安全中止，不补点击
    $hiddenRoot = [pscustomobject]@{
        Current = [pscustomobject]@{ NativeWindowHandle = [IntPtr]1234; ProcessId = 5678; IsOffscreen = $true }
    }
    function Get-ImaRoot { return $hiddenRoot }
    $errMsg8 = ''
    try {
        Wait-ImaFolderSelected '261025' -TimeoutSeconds 1
    } catch {
        $errMsg8 = $_.Exception.Message
    }
    Check $true ($errMsg8 -like '*隐藏或最小化状态*') 'Scene 8: offscreen window is identified as WindowHidden and aborts'
    function Get-ImaRoot { return $fakeRoot }

    # 场景 9：原生补点击在许可未开启（AllowForeground=false）时安全拒绝
    $script:AllowForeground = $false
    $script:nativeClickCalls = 0
    $script:ImaNativeClickInvoker = { param($x, $y, $h) $script:nativeClickCalls++; return [pscustomobject]@{ Success=$true } }
    $nativeRes9 = Invoke-ImaSafeNativeClick 100 200 ([IntPtr]1234)
    Check $false $nativeRes9.Success 'Scene 9: native click rejected when AllowForeground is false'
    Check 'PermissionDenied' $nativeRes9.Reason 'Scene 9: reason is PermissionDenied'
    Check 0 $script:nativeClickCalls 'Scene 9: underlying invoker is never called'

    # 场景 10：原生补点击在目标坐标被遮挡（Hit-Test 失败）时安全拒绝
    $script:AllowForeground = $true
    $script:ImaNativeClickInvoker = {
        param($x, $y, $h)
        $script:nativeClickCalls++
        if ($h -ne [IntPtr]1234) {
            return [pscustomobject]@{ Success=$false; Executed=$false; Reason='OccludedOrMismatch' }
        }
        return [pscustomobject]@{ Success=$true; Executed=$true; Reason='Clicked' }
    }
    $nativeRes10 = Invoke-ImaSafeNativeClick 100 200 ([IntPtr]9999)
    Check $false $nativeRes10.Success 'Scene 10: occluded or mismatched window is safely rejected'
    Check 'OccludedOrMismatch' $nativeRes10.Reason 'Scene 10: reason is OccludedOrMismatch'

    # 场景 11：原生补点击在合法许可且窗口匹配时，通过假能力记录坐标，不调用真实 user32
    $script:passedCoords = @()
    $script:ImaNativeClickInvoker = {
        param($x, $y, $h)
        $script:passedCoords = @($x, $y)
        return [pscustomobject]@{ Success=$true; Executed=$true; Reason='Clicked' }
    }
    $nativeRes11 = Invoke-ImaSafeNativeClick 450 620 ([IntPtr]1234)
    Check $true $nativeRes11.Success 'Scene 11: safe click executes via mock invoker without user32'
    Check '450,620' ($script:passedCoords -join ',') 'Scene 11: coordinates correctly passed to fake invoker'
    $script:ImaNativeClickInvoker = $null
    $script:AllowForeground = $false

    # 场景 12：等待期间取消传播（Cancellation）
    $origTestCancel = ${function:Test-ImaCancellation}
    function Test-ImaCancellation { throw [OperationCanceledException]::new('Task was canceled by user') }
    $isCanceled12 = $false
    try {
        Wait-ImaFolderSelected '261025' -TimeoutSeconds 5
    } catch [OperationCanceledException] {
        $isCanceled12 = $true
    }
    Check $true $isCanceled12 'Scene 12: cancellation immediately aborts wait without retry or swallow'
    if ($origTestCancel) { ${function:Test-ImaCancellation} = $origTestCancel } else { function Test-ImaCancellation {} }
}

Write-Output "PASS: $script:Checks general folder assertions (offline, no desktop input)"
