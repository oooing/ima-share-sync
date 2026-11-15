$ErrorActionPreference='Stop'
$ImaSpeedSyncSkipMain=$true
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../src/sync.ps1'),[Text.Encoding]::UTF8)
. ([scriptblock]::Create($source.Replace('[Windows.Automation.AutomationElement]$','[object]$')))
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$script:Checks=0
function Check($Expected,$Actual,[string]$Name) { $script:Checks++;if($Expected -cne $Actual){throw "$Name expected <$Expected> got <$Actual>"} }
function Failure([scriptblock]$Action) { try{& $Action|Out-Null}catch{return $_.Exception.Message};throw 'Expected failure' }
function Get-ImaRoot { throw 'OFFLINE: real desktop access forbidden' }
function Save-ImaOriginalFile { throw 'OFFLINE: downloads forbidden' }
function Write-SyncLog {}
function Test-ImaCancellation {}
function Start-ImaCancelableSleep {}
function Reset-Selection {
    $script:KnowledgeBaseName='Research KB';$script:FolderName='';$script:SourceTargetKind='knowledge-base'
    $script:SourcePathGuard=[pscustomobject]@{ExpectedPath=@();KnowledgeBaseName='Research KB';IsKnowledgeBaseRoot=$true}
    $script:SourceNeedsRebind=$null;$script:FolderOnlyNavigation=$false;$script:SourceFolderPath=@();$script:SourceCatalogPath=@()
}
Check 0 (Get-ImaCardTitleIndex @('Observed web title','网址','10/26') 'weburl') 'observed root web label is recognized'
Check 1 (Get-ImaCardTitleIndex @('Preview','Observed web title','网址','10/26') 'weburl') 'web label still requires title position after preview'
[void](Failure {Get-ImaCardTitleIndex @('Unknown title','other kind','10/26') 'weburl'})
Check 0 (Get-ImaCardTitleIndex @('Legacy web title','网页','10/26更新') 'weburl') 'legacy web label remains supported'

& {
    Reset-Selection
    $InputPath=[IO.Path]::GetTempFileName()
    try {
        foreach($operation in @('list-knowledge-bases','list-source-folders','inspect-source')) {
            [IO.File]::WriteAllText($InputPath,('{"operation":"'+$operation+'","sourceTargetKind":"knowledge-base"}'))
            Initialize-ImaInput
            Check $operation $script:Operation 'explicit read operation accepted'
            Check 'knowledge-base' $script:SourceTargetKind 'root kind parsed'
        }
        [IO.File]::WriteAllText($InputPath,'{}');Initialize-ImaInput
        Check 'folder' $script:SourceTargetKind 'legacy inputs remain folder scoped'
        [IO.File]::WriteAllText($InputPath,'{"sourceTargetKind":"invalid"}')
        Check $true ((Failure {Initialize-ImaInput}) -like '*来源范围无效*') 'unknown scope rejected'
    } finally { [IO.File]::Delete($InputPath) }
}

& {
    Reset-Selection
    function Get-ImaRoot {return $null}
    $script:ActiveKB=@('Research KB');$script:Crumbs=@('内容(18692)')
    function Get-ImaKnowledgeBaseNames {return $script:ActiveKB}
    function Get-ImaSourceBreadcrumb {return $script:Crumbs}
    Assert-ImaSourcePath @()
    Check 0 (@(Get-ImaSourceBasePath).Count) 'root base path has no empty segment'
    $script:Crumbs=@('内容(18693)');Assert-ImaSourcePath @()
    Check $null $script:SourceNeedsRebind 'content count changes do not change root identity'
    $script:Crumbs=@('内容(18693)','October','daily');Assert-ImaSourcePath @('October','daily')
    Check $null $script:SourceNeedsRebind 'root descendant path verified exactly'
    [void](Failure {Assert-ImaSourcePath @('daily')})
    Check 'path-changed' $script:SourceNeedsRebind.reason 'same suffix in another parent is not accepted'
    $script:SourceNeedsRebind=$null;$script:Crumbs=@('内容(18693)','October')
    [void](Failure {Assert-ImaSourcePath @()})
    Check 'path-changed' $script:SourceNeedsRebind.reason 'empty expected path means root, not current folder'
    $script:SourceNeedsRebind=$null;$script:Crumbs=@('内容(18693)');$script:ActiveKB=@('Other KB')
    [void](Failure {Assert-ImaSourcePath @()})
    Check 'path-changed' $script:SourceNeedsRebind.reason 'root count alone cannot establish knowledge base'
}

& {
    Reset-Selection
    $root=[pscustomobject]@{};$script:FolderClicks=0;$script:Crumbs=@('内容(100)','old-folder')
    function Get-ImaRoot {return $root}
    function Wait-ImaText {param($Name,$TimeoutMilliseconds) return $root}
    function Invoke-ImaExactNavigation {}
    function Wait-ImaKnowledgeBaseSelected {return $root}
    function Get-ImaKnowledgeBaseNames {return @('Research KB')}
    function Wait-ImaTitleListStable {param($Root) return $Root}
    function Get-ImaSourceBreadcrumb {return $script:Crumbs}
    function Open-ImaBreadcrumb {param($Name) $script:Crumbs=@($Name);return $root}
    function Find-ImaSourceFolder {throw 'Root selection must not locate a folder'}
    function Invoke-ImaArticleRecord {$script:FolderClicks++;throw 'No card may be clicked during root inspection'}
    [void](Open-ImaSpeedFolder)
    Check 0 $script:FolderClicks 'root inspection opens no card'
    Check 1 $script:Crumbs.Count 'root inspection returns from previous nested folder'
    Check $true $script:SourcePathGuard.IsKnowledgeBaseRoot 'root guard remains installed'
    Check $false $script:FolderOnlyNavigation 'navigation parsing mode restored'
}

& {
    Reset-Selection
    $root=[pscustomobject]@{};$script:AtEnd=$true
    function Get-ImaRoot {return $root}
    function Open-ImaKnowledgeBaseRoot {return $root}
    function Assert-ImaSourcePath {}
    function Get-ImaTitleListScroller {return $null}
    function Get-ImaTitleListElement {return $root}
    function Test-ImaNamedElement {return $script:AtEnd}
    function New-CatalogRecord($Id,$Name) {
        $card=[pscustomobject]@{Id=$Id};$card|Add-Member ScriptMethod GetRuntimeId {return @(42,$this.Id)}
        return [pscustomobject]@{Kind='folder';Name=$Name;Card=$card}
    }
    $script:CatalogFixtureRecords=@((New-CatalogRecord 1 'October'),(New-CatalogRecord 2 'Duplicate'),(New-CatalogRecord 3 'Duplicate'))
    function Get-ImaGeneralTitleSnapshot {return [pscustomobject]@{AllRecords=$script:CatalogFixtureRecords}}
    $catalog=Get-ImaRootFolderCatalog
    Check 'October' ($catalog.names -join '|') 'unique folder offered'
    Check 'Duplicate' ($catalog.ambiguousNames -join '|') 'same-name physical folders excluded'
    Check $true $catalog.complete 'end marker required for complete catalog'
    Check $false $script:FolderOnlyNavigation 'catalog restores navigation mode'
    $script:AtEnd=$false
    Check $true ((Failure {Get-ImaRootFolderCatalog}) -like '*未完整读取*') 'partial catalog rejected'
    Check $false $script:FolderOnlyNavigation 'failed catalog also restores mode'
}

& {
    Reset-Selection
    $script:SourceTargetKind='folder';$script:FolderName='Daily';$script:SourceFolderPath=@('October','Daily')
    Check 'October/Daily' (@(Get-ImaSourceBasePath) -join '/') 'full nested base path used'
    $root=[pscustomobject]@{Current=[pscustomobject]@{NativeWindowHandle=123;ProcessId=456}}
    $script:Crumbs=@('内容(100)');$script:Clicked=@()
    function Get-ImaRoot {return $root}
    function Open-ImaKnowledgeBaseRoot {$script:Crumbs=@('内容(100)');$script:SourcePathGuard=[pscustomobject]@{ExpectedPath=@();KnowledgeBaseName='Research KB';IsKnowledgeBaseRoot=$true};return $root}
    function Get-ImaKnowledgeBaseNames {return @('Research KB')}
    function Get-ImaSourceBreadcrumb {return $script:Crumbs}
    function Find-ImaSourceFolder {param($Name,$ExpectedPath) return [pscustomobject]@{Name=$Name;Kind='folder'}}
    function Invoke-ImaArticleRecord {param($Record) if($Record.Kind -ne 'folder'){throw 'article click forbidden'};$script:Clicked+=($script:Crumbs -join '/')+'/'+$Record.Name}
    function Wait-ImaFolderSelected {param($Name,$Record,$ExpectedPath,$ParentPath) $script:Crumbs=@('内容(100)')+@($ExpectedPath);return $root}
    [void](Open-ImaSpeedFolder)
    Check 2 $script:Clicked.Count 'exactly the two folder components opened'
    Check '内容(100)/October/Daily' ($script:Crumbs -join '/') 'selected complete nested path'
    Check $true $script:SourcePathGuard.IsKnowledgeBaseRoot 'full root-relative path guard retained'
    $script:Crumbs=@('内容(100)','September','Daily')
    [void](Failure {Assert-ImaSourcePath})
    Check 'path-changed' $script:SourceNeedsRebind.reason 'same leaf under another parent rejected'
    $script:SourceNeedsRebind=$null
    function Find-ImaSourceFolder {param($Name,$ExpectedPath) if($Name -eq 'Daily'){throw 'duplicate folder'};return [pscustomobject]@{Name=$Name;Kind='folder'}}
    $script:Clicked=@()
    [void](Failure {Open-ImaSpeedFolder})
    Check 1 $script:Clicked.Count 'ambiguous child not clicked'
}
& {
    Reset-Selection
    $InputPath=[IO.Path]::GetTempFileName()
    $script:FolderName='Daily'
    try {
        [IO.File]::WriteAllText($InputPath,'{"sourceTargetKind":"folder","sourceFolderPath":["October","Daily"],"sourceCatalogPath":["October"]}')
        Initialize-ImaInput
        Check 'October/Daily' ($script:SourceFolderPath -join '/') 'nested source input round trip'
        Check 'October' ($script:SourceCatalogPath -join '/') 'catalog parent input round trip'
        foreach($json in @('{"sourceFolderPath":["Other"]}','{"sourceFolderPath":"Daily"}','{"sourceFolderPath":["October",""]}')) {
            [IO.File]::WriteAllText($InputPath,$json)
            [void](Failure {Initialize-ImaInput});$script:Checks++
        }
    } finally {[IO.File]::Delete($InputPath)}
}

Write-Output "PASS: $($script:Checks) source-selection assertions (offline, no desktop or downloads)"
