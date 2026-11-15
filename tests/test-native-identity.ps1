$ErrorActionPreference='Stop'
$ImaSpeedSyncSkipMain=$true
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../src/sync.ps1'),[Text.Encoding]::UTF8)
. ([scriptblock]::Create($source.Replace('[Windows.Automation.AutomationElement]$','[object]$')))
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$script:Checks=0
function Check($Expected,$Actual,[string]$Name){$script:Checks++;if($Expected -cne $Actual){throw "$Name expected <$Expected>, got <$Actual>"}}
function Fail([scriptblock]$Action){try{& $Action|Out-Null}catch{return $_.Exception};throw 'Expected failure'}
function Get-ImaRoot {throw 'OFFLINE: real UI forbidden'}
function Get-ImaWindowRoots {throw 'OFFLINE: real UI forbidden'}
function Save-ImaOriginalFile {throw 'OFFLINE: real download forbidden'}
function Write-SyncLog {}
function Write-ImaProgress {}
function Test-ImaCancellation {}
function Start-ImaCancelableSleep {}
function New-Folder($Id,$Name){[pscustomobject]@{Kind='folder';Name=$Name;FolderId=$Id;Key=('knowledge-'+$Id);SourceId='';ScrollPercent=0;ScrollStep=0;ChildCount=1;TimeLabel='今天'}}
& {
    $value=[pscustomobject]@{knowledgeBaseId='7434258591257171';folderId='folder_7511228083632516';folderPath=@([pscustomobject]@{id='folder_7511228083632516';name='old name'})}
    $parsed=ConvertTo-ImaNativeSource $value
    Check 'folder_7511228083632516' $parsed.folderPath[0].id 'path preserves stable id'
    $value.folderPath[0].name='new name';Check 'new name' (ConvertTo-ImaNativeSource $value).folderPath[0].name 'name is a mutable label'
    $value.knowledgeBaseId='ima_kb_49QPhv8V';[void](Fail {ConvertTo-ImaNativeSource $value})
    $value.knowledgeBaseId='7434258591257171';$value.folderId='folder_9999999999999999';[void](Fail {ConvertTo-ImaNativeSource $value})
    $value.folderId='folder_7511228083632516';$value.folderPath+= $value.folderPath[0];[void](Fail {ConvertTo-ImaNativeSource $value})
}
& {
    $script:walker=[pscustomobject]@{};$script:walker|Add-Member ScriptMethod GetParent {param($Node) $Node.Parent}
    function Get-ImaNativeRawWalker {return $script:walker}
    $wrapper=[pscustomobject]@{Current=[pscustomobject]@{AutomationId='knowledge-folder_7511228083632516';Name=''};Parent=$null}
    $invoke=[pscustomobject]@{Current=[pscustomobject]@{AutomationId='';Name=''};Parent=$wrapper}
    $card=[pscustomobject]@{Current=[pscustomobject]@{AutomationId='';Name='October'};Parent=$invoke}
    Check 'folder_7511228083632516' (Get-ImaNativeFolderIdFromCard $card) 'raw ancestor id discovered outside visual card'
    $card.Current.Name='October renamed';Check 'folder_7511228083632516' (Get-ImaNativeFolderIdFromCard $card) 'renaming card leaves id'
    $wrapper.Current.AutomationId='knowledge-folder_8888888888888888';Check 'folder_8888888888888888' (Get-ImaNativeFolderIdFromCard $card) 'same name recreated object differs'
    $invoke.Current.AutomationId='shareKnowledgeContentList';Check '' (Get-ImaNativeFolderIdFromCard $card) 'id lookup stops at exact list boundary'
}
& {
    function Open-ImaNativeSidebar {return [pscustomobject]@{}}
    $script:KbRows=@([pscustomobject]@{id='1111111111111111';name='renamed'},[pscustomobject]@{id='2222222222222222';name='renamed'})
    function Get-ImaNativeSidebarEntries {return $script:KbRows}
    function Open-ImaNativeSidebarEntry {param($Entry) return $Entry}
    $all=@(Get-ImaNativeKnowledgeBases);Check 2 $all.Count 'same named KBs retain distinct identities'
    Check '1111111111111111' (Get-ImaNativeKnowledgeBases '1111111111111111').id 'select old identity after rename'
    $script:KbRows=@($script:KbRows[1]);$ex=Fail {Get-ImaNativeKnowledgeBases '1111111111111111'}
    Check $true ($ex.Message -like '*未切换到同名*') 'same-name replacement never substituted'
}
& {
    $script:SourcePathGuard=$null;$script:Page=0;$script:AtEnd=$true
    $scroller=[pscustomobject]@{Pattern=[pscustomobject]@{Current=[pscustomobject]@{VerticalScrollPercent=0;VerticalViewSize=50}}}
    function Get-ImaRoot {return [pscustomobject]@{}}
    function Assert-ImaNativeKnowledgeBase {return [pscustomobject]@{id='1111111111111111';name='Library'}}
    function Get-ImaTitleListElement {return [pscustomobject]@{}}
    function Get-ImaTitleListScroller {return $scroller}
    function Reset-ImaTitleListToTop {$script:Page=0;$scroller.Pattern.Current.VerticalScrollPercent=0}
    function Set-ImaTitleListScrollPercent {param($Target,$Percent) $script:Page++;$scroller.Pattern.Current.VerticalScrollPercent=$Percent}
    function Test-ImaNativeListEnd {return $script:AtEnd}
    function Get-ImaGeneralTitleSnapshot {
        $rows=@((New-Folder 'folder_1111111111111111' 'Duplicate'))
        if($script:Page){$rows+=New-Folder 'folder_2222222222222222' 'Duplicate'}
        [pscustomobject]@{AllRecords=$rows}
    }
    $rows=@(Get-ImaNativeContents '1111111111111111');Check 2 $rows.Count 'pagination retains both same-name folders by id'
    Check 2 $script:Page 'footer before bottom is not complete'
    $script:AtEnd=$false;$ex=Fail {Get-ImaNativeContents '1111111111111111'}
    Check $false ($ex.Data.Contains('identityErrorCode')) 'unavailable KB does not assert deletion'
}
& {
    $script:KnowledgeBaseName='Library';$script:NativeCurrentPath=@();$script:Clicks=@()
    function Get-ImaNativeContents {return @((New-Folder 'folder_1111111111111111' 'Same'),(New-Folder 'folder_2222222222222222' 'Same'))}
    function Invoke-ImaArticleRecord {param($Record) $script:Clicks+= $Record.FolderId}
    function Wait-ImaFolderSelected {return [pscustomobject]@{}}
    function Assert-ImaNativeKnowledgeBase {return [pscustomobject]@{id='9999999999999999';name='Library'}}
    function Assert-ImaSourcePath {}
    [void](Enter-ImaNativeFolder '9999999999999999' 'folder_2222222222222222')
    Check 'folder_2222222222222222' ($script:Clicks -join ',') 'only matching id invoked among identical names'
    $ex=Fail {Enter-ImaNativeFolder '9999999999999999' 'folder_3333333333333333'}
    Check 'not-found' $ex.Data['identityErrorCode'] 'complete folder scan reports confirmed absence'
    Check 1 $script:Clicks.Count 'missing identity does not click same name'
}
& {
    $script:NativeSource=$null;$script:SourcePathGuard=$null;$script:GeneralFolderPath=@();$script:SkipSourceIds=@{};$script:ExistingFiles=@{};$script:Downloads=0
    $record=[pscustomobject]@{Name='fixture.pdf';Kind='pdf';Key='knowledge-pdf_fixture1234567890';SourceId='knowledge-pdf_fixture1234567890';RelativeFolder=@();RelativeFolderIds=@();ScrollPercent=0;ScrollStep=0}
    function Get-ImaGeneralCandidates {return @($record)}
    function Save-ImaOriginalFile {$script:Downloads++;return 'isolated-fixture.pdf'}
    $script:CompletedItems=New-Object Collections.Generic.List[object];$script:CompletedErrors=New-Object Collections.Generic.List[object];$script:CompletedSkippedTitles=New-Object Collections.Generic.List[string]
    $one=Invoke-ImaGeneralSync $null;Check 1 $script:Downloads 'first fixture pass extracts missing article'
    $script:SkipSourceIds[$record.SourceId]=$true
    $script:CompletedItems=New-Object Collections.Generic.List[object];$script:CompletedErrors=New-Object Collections.Generic.List[object];$script:CompletedSkippedTitles=New-Object Collections.Generic.List[string]
    $two=Invoke-ImaGeneralSync $null;Check 1 $script:Downloads 'second pass never invokes download for same id'
    Check 0 $two.items.Count 'second pass returns no new article'
    Check 1 $two.sourceFolderObservations.Count 'skipped record still supplies path identity evidence'
    Check $record.SourceId $two.sourceFolderObservations[0].sourceId 'observation uses article identity'
}
& {
    $script:SourcePathGuard=$null;$script:NativeTestBase='1111111111111111'
    function Get-ImaRoot {return [pscustomobject]@{}}
    function Get-ImaNativeKnowledgeBase {return [pscustomobject]@{id=$script:NativeTestBase;name='Empty library'}}
    function Get-ImaTitleListElement {return $null}
    function Get-ImaTitleListScroller {return $null}
    function Test-ImaNativeEmptyContent {return $true}
    Check $true ($null -ne (Wait-ImaNativeContentStable '1111111111111111' 'Empty library')) 'explicit empty state is ready without list container'
    Check 0 (@(Get-ImaNativeContents '1111111111111111').Count) 'empty library returns an actual empty catalog'
    Check $true ($null -ne (Wait-ImaNativeContentStable '1111111111111111' 'Previous name')) 'same ID stays valid when display name changes'
    $script:NativeTestBase='2222222222222222'
    [void](Fail {Wait-ImaNativeContentStable '1111111111111111' 'Empty library'})
    $script:Checks++
}
& {
    $value=[pscustomobject]@{knowledgeBaseId='001a6dab3f807619'}
    Check '001a6dab3f807619' (ConvertTo-ImaNativeSource $value).knowledgeBaseId 'personal library hex identity is supported'
    Check $true (Test-ImaNativeBreadcrumbPath @('内容') $null) 'root has no child identity path'
    Check $true (Test-ImaNativeBreadcrumbPath @('内容(1)','Same','Same') @('Same','Same')) 'parent and child can have identical labels'
    Check $false (Test-ImaNativeBreadcrumbPath @('内容','Same') @('Same','Same')) 'duplicate labels do not collapse path depth'
    Check $true (Test-ImaNativeBreadcrumbPath @('内容','A','...','D','E') @('A','B','C','D','E')) 'long breadcrumb ellipsis preserves observed prefix and suffix'
    Check $false (Test-ImaNativeBreadcrumbPath @('内容','A','...','Wrong') @('A','B','C','D','E')) 'wrong final label fails even with ellipsis'
}
& {
    $script:Reads=0;$script:Fingerprints=0
    function Get-ImaRoot {return [pscustomobject]@{}}
    function Get-ImaNativeKnowledgeBase {return [pscustomobject]@{id='2222222222222222';name='Same'}}
    function Get-ImaTitleListElement {return [pscustomobject]@{}}
    function Get-ImaGeneralTitleSnapshot {return [pscustomobject]@{Complete=$true;ReadinessSignature='unchanged-count'}}
    function Get-ImaNativeContentFingerprint {$script:Fingerprints++;if($script:Fingerprints -lt 4){return 'knowledge-folder_1111111111111111'};return 'knowledge-folder_2222222222222222'}
    [void](Wait-ImaNativeContentStable '2222222222222222' 'Same' 'knowledge-folder_1111111111111111' '1111111111111111')
    Check $true ($script:Fingerprints -ge 6) 'URL switch does not accept old nonempty body even when card count unchanged'
}
& {
    $script:IdentityReads=0
    function Get-ImaRoot {return [pscustomobject]@{}}
    function Get-ImaNativeContentFingerprint {return 'old-content'}
    function Get-ImaNativeKnowledgeBase {
        $script:IdentityReads++
        [pscustomobject]@{id=$(if($script:IdentityReads -lt 5){'1111111111111111'}else{'2222222222222222'});name='Same'}
    }
    $element=[pscustomobject]@{};$element|Add-Member ScriptMethod TryGetCurrentPattern {param($p,$r) return $false}
    $pattern=[pscustomobject]@{};$pattern|Add-Member ScriptMethod Invoke {}
    $entry=[pscustomobject]@{name='Same';element=$element;pattern=$pattern}
    $result=Open-ImaNativeSidebarEntry $entry '1111111111111111'
    Check '2222222222222222' $result.id 'same named previous page is not accepted after sidebar click'
    Check $true ($script:IdentityReads -ge 8) 'new identity must settle before returning'
}
& {
    $script:NativeLastNavigation=$null;$script:RootCalls=0;$script:CrumbClicked=0
    function Get-ImaRoot {return [pscustomobject]@{}}
    function Get-ImaNativeKnowledgeBase {return [pscustomobject]@{id='2222222222222222';name='Library'}}
    function Get-ImaSourceBreadcrumb {$script:RootCalls++;if($script:RootCalls -eq 1){return @('内容(1)','Parent')};return @('内容')}
    function Get-ImaBreadcrumbItems {return @([pscustomobject]@{Current=[pscustomobject]@{Name='内容(1)'}})}
    function Invoke-ImaNamedElement {$script:CrumbClicked++}
    function Open-ImaBreadcrumb {throw 'old name-bound breadcrumb wait must not be used'}
    function Wait-ImaNativeContentStable {return [pscustomobject]@{}}
    [void](Open-ImaNativeRoot '2222222222222222')
    Check 1 $script:CrumbClicked 'return to native root clicks observed root once without treating count as identity'
    Check 0 $script:NativeCurrentPath.Count 'return to native root clears remote child path'
}
& {
    $script:SidebarReads=0;$script:SidebarScrolls=0
    function Get-ImaRoot {return [pscustomobject]@{}}
    function Wait-ImaText {return [pscustomobject]@{}}
    function Invoke-ImaExactNavigation {}
    function Get-ImaNativeSidebarRoot {return [pscustomobject]@{}}
    function Get-ImaNativeRawDescendants {
        $script:SidebarReads++
        if($script:SidebarReads -lt 3){return @([pscustomobject]@{Current=[pscustomobject]@{ClassName='_container_15k22_1'}})}
        return @()
    }
    function Scroll-ImaNativeSidebarSentinel {$script:SidebarScrolls++}
    [void](Open-ImaNativeSidebar)
    Check 2 $script:SidebarScrolls 'automatic KB sentinel is driven until removed, not assumed complete without load-more text'
}
& {
    $script:SourcePathGuard=$null;$script:SnapshotReads=0
    function Get-ImaRoot {return [pscustomobject]@{}}
    function Assert-ImaNativeKnowledgeBase {return [pscustomobject]@{id='1111111111111111';name='Library'}}
    function Get-ImaTitleListElement {return [pscustomobject]@{}}
    function Get-ImaTitleListScroller {return $null}
    function Test-ImaNativeListEnd {return $true}
    function Get-ImaGeneralTitleSnapshot {
        $script:SnapshotReads++
        if($script:SnapshotReads -eq 1){return [pscustomobject]@{Complete=$false;AllRecords=@()}}
        return [pscustomobject]@{Complete=$true;AllRecords=@((New-Folder 'folder_1111111111111111' 'Reappeared'))}
    }
    Check 1 (@(Get-ImaNativeContents '1111111111111111').Count) 'partial card snapshot is retried before declaring a folder absent'
    Check 2 $script:SnapshotReads 'explicit footer cannot make an incomplete snapshot complete'
}
& {
    $shared='knowledge-pdf_cls1_'+('a'*32)+'_'+('b'*32)+'7434258591257171'
    $personal='knowledge-pdf_'+('a'*32)+'_'+('b'*32)+'001a6dab3f807619'
    Check $true (Test-ImaNativeContentOwner $shared '7434258591257171') 'observed shared file schema carries decimal KB owner'
    Check $true (Test-ImaNativeContentOwner $personal '001a6dab3f807619') 'observed personal file schema carries hexadecimal KB owner'
    Check $false (Test-ImaNativeContentOwner $personal '7434258591257171') 'stale personal file body is rejected after URL switches to shared KB'
}
& {
    $script:WalkOrder=@();$script:KbRows=@([pscustomobject]@{id='1111111111111111';name='Same'},[pscustomobject]@{id='2222222222222222';name='Same'},[pscustomobject]@{id='3333333333333333';name='Anchor'})
    function Open-ImaNativeSidebar {return [pscustomobject]@{}}
    function Get-ImaNativeSidebarEntries {return $script:KbRows}
    function Get-ImaNativeKnowledgeBase {return [pscustomobject]@{id='2222222222222222';name='Same'}}
    function Open-ImaNativeSidebarEntry {param($Entry,$DifferentFrom) $script:WalkOrder+= $Entry.id;return $Entry}
    $rows=@(Get-ImaNativeKnowledgeBases)
    Check '3333333333333333' $script:WalkOrder[0] 'duplicate first names are preceded by an unambiguous differently named page'
    Check '1111111111111111,2222222222222222,3333333333333333' (($rows|ForEach-Object{$_.id}) -join ',') 'verified KB picker retains original sidebar order'
}
& {
    $script:NativeSource=$null;$script:NativeIdentityInput=[pscustomobject]@{action='resolve'}
    function Get-ImaRoot {return [pscustomobject]@{Current=[pscustomobject]@{IsOffscreen=$false}}}
    function Get-ImaTitleListElement {return [pscustomobject]@{}}
    function Get-ImaBreadcrumbItems {return @([pscustomobject]@{Current=[pscustomobject]@{Name='内容'}})}
    $state=Get-ImaFolderPageState 'Child' -ExpectedPath @('Child') -ParentPath @()
    Check 'InParent' $state.Status 'empty native root path is parent, allowing bounded ID-verified retry after a no-op Invoke'
    $script:NativeIdentityInput=$null
}
& {
    $script:TwoSidebarRoots=$false
    $knowledge=[pscustomobject]@{kind='knowledge';Current=[pscustomobject]@{ClassName='_container_y4l5d_1'}}
    $chat=[pscustomobject]@{kind='chat';Current=[pscustomobject]@{ClassName='_sidebar_1o789_8 expandable-sidebar-panel-sidebar'}}
    function Get-ImaNativeRawDescendants {
        param($Root)
        if($Root.kind -eq 'root'){return @($knowledge,$chat)}
        if($Root.kind -eq 'knowledge' -or $script:TwoSidebarRoots){return @([pscustomobject]@{Current=[pscustomobject]@{ClassName='_knowledgeListHeader_5dmyg_6'}})}
        return @()
    }
    Check 'knowledge' (Get-ImaNativeSidebarRoot ([pscustomobject]@{kind='root'})).kind 'observed client knowledge container is accepted and chat sidebar excluded'
    $script:TwoSidebarRoots=$true;[void](Fail {Get-ImaNativeSidebarRoot ([pscustomobject]@{kind='root'})});$script:Checks++
}
& {
    $script:StartupProbes=0;$script:NavigationCalls=0
    function Get-ImaRoot {return [pscustomobject]@{}}
    function Wait-ImaText {return [pscustomobject]@{}}
    function Invoke-ImaExactNavigation {$script:NavigationCalls++}
    function Get-ImaNativeSidebarRoot {param($Root,[switch]$WaitIfMissing) $script:StartupProbes++;if($script:StartupProbes -lt 3){return $null};return [pscustomobject]@{}}
    function Get-ImaNativeRawDescendants {return @()}
    [void](Open-ImaNativeSidebar)
    Check 3 $script:StartupProbes 'native shell can appear before exact knowledge sidebar after cold start'
    Check 1 $script:NavigationCalls 'startup readiness retries observations, not UI navigation actions'
}
& {
    function Get-ImaNativeRawDescendants {return @()}
    Check $null (Get-ImaNativeSidebarRoot ([pscustomobject]@{}) -WaitIfMissing) 'missing startup marker remains pending within bounded caller deadline'
    [void](Fail {Get-ImaNativeSidebarRoot ([pscustomobject]@{})});$script:Checks++
}
Write-Output "PASS: $script:Checks native identity assertions (offline; no desktop, network or downloads)"