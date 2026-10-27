$ErrorActionPreference = 'Stop'
$script:checks = 0

# Load only the functions under test. Never initialize the desktop script or IMA.
$sourcePath = Join-Path $PSScriptRoot '../src/sync.ps1'
$tokens = $null
$parseErrors = $null
$sourceAst = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "Source parse failed: $($parseErrors[0].Message)" }
foreach ($functionName in @('Convert-ImaLocalName', 'Get-ImaOriginalFileExtension', 'Get-ImaLocalRelativePath', 'Save-ImaOriginalFile', 'Invoke-ImaGeneralSync')) {
    $definition = $sourceAst.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $functionName
    }, $true)
    if (-not $definition) { throw "Missing source function: $functionName" }
    Invoke-Expression ($definition.Extent.Text.Replace('[Windows.Automation.AutomationElement]', '[object]'))
}

function Check([bool]$Condition, [string]$Label) {
    if (-not $Condition) { throw "FAIL: $Label" }
    $script:checks++
}

function Get-Failure([scriptblock]$Action) {
    try { & $Action | Out-Null } catch { return $_.Exception.Message }
    throw 'Expected a failure, but the action succeeded'
}

function New-Record([string]$Title, [string]$Id = 'source-1', [string]$Kind = 'pdf') {
    [pscustomobject]@{ Name = $Title; SourceId = $Id; Key = "key-$Id"; Kind = $Kind; RelativeFolder = @('day') }
}

# Expected destinations are explicit, not produced by the implementation helper.
$samples = @(
    @{ Title = 'Report.pdf'; Expected = 'day/Report.pdf' },
    @{ Title = 'Report "A".pdf'; Expected = 'day/Report ＂A＂.pdf' },
    @{ Title = 'Report <A>.pdf'; Expected = 'day/Report ＜A＞.pdf' },
    @{ Title = 'Report A|B.pdf'; Expected = 'day/Report A｜B.pdf' },
    @{ Title = "Report A`r`nB.pdf"; Expected = 'day/Report A B.pdf' },
    @{ Title = "Report A`tB.pdf"; Expected = 'day/Report A B.pdf' },
    @{ Title = ('Report A' + [char]1 + 'B.pdf'); Expected = 'day/Report A B.pdf' },
    @{ Title = ('Report A' + [char]1 + [char]2 + 'B.pdf'); Expected = 'day/Report A B.pdf' },
    @{ Title = 'Report A/B.pdf'; Expected = 'day/Report A／B.pdf' },
    @{ Title = 'Report A\B.pdf'; Expected = 'day/Report A＼B.pdf' },
    @{ Title = 'Report A:B.pdf'; Expected = 'day/Report A：B.pdf' },
    @{ Title = 'Report A?B.pdf'; Expected = 'day/Report A？B.pdf' },
    @{ Title = 'Report A*B.pdf'; Expected = 'day/Report A＊B.pdf' },
    @{ Title = '中文研报 “增长”.PDF'; Expected = 'day/中文研报 “增长”.pdf' },
    @{ Title = 'Report.v2.PDF'; Expected = 'day/Report.v2.pdf' },
    @{ Title = '  Report.PDF  '; Expected = 'day/Report.pdf' },
    @{ Title = "Report.PDF`r`n"; Expected = 'day/Report.pdf' }
)
foreach ($sample in $samples) {
    $record = New-Record $sample.Title
    $identityBefore = $record | ConvertTo-Json -Compress
    Check ((Get-ImaOriginalFileExtension $record) -ceq '.pdf') "extension accepts display title: $($sample.Title)"
    Check ((Get-ImaLocalRelativePath $record) -ceq $sample.Expected) "safe destination: $($sample.Title)"
    Check (($record | ConvertTo-Json -Compress) -ceq $identityBefore) 'source title, key, ID and folder are preserved'
}

foreach ($extension in @('.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.wav', '.m4a', '.mp4', '.webm', '.ogg')) {
    $record = New-Record ('File "A"' + $extension.ToUpperInvariant())
    Check ((Get-ImaOriginalFileExtension $record) -ceq $extension) "supported extension $extension"
    Check ((Get-ImaLocalRelativePath $record) -ceq ('day/File ＂A＂' + $extension)) "supported destination $extension"
}

$longRecord = New-Record (('x' * 150) + '.PDF')
Check ((Get-ImaLocalRelativePath $longRecord) -ceq ('day/' + ('x' * 120) + '.pdf')) 'extension survives stem truncation'
$emoji = [char]::ConvertFromUtf32(0x1F600)
$emojiRecord = New-Record (($emoji * 125) + '.PDF')
Check ((Get-ImaLocalRelativePath $emojiRecord) -ceq ('day/' + ($emoji * 120) + '.pdf')) 'stem truncation preserves surrogate pairs and extension'
Check ((Get-ImaLocalRelativePath (New-Record 'Report "A"' 'note-1' 'note')) -ceq 'day/Report ＂A＂.md') 'note titles do not require a binary extension'
Check ((Get-ImaLocalRelativePath (New-Record 'Report <A>' 'url-1' 'weburl')) -ceq 'day/Report ＜A＞.md') 'web titles do not require a binary extension'

foreach ($title in @('Report', 'Report.', 'Report.exe', 'Report.pdf.tmp', 'Report.pdf/escape', 'Report.pdf?x=1', 'Report.pdf.exe')) {
    $message = Get-Failure { Get-ImaLocalRelativePath (New-Record $title) }
    Check ($message.Contains('尚未支持此原文件类型')) "unsupported or nonterminal extension rejected: $title"
    Check (-not $message.Contains('GetExtension')) 'unsupported input has a deliberate error, not a framework path exception'
}

# Exercise the actual download entry point without allowing any desktop access.
function Get-ImaWindowRoots { throw 'OFFLINE: desktop access is forbidden' }
function Get-ImaRoot { throw 'OFFLINE: desktop access is forbidden' }
function Invoke-ImaArticleRecord { throw 'OFFLINE: article opening is forbidden' }
function Open-ImaGeneralPath { throw 'OFFLINE: folder navigation is forbidden' }
function Test-ImaCancellation { }
$script:DownloadDirectory = ''
foreach ($sample in $samples) {
    $message = Get-Failure { Save-ImaOriginalFile (New-Record $sample.Title) }
    Check ($message -ceq '下载暂存目录不可用') 'real save entry passes the extension gate before any UI'
}
$message = Get-Failure { Save-ImaOriginalFile (New-Record 'Report "A".exe') }
Check ($message.Contains('尚未支持此原文件类型')) 'real save entry rejects unsupported types before UI or directory access'

# All later download operations are mocks. No files are created by this suite.
function Reset-Batch {
    $script:CompletedItems = New-Object 'Collections.Generic.List[object]'
    $script:CompletedErrors = New-Object 'Collections.Generic.List[object]'
    $script:CompletedSkippedTitles = New-Object 'Collections.Generic.List[string]'
    $script:SkipSourceIds = @{}
    $script:ExistingFiles = @{}
    $script:GeneralFolderPath = @('day')
    $script:SavedTitles = New-Object 'Collections.Generic.List[string]'
    $script:Messages = New-Object 'Collections.Generic.List[string]'
    $script:CandidateCalls = 0
    $script:CandidateLimit = -1
    $script:CancelNow = $false
    $script:CancelAfter = 0
    $script:CancellationChecks = 0
    $script:MaxItems = 3
}
function Get-ImaGeneralCandidates($Root, $Limit) {
    $script:CandidateCalls++
    $script:CandidateLimit = $Limit
    @($script:BatchRecords | Select-Object -First $Limit)
}
function Save-ImaOriginalFile($Record) {
    $script:SavedTitles.Add($Record.Name)
    "mock-stage-$($Record.SourceId).pdf"
}
function Write-SyncLog([string]$Text) { $script:Messages.Add($Text) }
function Write-ImaProgress([string]$Text) { $script:Messages.Add($Text) }
function Test-ImaCancellation {
    $script:CancellationChecks++
    if ($script:CancelNow -or ($script:CancelAfter -gt 0 -and $script:CancellationChecks -ge $script:CancelAfter)) {
        throw [OperationCanceledException]::new('offline cancellation')
    }
}

Reset-Batch
$script:BatchRecords = @(
    (New-Record 'Good "A".PDF' 'a'),
    (New-Record 'Unsupported.exe' 'b'),
    (New-Record 'Good <C>.pdf' 'c'),
    (New-Record 'Outside-limit.pdf' 'd')
)
$result = Invoke-ImaGeneralSync $null
Check ($result.items.Count -eq 2) 'a malformed record does not abort either valid neighbor'
Check ($result.errors.Count -eq 1) 'one malformed record yields exactly one error'
Check ($result.errors[0].title -ceq 'Unsupported.exe') 'preflight failure identifies the source title'
Check ($result.errors[0].message -match '预检|preflight') 'preflight failure identifies the processing stage'
Check (($script:SavedTitles -join '|') -ceq 'Good "A".PDF|Good <C>.pdf') 'valid records retain candidate order and raw titles'
Check ($script:CandidateCalls -eq 1 -and $script:CandidateLimit -eq 3) 'failure neither rescans nor increases the candidate limit'
Check (-not $script:SavedTitles.Contains('Outside-limit.pdf')) 'failure does not backfill beyond the selected candidates'
Check (-not $result.canceled) 'an invalid title is not a cancellation'

Reset-Batch
$script:BatchRecords = @((New-Record 'Bad.exe' 'bad'))
$result = Invoke-ImaGeneralSync $null
Check ($result.errors.Count -eq 1 -and $result.items.Count -eq 0) 'an all-invalid batch is reported as failed records'
Check ($script:SavedTitles.Count -eq 0) 'all-invalid batch never downloads'
Check (-not (($script:Messages -join "`n") -match '所有研报均为最新|全部 .*本地均已同步')) 'all-invalid batch never claims everything is already synchronized'

Reset-Batch
$script:BatchRecords = @((New-Record 'Report "A".PDF' 'path-skip'), (New-Record 'Known.exe' 'source-skip'), (New-Record 'New.pdf' 'new'))
$script:ExistingFiles['day/report ＂a＂.pdf'] = $true
$script:SkipSourceIds['source-skip'] = $true
$result = Invoke-ImaGeneralSync $null
Check ($result.skippedTitles.Count -eq 2 -and $result.items.Count -eq 1 -and $result.errors.Count -eq 0) 'normalized existing path and source ID still skip before opening'
Check (($script:SavedTitles -join '|') -ceq 'New.pdf') 'already-saved records never reach the downloader'

Reset-Batch
$script:BatchRecords = @((New-Record 'Good.pdf' 'a'), (New-Record 'Good2.pdf' 'b'))
$script:CancelNow = $true
$canceled = $false
try { $result = Invoke-ImaGeneralSync $null; $canceled = [bool]$result.canceled }
catch [OperationCanceledException] { $canceled = $true }
Check $canceled 'cancellation remains cancellation rather than a bad-title error'
Check ($script:CompletedErrors.Count -eq 0) 'cancellation is not added to per-record errors'
Check ($script:SavedTitles.Count -eq 0) 'cancellation prevents downloads'

Reset-Batch
$script:BatchRecords = @((New-Record 'Good.pdf' 'a'), (New-Record 'Good2.pdf' 'b'), (New-Record 'Good3.pdf' 'c'))
$script:CancelAfter = 2
$canceled = $false
try { $result = Invoke-ImaGeneralSync $null; $canceled = [bool]$result.canceled }
catch [OperationCanceledException] { $canceled = $true }
Check $canceled 'cancellation during preflight is retained after a record was queued'
Check ($script:CompletedErrors.Count -eq 0) 'mid-preflight cancellation is not an item failure'
Check ($script:SavedTitles.Count -eq 0) 'preflight cancellation prevents previously queued downloads too'

Write-Output "PASS: $script:checks file title and preflight assertions (offline, no desktop or vault access)"
