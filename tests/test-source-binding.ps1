$ErrorActionPreference = 'Stop'
$ImaSpeedSyncSkipMain = $true
$sourcePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\sync.ps1'
$source = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8)
# Replace only UIA boundary parameter types so the real production functions
# can receive an in-memory desktop fixture. No live UI is available to tests.
. ([scriptblock]::Create($source.Replace('[Windows.Automation.AutomationElement]$', '[object]$')))
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Get-ImaRoot { throw 'OFFLINE TEST: desktop access forbidden' }
function Get-ImaWindowRoots { throw 'OFFLINE TEST: window access forbidden' }
function Write-SyncLog {}
function Write-ImaProgress {}
function Test-ImaCancellation {}
$script:Checks = 0
function Check($Expected, $Actual, [string]$Name) {
    $script:Checks++
    if ($Expected -cne $Actual) { throw "$Name : expected <$Expected>, got <$Actual>" }
}
function Failure([scriptblock]$Action) {
    try { & $Action | Out-Null } catch { return $_.Exception.Message }
    throw 'Expected a failure'
}
function Reset-Binding {
    $script:SourceNeedsRebind = $null
    $script:SourcePathGuard = $null
    $script:KnowledgeBaseName = 'Research KB'
    $script:FolderName = 'Research'
    $script:SourceTargetKind = 'folder'
    $script:GeneralFolderPath = @('daily')
    $script:CompletedItems = New-Object Collections.Generic.List[object]
    $script:CompletedErrors = New-Object Collections.Generic.List[object]
    $script:CompletedSkippedTitles = New-Object Collections.Generic.List[string]
    $script:SkipSourceIds = @{}
    $script:ExistingFiles = @{}
    $script:CurrentArticleTitle = ''
    $script:Operation = 'sync'
    $script:ResumeRecords = @()
    $script:FolderOnlyNavigation = $false
}

& {
    $InputPath = [IO.Path]::GetTempFileName()
    try {
        foreach ($operation in @('sync', 'inspect-source')) {
            [IO.File]::WriteAllText($InputPath, ('{"operation":"' + $operation + '"}'))
            Initialize-ImaInput
            Check $operation $script:Operation 'valid operation is read exactly'
        }
        foreach ($invalid in @('null', 'true', '5', '"INSPECT-SOURCE"', '"delete"')) {
            [IO.File]::WriteAllText($InputPath, ('{"operation":' + $invalid + '}'))
            Check $true ((Failure { Initialize-ImaInput }) -like '*来源操作无效*') 'invalid operation rejected'
        }
        [IO.File]::WriteAllText($InputPath, '{}')
        Initialize-ImaInput
        Check 'sync' $script:Operation 'legacy input defaults to sync'
    } finally { [IO.File]::Delete($InputPath) }
}

& {
    Reset-Binding
    $script:NavigationClicks = 0
    $script:FolderClicks = 0
    $script:TestCrumbs = @('内容(100)', 'Research', 'previous-day')
    $fakeRoot = [pscustomobject]@{Current=[pscustomobject]@{NativeWindowHandle=123; ProcessId=456}}
    function Get-ImaRoot { return $fakeRoot }
    function Get-ImaSourceBreadcrumb { return $script:TestCrumbs }
    function Wait-ImaText {
        param($Name, $TimeoutMilliseconds, $FailureHint)
        if($Name -ceq 'Research'){throw 'OFFLINE TEST: target folder is not loaded until the folder scan scrolls'}
        return $fakeRoot
    }
    function Get-ImaKnowledgeBaseNames {param($Root) return @('Research KB')}
    function Wait-ImaTitleListStable { param($Root) return $Root }
    function Wait-ImaKnowledgeBaseSelected { param($Name) Check 'Research KB' $Name 'knowledge-base page confirmation uses exact configured name'; return $fakeRoot }
    function Invoke-ImaExactNavigation {
        param($Root, $Name, $ExpectedPath, [switch]$KnowledgeBase)
        $script:NavigationClicks++
        if ($KnowledgeBase) { Check 'Research KB' $Name 'explicit knowledge-base entry'; Check 'Research KB' $ExpectedPath[-1] 'knowledge-base root selected before the folder' }
        else { Check '知识库' $Name 'navigation begins at knowledge-base button' }
    }
    function Open-ImaBreadcrumb { param($Name) Check '内容(100)' $Name 'returns to knowledge-base root before selecting folder'; $script:TestCrumbs=@($Name); return $fakeRoot }
    function Find-ImaSourceFolder {
        param($Name, $ExpectedPath)
        Check 'Research' $Name 'inspection selects exact folder name'
        return [pscustomobject]@{Kind='folder';Name=$Name;SourceParentPath=@('内容(100)')}
    }
    function Invoke-ImaArticleRecord { param($Record) Check 'folder' $Record.Kind 'inspection may only invoke a folder card'; $script:FolderClicks++ }
    function Wait-ImaFolderSelected { param($Name, $Record, $ExpectedPath) $script:TestCrumbs=@('内容(100)', $Name); return $fakeRoot }
    function Get-ImaGeneralCandidates { throw 'OFFLINE TEST: inspection must not scan article candidates' }
    function Save-ImaOriginalFile { throw 'OFFLINE TEST: inspection must not download' }
    function Get-ImaRecentTitles { throw 'OFFLINE TEST: inspection must not select articles' }
    $script:Operation='inspect-source'
    $result=Invoke-ImaSync
    Check 2 $script:NavigationClicks 'inspection performs two explicit navigation steps'
    Check 1 $script:FolderClicks 'only source folder is opened'
    Check 0 $result.items.Count 'inspection returns no article results'
    Check 0 $result.errors.Count 'successful inspection has no errors'
    Check 0 $result.skippedTitles.Count 'inspection does not fabricate skip records'
    Check 'Research KB' $result.sourceInspection.knowledgeBaseName 'inspection knowledge base'
    Check 'Research' $result.sourceInspection.folderName 'inspection folder'
    Check '内容(100)/Research' ($result.sourceInspection.breadcrumb -join '/') 'inspection shows complete breadcrumbs'
    Check $true ($null -eq $result.sourceInspection.stableFolderId) 'no fabricated stable folder ID'
    Check 'explicit-confirmation' $result.sourceInspection.identityMode 'user confirmation required without stable ID'
    Check $false $script:FolderOnlyNavigation 'inspection restores normal article parsing mode after navigation'
}

& {
    Reset-Binding
    $script:TestCrumbs=@('内容(100)','Research','daily')
    function Get-ImaSourceBreadcrumb { return $script:TestCrumbs }
    $script:SourcePathGuard=[pscustomobject]@{ExpectedPath=@('Research','daily')}
    Assert-ImaSourcePath
    Check $true ($null -eq $script:SourceNeedsRebind) 'expected full source suffix accepted'
    $script:TestCrumbs=@('内容(101)','Research','daily')
    Assert-ImaSourcePath
    Check $true ($null -eq $script:SourceNeedsRebind) 'aggregate content count is not folder identity'
    foreach ($actual in @(@('内容(100)','Renamed','daily'), @('内容(100)','Other','daily'), @('内容(100)','Research','other'))) {
        $script:SourceNeedsRebind=$null
        $script:TestCrumbs=$actual
        [void](Failure { Assert-ImaSourcePath })
        Check 'path-changed' $script:SourceNeedsRebind.reason 'renamed root, wrong parent or changed child rejected'
        Check 'Research/daily' ($script:SourceNeedsRebind.expectedPath -join '/') 'expected path survives failure'
        Check ($actual -join '/') ($script:SourceNeedsRebind.actualPath -join '/') 'actual path included for confirmation'
    }
    $script:TestCrumbs=@('内容(100)','Research','daily')
    [void](Failure { Assert-ImaSourcePath })
    Check 'path-changed' $script:SourceNeedsRebind.reason 'source mismatch remains latched even if the old path reappears'
    $script:SourceNeedsRebind=$null
    $script:TestCrumbs=@()
    [void](Failure { Assert-ImaSourcePath })
    Check 'missing' $script:SourceNeedsRebind.reason 'missing breadcrumb requires rebind'
    $script:SourceNeedsRebind=$null
    function Get-ImaSourceBreadcrumb { throw 'UIA provider unavailable' }
    [void](Failure { Assert-ImaSourcePath })
    Check 'missing' $script:SourceNeedsRebind.reason 'unreadable breadcrumb cannot continue batch'
}

& {
    Reset-Binding
    $script:NavigationClicks=0
    $script:TargetCount=0
    $pattern=[pscustomobject]@{}
    $pattern | Add-Member ScriptMethod Invoke { $script:NavigationClicks++ }
    function Get-ImaSourceBreadcrumb { return @('内容(100)') }
    function Get-ImaExactNavigationTargets { param($Root,$Name,[switch]$KnowledgeBase) for($i=0;$i -lt $script:TargetCount;$i++){ [pscustomobject]@{Pattern=$pattern} } }
    foreach($count in @(0,2)) {
        $script:TargetCount=$count
        [void](Failure { Invoke-ImaExactNavigation $null 'Research KB' @('Research KB','Research') -KnowledgeBase })
        Check $(if($count -eq 0){'missing'}else{'ambiguous'}) $script:SourceNeedsRebind.reason 'missing or ambiguous knowledge-base entries are classified'
        Check 0 $script:NavigationClicks 'ambiguous navigation never clicks first candidate'
    }
    $script:TargetCount=1
    Invoke-ImaExactNavigation $null 'Research KB' @('Research KB','Research') -KnowledgeBase
    Check 1 $script:NavigationClicks 'one exact navigation target invoked once'
}

& {
    Reset-Binding
    function New-Folder([string]$Name,[int]$Id,[string]$Kind='folder') {
        $card=[pscustomobject]@{Id=$Id}
        $card | Add-Member ScriptMethod GetRuntimeId { return @(42,$this.Id) }
        return [pscustomobject]@{Name=$Name;Kind=$Kind;Card=$card;ScrollPercent=0;ScrollStep=0}
    }
    $first=New-Folder 'Research' 1
    $duplicate=New-Folder 'Research' 2
    $decoy=New-Folder 'Research' 3 'pdf'
    $script:Page=0; $script:ScrollInputs=0; $script:Footer=$true; $script:HasScroller=$false
    $script:ScanRecords=@($first,$decoy)
    $script:CrumbChange=$false
    $script:ScanMode='duplicate'
    $scroll=[pscustomobject]@{Pattern=[pscustomobject]@{Current=[pscustomobject]@{VerticalScrollPercent=0;VerticalViewSize=50}}}
    function Get-ImaRoot { return $null }
    function Get-ImaSourceBreadcrumb { if($script:CrumbChange -and $script:Page -gt 0){return @('elsewhere')}; return @('内容(100)') }
    function Get-ImaTitleListElement { return 'mock-list' }
    function Get-ImaTitleListScroller { if($script:HasScroller){return $scroll};return $null }
    function Reset-ImaTitleListToTop { $script:Page=0; $scroll.Pattern.Current.VerticalScrollPercent=0 }
    function Start-ImaCancelableSleep {}
    function Get-ImaGeneralTitleSnapshot { return [pscustomobject]@{AllRecords=@($script:ScanRecords)} }
    function Test-ImaNamedElement { return $script:Footer }
    function Set-ImaTitleListScrollPercent {
        param($Scroller,$Percent)
        $script:Page++;$script:ScrollInputs++
        $scroll.Pattern.Current.VerticalScrollPercent=$Percent
        if($script:ScanMode -eq 'late'){
            $script:ScanRecords=@($first);$script:Footer=$true;$scroll.Pattern.Current.VerticalScrollPercent=100
        } else {$script:ScanRecords=@($first,$duplicate)}
    }
    $found=Find-ImaSourceFolder 'Research' @('Research KB','Research')
    Check 'folder' $found.Kind 'same-title article excluded from source selection'
    Check 1 $found.Card.Id 'unique folder selected after terminal proof'
    Check '内容(100)' ($found.SourceParentPath -join '/') 'physical source parent retained until folder invocation'
    $script:Footer=$false
    [void](Failure { Find-ImaSourceFolder 'Research' @('Research KB','Research') })
    Check 'missing' $script:SourceNeedsRebind.reason 'visible uniqueness without complete list is insufficient'
    Check 0 $script:ScrollInputs 'non-scrollable incomplete list fails without blind input'
    $script:HasScroller=$true;$script:Footer=$false;$script:ScanRecords=@($first)
    [void](Failure { Find-ImaSourceFolder 'Research' @('Research KB','Research') })
    Check 'ambiguous' $script:SourceNeedsRebind.reason 'duplicate on later page is rejected before opening any folder'
    Check 1 $script:ScrollInputs 'later-page duplicate requires only one scan input'
    $script:HasScroller=$false;$script:ScanRecords=@($decoy);$script:Footer=$true
    [void](Failure { Find-ImaSourceFolder 'Research' @('Research KB','Research') })
    Check 'missing' $script:SourceNeedsRebind.reason 'article-only name match does not bind source'
    $script:SourceNeedsRebind=$null;$script:ScanMode='late';$script:HasScroller=$true;$script:Footer=$false;$script:ScanRecords=@($decoy);$script:ScrollInputs=0
    $found=Find-ImaSourceFolder 'Research' @('Research KB','Research')
    Check 'Research' $found.Name 'unique source folder can first appear on a later page'
    Check 1 $script:ScrollInputs 'folder scan actively loads the later page instead of waiting for target text on first page'
}

& {
    Reset-Binding
    $script:SourcePathGuard=[pscustomobject]@{ExpectedPath=@('Research','daily')}
    $script:TestCrumbs=@('内容(100)','Research','daily')
    $script:Downloaded=@()
    $script:SkipSourceIds['existing']=$true
    $records=@('existing','one','two','three' | ForEach-Object { [pscustomobject]@{Name="$_.pdf";SourceId=$_;Key=$_;Kind='pdf';RelativeFolder=@('daily')} })
    function Get-ImaGeneralCandidates { return $records }
    function Get-ImaSourceBreadcrumb { return $script:TestCrumbs }
    function Save-ImaOriginalFile { param($Record) $script:Downloaded+=@($Record.SourceId);$script:TestCrumbs=@('内容(100)','Renamed','daily');return "downloads/$($Record.Name)" }
    function Open-ImaGeneralPath { throw 'OFFLINE TEST: same-path source changes must not be silently navigated away' }
    $result=Invoke-ImaGeneralSync $null
    Check 'one' ($script:Downloaded -join ',') 'rename after first download stops entire remaining batch'
    Check 1 $result.items.Count 'completed item retained after source change'
    Check 'one' $result.items[0].sourceId 'completed strict SourceId retained'
    Check 1 $result.errors.Count 'source change produces one error instead of per-item failures'
    Check 1 $result.skippedTitles.Count 'preexisting item remains skipped'
    Check 'path-changed' $result.sourceNeedsRebind.reason 'batch exposes structured rebind status'
    Check $false $result.canceled 'source change is distinct from user cancellation'
}

& {
    Reset-Binding
    $script:SourcePathGuard=[pscustomobject]@{ExpectedPath=@('Research','daily')}
    $script:TestCrumbs=@('内容(100)','Research','daily')
    $script:ArticleClicks=0
    $script:RenameAtSnapshot=$true
    $pattern=[pscustomobject]@{}
    $pattern | Add-Member ScriptMethod Invoke { $script:ArticleClicks++ }
    $element=[pscustomobject]@{Pattern=$pattern}
    $element | Add-Member ScriptMethod GetRuntimeId { return @(42,99) }
    $element | Add-Member ScriptMethod TryGetCurrentPattern { param($Type,$Output) $Output.Value=$this.Pattern;return $true }
    $record=[pscustomobject]@{Name='target.pdf';Kind='pdf';Key='strict-source';RelativeFolder=@('daily');ScrollStep=0;ScrollPercent=0;Element=$element;Card=$element}
    function Get-ImaSourceBreadcrumb { return $script:TestCrumbs }
    function Get-ImaRoot { return $null }
    function Get-ImaArticleWindowPresence { return [pscustomobject]@{State='Absent'} }
    function Find-ImaArticleWindow { return $null }
    function Get-ImaVisibleTitleSnapshot { if($script:RenameAtSnapshot){$script:TestCrumbs=@('内容(100)','Renamed','daily')};return [pscustomobject]@{Records=@($record)} }
    function Write-ImaArticleMatchDiagnostics {}
    function Clear-ImaArticleWindowCache {}
    function Clear-ImaBodyScrollerCache {}
    [void](Failure { Invoke-ImaArticleRecord $record })
    Check 0 $script:ArticleClicks 'fast visible match still checks source immediately before InvokePattern'
    Check 'path-changed' $script:SourceNeedsRebind.reason 'fast-path source change requests rebind'
    $script:SourceNeedsRebind=$null;$script:TestCrumbs=@('内容(100)','Research','daily');$script:RenameAtSnapshot=$false
    Invoke-ImaArticleRecord $record
    Check 1 $script:ArticleClicks 'unchanged strict source invokes exactly once'
}

& {
    Reset-Binding
    $InputPath=[IO.Path]::GetTempFileName()
    $valid=[pscustomobject]@{sourceTitle='report.pdf';sourceId='knowledge-pdf_abcdefghijklmnop';kind='pdf';relativeFolder=@('daily');scrollPercent=50;scrollStep=2}
    try {
        [IO.File]::WriteAllText($InputPath,(@{resumeRecords=@($valid)} | ConvertTo-Json -Depth 5))
        Initialize-ImaInput
        Check 1 $script:ResumeRecords.Count 'one validated recovery record loaded'
        Check $valid.sourceId $script:ResumeRecords[0].Key 'recovery key is reconstructed from strict stable SourceId'
        Check 'daily' ($script:ResumeRecords[0].RelativeFolder -join '/') 'recovery retains exact relative path'
        Check 50 $script:ResumeRecords[0].ScrollPercent 'recovery scroll percentage retained only as hint'
        $invalids=@(
            @{resumeRecords=@($valid,$valid)},
            @{resumeRecords=@(1)},
            @{resumeRecords=$null},
            @{resumeRecords=@(1..1001 | ForEach-Object {$valid})}
        )
        foreach($bad in $invalids){
            [IO.File]::WriteAllText($InputPath,($bad | ConvertTo-Json -Depth 5))
            Check $true (-not [string]::IsNullOrWhiteSpace((Failure { Initialize-ImaInput }))) 'invalid recovery collection rejected'
        }
        foreach($replacement in @(
            @{sourceId='knowledge-pdf_1234567890123456'}, @{sourceId='runtime:42.1'},
            @{kind='note'}, @{sourceTitle=''}, @{relativeFolder=@('a','b','c','d','e','f')},
            @{relativeFolder=@('')}, @{relativeFolder='daily'}, @{scrollPercent=-1},
            @{scrollPercent=101}, @{scrollPercent='50'}, @{scrollStep=1.2}, @{scrollStep=-1}
        )) {
            $bad=$valid | ConvertTo-Json -Depth 4 | ConvertFrom-Json
            foreach($name in $replacement.Keys){$bad.$name=$replacement[$name]}
            [IO.File]::WriteAllText($InputPath,(@{resumeRecords=@($bad)} | ConvertTo-Json -Depth 5))
            Check $true (-not [string]::IsNullOrWhiteSpace((Failure { Initialize-ImaInput }))) 'invalid recovery identity, path or hint rejected'
        }
        [IO.File]::WriteAllText($InputPath,'{"resumeRecords":[]}')
        Initialize-ImaInput
        Check 0 $script:ResumeRecords.Count 'empty recovery queue means normal scan'
    } finally {[IO.File]::Delete($InputPath)}
}

& {
    Reset-Binding
    $script:SourcePathGuard=[pscustomobject]@{ExpectedPath=@('Research','daily')}
    $script:TestCrumbs=@('内容(100)','Research','daily')
    $script:Downloaded=@()
    $script:CancelAfterFirst=$false
    $script:ResumeRecords=@('existing','one','two' | ForEach-Object {
        $id="knowledge-pdf_source-abcdefghijklmnop-$_"
        [pscustomobject]@{Name="$_.pdf";SourceId=$id;Key=$id;Kind='pdf';RelativeFolder=@('daily');ScrollPercent=0;ScrollStep=0}
    })
    $script:SkipSourceIds[$script:ResumeRecords[0].SourceId]=$true
    function Get-ImaGeneralCandidates { throw 'OFFLINE TEST: recovery must not rescan or introduce new candidates' }
    function Get-ImaSourceBreadcrumb { return $script:TestCrumbs }
    function Save-ImaOriginalFile {
        param($Record)
        $script:Downloaded+=@($Record.Name)
        if(-not $script:CancelAfterFirst){$script:TestCrumbs=@('内容(100)','Renamed','daily')}
        return "downloads/$($Record.Name)"
    }
    function Test-ImaCancellation { if($script:CancelAfterFirst -and $script:Downloaded.Count -gt 0){throw [OperationCanceledException]::new('cancel fixture')} }
    $result=Invoke-ImaGeneralSync $null
    Check 'one.pdf' ($script:Downloaded -join '/') 'recovery processes original order only'
    Check 'path-changed' $result.sourceNeedsRebind.reason 'recovery stops on source rename'
    Check 'one.pdf/two.pdf' (@($result.sourcePendingRecords | ForEach-Object {$_.sourceTitle}) -join '/') 'pending includes staged success until Obsidian confirms persistence'
    Check 0 $result.sourcePendingUnresumableCount 'valid recovery records are all resumable'
    Check 1 $result.skippedTitles.Count 'known-existing recovery record skipped before opening'
    $script:SourceNeedsRebind=$null;$script:TestCrumbs=@('内容(100)','Research','daily');$script:Downloaded=@();$script:CancelAfterFirst=$true
    $script:CompletedItems.Clear();$script:CompletedErrors.Clear();$script:CompletedSkippedTitles.Clear()
    $result=Invoke-ImaGeneralSync $null
    Check $true $result.canceled 'recovery honors cancellation'
    Check 1 $result.items.Count 'cancellation preserves completed download result'
    Check 'one.pdf/two.pdf' (@($result.sourcePendingRecords | ForEach-Object {$_.sourceTitle}) -join '/') 'cancellation preserves original pending order'
    Check 0 $result.errors.Count 'cancellation is not an item failure'
    $anonymous=[pscustomobject]@{Name='unknown';SourceId='';Kind='note';RelativeFolder=@();ScrollPercent=0;ScrollStep=0}
    $state=Get-ImaSourcePendingState @($anonymous,$script:ResumeRecords[1])
    Check 1 $state.UnresumableCount 'unstable identity counted explicitly rather than guessed by title'
    Check 1 $state.Records.Count 'only stable identity enters automatic recovery queue'
    Check $script:ResumeRecords[1].SourceId $state.Records[0].sourceId 'stable source identity unchanged'
}

& {
    Reset-Binding
    # Use the actual selector body with only the tree walker boundary replaced.
    $tokens=$null;$parseErrors=$null
    $ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$parseErrors)
    $definition=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-ImaExactNavigationTargets'},$true)
    $adapter=$definition.Extent.Text.Replace('[Windows.Automation.AutomationElement]$','[object]$').Replace('[Windows.Automation.TreeWalker]::RawViewWalker','$script:NavigationWalker')
    . ([scriptblock]::Create($adapter))
    function New-NavNode([int]$Id,[string]$Name,[string]$Class,[object]$Parent,[bool]$Invokable=$false) {
        $node=[pscustomobject]@{Id=$Id;Parent=$Parent;Invokable=$Invokable;Current=[pscustomobject]@{Name=$Name;ClassName=$Class;AutomationId='';IsOffscreen=$false;ControlType=[Windows.Automation.ControlType]::Group}}
        $node | Add-Member ScriptMethod GetRuntimeId {return @(42,$this.Id)}
        $node | Add-Member ScriptMethod TryGetCurrentPattern {param($Type,$Output) if($this.Invokable){$Output.Value=[pscustomobject]@{Id=$this.Id};return $true};return $false}
        return $node
    }
    $root=New-NavNode 0 '' '' $null
    $root | Add-Member NoteProperty Matches @()
    $root | Add-Member ScriptMethod FindAll {param($Scope,$Condition) return $this.Matches}
    $sidebar=New-NavNode 1 '' '_sidebar_hash expandable-sidebar-panel-sidebar' $root
    $entry=New-NavNode 2 '' '_knowledgeListItem_hash_1' $sidebar $true
    $text=New-NavNode 3 'Research KB' '' $entry
    $duplicateText=New-NavNode 4 'Research KB' '' $entry
    $header=New-NavNode 5 '' '_titleTop_hash' $root $true
    $headerText=New-NavNode 6 'Research KB' '' $header
    $document=New-NavNode 7 'Research KB' '' $root
    $document.Current.AutomationId='RootWebArea'
    $root.Matches=@($text,$duplicateText,$headerText,$document)
    $script:NavigationWalker=[pscustomobject]@{}
    $script:NavigationWalker | Add-Member ScriptMethod GetParent {param($Node) return $Node.Parent}
    $targets=@(Get-ImaExactNavigationTargets $root 'Research KB' -KnowledgeBase)
    Check 1 $targets.Count 'sidebar physical target deduplicated; document and clickable page headers excluded'
    Check 2 $targets[0].Element.Id 'selector returns exact sidebar entry, not first invokable header ancestor'
    $sidebar.Current.ClassName='_knowledgeBase_8uv3x_2 scrollbar'
    $sidebar.Current.AutomationId='knowledgeBase'
    $targets=@(Get-ImaExactNavigationTargets $root 'Research KB' -KnowledgeBase)
    Check 1 $targets.Count 'observed knowledgeBase container is accepted without matching the page header'
    Check 2 $targets[0].Element.Id 'modern container selects the same exact invokable entry'
    $entry2=New-NavNode 8 '' '_knowledgeListItem_hash_1' $sidebar $true
    $text2=New-NavNode 9 'Research KB' '' $entry2
    $root.Matches+=@($text2)
    Check 2 (@(Get-ImaExactNavigationTargets $root 'Research KB' -KnowledgeBase).Count) 'different physical same-name sidebar entries remain ambiguous'
    $button=New-NavNode 10 '知识库' 'HoverImageButton' $root $true
    $button.Current.ControlType=[Windows.Automation.ControlType]::Button
    $fake=New-NavNode 11 '知识库' '_title_hash' $root $true
    $root.Matches=@($fake,$button)
    $targets=@(Get-ImaExactNavigationTargets $root '知识库')
    Check 1 $targets.Count 'knowledge navigation limited to observed native button type'
    Check 10 $targets[0].Element.Id 'native button selected without clicking same-title page content'
}

& {
    Reset-Binding
    $bounds=[pscustomobject]@{X=0;Y=0;Width=400;Height=800;Bottom=800}
    function New-BindingCard([int]$Id,[string]$AutomationId,[string[]]$Names) {
        $texts=@($Names | ForEach-Object {[pscustomobject]@{Current=[pscustomobject]@{Name=$_;BoundingRectangle=$bounds;IsOffscreen=$false}}})
        $card=[pscustomobject]@{Id=$Id;Texts=$texts;Current=[pscustomobject]@{AutomationId=$AutomationId;BoundingRectangle=$bounds}}
        $card | Add-Member ScriptMethod GetRuntimeId {return @(42,$this.Id)}
        $card | Add-Member ScriptMethod FindAll {param($Scope,$Condition) return $this.Texts}
        return $card
    }
    $folder=New-BindingCard 1 '' @('Research','31','项','今天更新')
    $specialNote=New-BindingCard 2 'knowledge-note_abcdefghijklmnop' @('unusual existing article layout')
    $imageCard=New-BindingCard 3 'knowledge-img_cls1_abcdefghijklmnop' @('image.png','图片','9/26')
    $footer=New-BindingCard 4 '' @('没有更多内容了')
    $unknown=New-BindingCard 5 '' @('unknown nonempty layout')
    $list=[pscustomobject]@{Cards=@($folder,$specialNote,$imageCard,$footer);Current=[pscustomobject]@{BoundingRectangle=$bounds}}
    $list | Add-Member ScriptMethod FindAll {param($Scope,$Condition) return $this.Cards}
    function Test-ImaNamedElement {return $true}
    $script:FolderOnlyNavigation=$true
    $snapshot=Get-ImaGeneralTitleSnapshot $list -IncludeOffscreen
    Check 1 $snapshot.Records.Count 'folder-only navigation does not parse special article layouts or image cards'
    Check 'Research' $snapshot.Records[0].Name 'folder-only snapshot preserves strict folder title'
    Check 'folder:Research' $snapshot.Records[0].Key 'folder identity is not replaced by article title'
    $list.Cards=@($specialNote,$imageCard)
    $snapshot=Get-ImaGeneralTitleSnapshot $list -IncludeOffscreen
    Check 0 $snapshot.Records.Count 'article-only target directory contains zero folder candidates'
    Check 'source-list-articles:2' $snapshot.ReadinessSignature 'recognized articles establish target list readiness without parsing their titles'
    $list.Cards=@($footer)
    $snapshot=Get-ImaGeneralTitleSnapshot $list -IncludeOffscreen
    Check 'empty-folder' $snapshot.ReadinessSignature 'verified footer is accepted before unknown-layout rejection'
    $list.Cards=@($folder,$unknown)
    Check $true ((Failure { Get-ImaGeneralTitleSnapshot $list -IncludeOffscreen }) -like '*unknown nonempty layout*') 'unrecognized nonempty card refuses folder uniqueness with concrete diagnostic'
    $script:FolderOnlyNavigation=$false
    $list.Cards=@($specialNote)
    Check $true ((Failure { Get-ImaGeneralTitleSnapshot $list -IncludeOffscreen }) -like '*文章卡片结构变化*') 'normal article parsing still rejects unsupported layout'
}

& {
    # A new Windows PowerShell process starts without UIAutomation types. Its
    # root mock initializes the same assemblies before the real entry proceeds.
    $childPath=Join-Path ([IO.Path]::GetTempPath()) ('ima-binding-entry-' + [guid]::NewGuid().ToString('N') + '.ps1')
    $child=@'
param([string]$SourcePath)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($SourcePath,[ref]$tokens,[ref]$errors)
foreach($name in @('Open-ImaSpeedFolder','Open-ImaKnowledgeBaseRoot','Get-ImaSourceBasePath')) {
    $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
    . ([scriptblock]::Create($fn.Extent.Text))
}
$script:KnowledgeBaseName='Research KB';$script:FolderName='Research';$script:FolderOnlyNavigation=$false
$script:SourceTargetKind='folder';$script:SourceFolderPath=@()
$script:SourcePathGuard=$null;$script:SourceNeedsRebind=$null;$script:Initialized=$false
$root=[pscustomobject]@{Current=[pscustomobject]@{NativeWindowHandle=123;ProcessId=456}}
function Get-ImaRoot {
    if(-not $script:Initialized){
        if('Windows.Automation.AutomationElement' -as [type]){throw 'fixture expected a fresh process without UIA'}
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $script:Initialized=$true
    }
    return $root
}
function Wait-ImaText {param($Name,$TimeoutMilliseconds,$FailureHint)
    $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$Name)
    return $root
}
function Invoke-ImaExactNavigation {}
function Wait-ImaKnowledgeBaseSelected {return $root}
function Wait-ImaTitleListStable {return $root}
function Get-ImaSourceBreadcrumb {return @('contents')}
function Find-ImaSourceFolder {return [pscustomobject]@{Kind='folder';SourceParentPath=@('contents')}}
function Invoke-ImaArticleRecord {param($Record) if($Record.Kind -ne 'folder'){throw 'article input forbidden'}}
function Wait-ImaFolderSelected {return $root}
function Assert-ImaSourcePath {}
function Stop-ImaSourceBinding {param($Reason,$Expected,$Actual,$Message) throw $Message}
[void](Open-ImaSpeedFolder)
if(-not $script:Initialized){throw 'root was not initialized'}
Write-Output 'FRESH_ENTRY_PASS'
'@
    try {
        [IO.File]::WriteAllText($childPath,$child,(New-Object Text.UTF8Encoding($true)))
        $childOutput=(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $childPath -SourcePath $sourcePath | Out-String)
        Check 0 $LASTEXITCODE 'fresh PowerShell entry initializes UIA before constructing conditions'
        Check $true ($childOutput -like '*FRESH_ENTRY_PASS*') 'fresh-process initialization regression completes without live desktop access'
    } finally {[IO.File]::Delete($childPath)}
}

& {
    Reset-Binding
    $script:SourcePathGuard=[pscustomobject]@{ExpectedPath=@('Research','daily')}
    $script:TestCrumbs=@('内容(100)','Research','daily')
    $script:Downloaded=@()
    $script:ExistingFiles['daily/collision.pdf']=$true
    $records=@('collision','one','two' | ForEach-Object {
        $id="knowledge-pdf_source-abcdefghijklmnop-$_"
        [pscustomobject]@{Name="$_.pdf";SourceId=$id;Key=$id;Kind='pdf';RelativeFolder=@('daily');ScrollPercent=0;ScrollStep=0}
    })
    function Get-ImaGeneralCandidates {return $records}
    function Get-ImaSourceBreadcrumb {return $script:TestCrumbs}
    function Save-ImaOriginalFile {param($Record) $script:Downloaded+=@($Record.Name);$script:TestCrumbs=@('内容(100)','Renamed','daily');return "downloads/$($Record.Name)"}
    $result=Invoke-ImaGeneralSync $null
    Check 'one.pdf' ($script:Downloaded -join '/') 'filename-only collision still avoids overwriting or duplicate downloading'
    Check 1 $result.skippedTitles.Count 'filename-only collision remains an ordinary preflight skip'
    Check 'collision.pdf/one.pdf/two.pdf' (@($result.sourcePendingRecords | ForEach-Object {$_.sourceTitle}) -join '/') 'same filename without SourceId ledger is retained until verified durable identity'
    Check 'path-changed' $result.sourceNeedsRebind.reason 'filename collision does not prevent later source-change halt'
}

& {
    Reset-Binding
    $script:SourcePathGuard=[pscustomobject]@{ExpectedPath=@('Research','daily');KnowledgeBaseName='Research KB'}
    $script:ActiveKnowledgeBases=@('Research KB')
    function Get-ImaRoot {return $null}
    function Get-ImaKnowledgeBaseNames {param($Root) return $script:ActiveKnowledgeBases}
    function Get-ImaSourceBreadcrumb {return @('内容(100)','Research','daily')}
    Assert-ImaSourcePath
    Check $true ($null -eq $script:SourceNeedsRebind) 'guard confirms knowledge-base name and source path together'
    foreach($case in @(
        @{Names=@('Renamed KB');Reason='path-changed'},
        @{Names=@();Reason='missing'},
        @{Names=@('Research KB','Research KB');Reason='ambiguous'}
    )) {
        $script:SourceNeedsRebind=$null
        $script:ActiveKnowledgeBases=$case.Names
        [void](Failure {Assert-ImaSourcePath})
        Check $case.Reason $script:SourceNeedsRebind.reason 'knowledge-base rename, missing page or ambiguous pages stop the batch'
        Check 'Research KB/Research/daily' ($script:SourceNeedsRebind.expectedPath -join '/') 'knowledge-base failure reports full expected source path'
    }
    $script:SourceNeedsRebind=$null
    function Get-ImaKnowledgeBaseNames {throw 'unavailable RootWebArea'}
    [void](Failure {Assert-ImaSourcePath})
    Check 'missing' $script:SourceNeedsRebind.reason 'unreadable knowledge-base identity cannot permit an article click'
}

& {
    Reset-Binding
    $script:SourcePathGuard=[pscustomobject]@{ExpectedPath=@('Research','daily');KnowledgeBaseName='Research KB'}
    $script:ActiveKnowledgeBases=@('Research KB')
    $script:ArticleClicks=0
    $pattern=[pscustomobject]@{}
    $pattern | Add-Member ScriptMethod Invoke {$script:ArticleClicks++}
    $element=[pscustomobject]@{Pattern=$pattern}
    $element | Add-Member ScriptMethod GetRuntimeId {return @(42,99)}
    $element | Add-Member ScriptMethod TryGetCurrentPattern {param($Type,$Output) $Output.Value=$this.Pattern;return $true}
    $record=[pscustomobject]@{Name='target.pdf';Kind='pdf';Key='strict-source';RelativeFolder=@('daily');ScrollStep=0;ScrollPercent=0;Element=$element;Card=$element}
    function Get-ImaRoot {return $null}
    function Get-ImaKnowledgeBaseNames {param($Root) return $script:ActiveKnowledgeBases}
    function Get-ImaSourceBreadcrumb {return @('内容(100)','Research','daily')}
    function Get-ImaArticleWindowPresence {return [pscustomobject]@{State='Absent'}}
    function Find-ImaArticleWindow {return $null}
    function Get-ImaVisibleTitleSnapshot {$script:ActiveKnowledgeBases=@('Renamed KB');return [pscustomobject]@{Records=@($record)}}
    function Write-ImaArticleMatchDiagnostics {}
    function Clear-ImaArticleWindowCache {}
    function Clear-ImaBodyScrollerCache {}
    [void](Failure {Invoke-ImaArticleRecord $record})
    Check 0 $script:ArticleClicks 'fast-path knowledge-base rename is caught immediately before actual article invocation'
    Check 'path-changed' $script:SourceNeedsRebind.reason 'knowledge-base-only change requires explicit rebind even with unchanged folder breadcrumbs'
}

Reset-Binding
Write-Output "PASS: $($script:Checks) source binding assertions (offline, no desktop, download or vault access)"
