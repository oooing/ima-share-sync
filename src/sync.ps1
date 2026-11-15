param(
    [int]$MaxItems = 7,
    [string]$KnowledgeBaseName = "",
    [string]$FolderName = "",
    [string]$TitlePattern = '^速看-\d{4}$',
    [string]$UpdateMarker = "更新时间：",
    [string]$SkipTitlesBase64 = "",
    [string]$CancelFilePath = "",
    [string]$InputPath = "",
    [string]$OutputPath = "",
    [switch]$CheckDesktop
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
$script:IncludeSubfolders = $true
$script:MaxFolders = 1
$script:MaxFolderDepth = 1
$script:GeneralSelectionMode = 'per-folder'
$script:ExistingFiles = @{}
$script:GeneralFolderPath = @()
$script:GeneralScanStarted = $null
$script:GeneralScannedFolders = 0
$script:GeneralNavigationCache = @{}
$script:DownloadDirectory = ''
$script:PreserveImaWindows = $false
$script:SyncScopeMode = 'recent'
$script:ExportAllowed = $true
$script:Operation = 'sync'
$script:SourceNeedsRebind = $null
$script:SourcePathGuard = $null
$script:ResumeRecords = @()
$script:SourceRemainingRecords = New-Object Collections.Generic.List[object]
$script:FolderOnlyNavigation = $false
$script:SourceTargetKind = 'folder'
$script:SourceFolderPath = @()
$script:SourceCatalogPath = @()
$script:NativeSource = $null
$script:NativeIdentityInput = $null
$script:NativeCurrentPath = @()
$script:SourceFolderObservations = @()

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

# Native identity uses the normal IMA desktop and system UI Automation only.
function ConvertTo-ImaNativeSource([object]$Value) {
    if(-not $Value -or $Value -isnot [pscustomobject] -or $Value.knowledgeBaseId -isnot [string] -or $Value.knowledgeBaseId -cnotmatch '^(?:\d{8,30}|[a-fA-F0-9]{16})$'){throw '客户端知识库 ID 无效'}
    $path=@();$seen=@{}
    if($Value.PSObject.Properties['folderPath']){
        if($Value.folderPath -isnot [array] -or $Value.folderPath.Count -gt 20){throw '客户端目录 ID 路径无效'}
        foreach($part in $Value.folderPath){
            if(-not $part -or $part.id -isnot [string] -or $part.id -cnotmatch '^folder_\d{8,30}$' -or $part.name -isnot [string] -or [string]::IsNullOrWhiteSpace($part.name) -or $seen.ContainsKey($part.id)){throw '客户端目录 ID 路径无效'}
            $seen[$part.id]=$true;$path+=[pscustomobject]@{id=$part.id;name=$part.name}
        }
    }
    $folderId=if($Value.PSObject.Properties['folderId']){[string]$Value.folderId}else{''}
    if($folderId -and $folderId -cnotmatch '^folder_\d{8,30}$'){throw '客户端目录 ID 无效'}
    if($path.Count -and $path[-1].id -cne $folderId){throw '客户端目录 ID 与路径不一致'}
    return [pscustomobject]@{knowledgeBaseId=[string]$Value.knowledgeBaseId;folderId=$folderId;folderPath=@($path)}
}
function Stop-ImaNativeIdentityNotFound([string]$Message){
    $error=[InvalidOperationException]::new($Message);$error.Data['identityErrorCode']='not-found';throw $error
}
function Get-ImaNativeKnowledgeBase([object]$Root){
    $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Document)
    $found=@{}
    foreach($document in @($Root.FindAll([Windows.Automation.TreeScope]::Descendants,$condition))){
        $pattern=$null
        if(-not $document.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){continue}
        $url=[string]$pattern.Current.Value
        if($url -cmatch '^chrome-extension://[a-z]+/index\.html\?[^#]*\bknowledgeBaseId=(\d{8,30}|[a-fA-F0-9]{16})(?:&|$)'){
            $id=$Matches[1];$name=[string]$document.Current.Name
            if($name){$found[$id]=[pscustomobject]@{id=$id;name=$name}}
        }
    }
    if($found.Count -ne 1){throw '客户端知识库身份暂未确认，请等待 IMA 加载完成。'}
    return @($found.Values)[0]
}
function Get-ImaNativeRawWalker { return [Windows.Automation.TreeWalker]::RawViewWalker }
function Get-ImaNativeFolderIdFromCard([object]$Card){
    $walker=Get-ImaNativeRawWalker;$node=$Card
    for($depth=0;$node -and $depth -lt 8;$depth++){
        $id=[string]$node.Current.AutomationId
        if($id -cmatch '^knowledge-(folder_\d{8,30})$'){return $Matches[1]}
        if($id -ceq 'shareKnowledgeContentList'){break};try {$node=$walker.GetParent($node)} catch {return ''}
    };return ''
}
function Get-ImaNativeSidebarEntries([object]$Root){
    $textCondition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Text)
    $walker=[Windows.Automation.TreeWalker]::RawViewWalker
    foreach($node in @($Root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition))){
        if($node.Current.ClassName -notmatch '(^|\s)_knowledgeListItem_[^\s]+'){continue}
        $pattern=$null;if(-not $node.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){continue}
        $parent=$node;$sidebar=$false
        for($i=0;$parent -and $i -lt 12;$i++){
            if($parent.Current.ClassName -like '*expandable-sidebar-panel-sidebar*' -or ($parent.Current.AutomationId -ceq 'knowledgeBase' -and $parent.Current.ClassName -match '(^|\s)_knowledgeBase_')){$sidebar=$true;break}
            $parent=$walker.GetParent($parent)
        }
        if(-not $sidebar){continue}
        $texts=@($node.FindAll([Windows.Automation.TreeScope]::Descendants,$textCondition)|Where-Object{[string]$_.Current.Name -and $_.Current.Name -cne '付费'})
        if($texts.Count -eq 1){[pscustomobject]@{name=[string]$texts[0].Current.Name;element=$node;pattern=$pattern;runtimeKey=($node.GetRuntimeId() -join '.')}}
    }
}
function Get-ImaNativeRawDescendants([object]$Root,[int]$Limit=6000) {
    $walker=Get-ImaNativeRawWalker;$queue=New-Object Collections.Generic.Queue[object];$queue.Enqueue($Root);$count=0
    while($queue.Count){
        Test-ImaCancellation
        if(++$count -gt $Limit){throw 'IMA 原始界面树未完整读取，未使用部分来源列表。'}
        $node=$queue.Dequeue();Write-Output $node
        $child=$walker.GetFirstChild($node)
        while($child){$queue.Enqueue($child);$child=$walker.GetNextSibling($child)}
    }
}
function Get-ImaNativeSidebarRoot([object]$Root,[switch]$WaitIfMissing) {
    $candidates=@()
    foreach($node in @(Get-ImaNativeRawDescendants $Root)){
        if($node.Current.ClassName -notlike '*expandable-sidebar-panel-sidebar*' -and $node.Current.ClassName -notmatch '(^|\s)_container_y4l5d_1(?:\s|$)'){continue}
        $hasKnowledgeHeader=@(Get-ImaNativeRawDescendants $node|Where-Object{$_.Current.ClassName -match '(^|\s)_knowledgeListHeader_'}).Count -gt 0
        if($hasKnowledgeHeader){$candidates+=$node}
    }
    if($candidates.Count -eq 0 -and $WaitIfMissing){return $null}
    if($candidates.Count -ne 1){throw '知识库侧栏区域尚未唯一确认。'};return $candidates[0]
}
function Invoke-ImaNativeSidebarControl([object]$Node) {
    $pattern=$null
    if($Node.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){$pattern.Invoke();return}
    $candidates=@($Node.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)|Where-Object{$p=$null;$_.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$p)})
    if($candidates.Count -ne 1){throw '知识库侧栏展开操作无法唯一确认。'}
    [void]$candidates[0].TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern);$pattern.Invoke()
}
function Scroll-ImaNativeSidebarSentinel([object]$Node,[object]$Sidebar) {
    $pattern=$null
    if($Node.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern,[ref]$pattern)){$pattern.ScrollIntoView();return}
    $walker=Get-ImaNativeRawWalker;$candidate=$Node
    for($depth=0;$candidate -and $depth -lt 20;$depth++){
        if($candidate.TryGetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern,[ref]$pattern) -and $pattern.Current.VerticallyScrollable){$pattern.SetScrollPercent(-1,100);return}
        if([Windows.Automation.Automation]::Compare($candidate,$Sidebar)){break};$candidate=$walker.GetParent($candidate)
    };throw '知识库侧栏分页尚未完成且无法安全滚动，请展开侧栏后重试。'
}
function Open-ImaNativeSidebar {
    $root=Get-ImaRoot;$root=Wait-ImaText '知识库';Invoke-ImaExactNavigation $root '知识库' @('知识库');Start-ImaCancelableSleep 250
    $deadline=[DateTime]::UtcNow.AddSeconds(90)
    while([DateTime]::UtcNow -lt $deadline){
        Test-ImaCancellation;$root=Get-ImaRoot
        try{$sidebar=Get-ImaNativeSidebarRoot $root -WaitIfMissing}
        catch [Windows.Automation.ElementNotAvailableException]{Start-ImaCancelableSleep 250;continue}
        if(-not $sidebar){Start-ImaCancelableSleep 250;continue}
        $nodes=@(Get-ImaNativeRawDescendants $sidebar)
        $collapsed=@($nodes|Where-Object{$_.Current.ClassName -match '(^|\s)_arrayIcon_[^\s]+.*_collapsed_'})
        $manual=@($nodes|Where-Object{$_.Current.ClassName -match '(^|\s)_loadMore_[^\s]+'})
        # N6/Hoe only mounts this Ut container while its KB group is not at end.
        # A hidden 1px sentinel can be absent from the control tree; use RawView.
        $automatic=@($nodes|Where-Object{$_.Current.ClassName -match '(^|\s)_container_15k22_1(?:\s|$)'})
        $loading=@($nodes|Where-Object{$_.Current.ClassName -match '(^|\s)_skeleton(?:Icon|Title)_5dmyg_'})
        if($collapsed.Count){Invoke-ImaNativeSidebarControl $collapsed[0]}
        elseif($manual.Count){Invoke-ImaNativeSidebarControl $manual[0]}
        elseif($automatic.Count){Scroll-ImaNativeSidebarSentinel $automatic[0] $sidebar}
        elseif(-not $loading.Count){return $root}
        Start-ImaCancelableSleep 250
    };throw '知识库侧栏分页尚未完整加载，未使用部分来源列表。'
}
function Test-ImaNativeEmptyContent([object]$Root) {
    $area=$Root.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,'knowledgeBaseMainArea')))
    if(-not $area){$area=$Root}
    foreach($label in @('文件夹什么也没有','知识库什么也没有','暂无内容，点击右上角')) {
        $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$label)
        $matches=@($area.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)|Where-Object{-not $_.Current.IsOffscreen})
        if($matches.Count -eq 1){return $true}
    };return $false
}
function Get-ImaNativeContentFingerprint([object]$Root) {
    $list=Get-ImaTitleListElement $Root
    if(-not $list){if(Test-ImaNativeEmptyContent $Root){return 'empty'};return ''}
    $ids=@(Get-ImaNativeRawDescendants $list|ForEach-Object{[string]$_.Current.AutomationId}|Where-Object{$_ -cmatch '^knowledge-[a-z]+_[A-Za-z0-9_-]+$'}|Sort-Object -Unique)
    if($ids.Count){return ($ids -join '|')}
    if(Test-ImaNativeEmptyContent $Root){return 'empty'};return ''
}
function Test-ImaNativeContentOwner([string]$Fingerprint,[string]$KnowledgeBaseId) {
    foreach($id in $Fingerprint.Split('|')) {
        # Verified IMA original-file wrapper schema embeds the owning native KB.
        # Unrecognised schemas are not guessed; folder ownership comes from the
        # exact parent navigation chain and the changed content fingerprint.
        if($id -cmatch '^knowledge-(?:pdf|word|img|file|image|audio|video)_(?:cls1_)?[a-f0-9]{32}_[a-f0-9]{32}([a-f0-9]{16})$' -and $Matches[1] -cne $KnowledgeBaseId){return $false}
    };return $true
}
function Wait-ImaNativeContentStable([string]$KnowledgeBaseId,[string]$Name='',[string]$PreviousFingerprint='',[string]$PreviousKnowledgeBaseId='') {
    $deadline=[DateTime]::UtcNow.AddSeconds(12);$last='';$stable=0;$reason='来源内容尚未就绪'
    do {
        Test-ImaCancellation
        $root=Get-ImaRoot;$base=Get-ImaNativeKnowledgeBase $root;$actual=$base.id+" / "+$base.name
        if($base.id -cne $KnowledgeBaseId){throw "知识库身份在加载期间变化，未使用旧列表。期望=$KnowledgeBaseId / $Name；实际=$actual"}
        $list=Get-ImaTitleListElement $root;$signature=''
        if($list){
            $snapshot=Get-ImaGeneralTitleSnapshot $list -IncludeOffscreen
            $signature=if($snapshot.PSObject.Properties['Complete'] -and -not $snapshot.Complete){''}else{[string]$snapshot.ReadinessSignature}
            if(-not $signature -and (-not $snapshot.PSObject.Properties['Complete'] -or $snapshot.Complete) -and (Test-ImaNativeListEnd $list)){$signature='empty'}
        }elseif(Test-ImaNativeEmptyContent $root){$signature='empty'}
        $fingerprint=Get-ImaNativeContentFingerprint $root
        if(-not (Test-ImaNativeContentOwner $fingerprint $KnowledgeBaseId)){$signature=''}
        if($PreviousKnowledgeBaseId -and $PreviousKnowledgeBaseId -cne $KnowledgeBaseId -and $PreviousFingerprint -and $PreviousFingerprint -cne 'empty' -and $fingerprint -ceq $PreviousFingerprint){$signature=''}
        if($signature -and $last -ceq $signature){$stable++}else{$stable=0};$last=$signature
        if($stable -ge 2){return $root}
        Start-ImaCancelableSleep 200
    }while([DateTime]::UtcNow -lt $deadline)
    throw $reason
}
function Open-ImaNativeSidebarEntry([object]$Entry,[string]$DifferentFrom=''){
    $scroll=$null;if($Entry.element.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern,[ref]$scroll)){$scroll.ScrollIntoView()}
    $beforeId='';$beforeFingerprint=''
    try {$beforeRoot=Get-ImaRoot;$beforeId=(Get-ImaNativeKnowledgeBase $beforeRoot).id;$beforeFingerprint=Get-ImaNativeContentFingerprint $beforeRoot}catch [OperationCanceledException]{throw}catch{}
    Test-ImaCancellation;$Entry.pattern.Invoke()
    $deadline=[DateTime]::UtcNow.AddSeconds(12);$previous='';$stable=0;$lastReason='尚未取得文档身份';$actual='' 
    do{
        Start-ImaCancelableSleep 200
        try{
            $root=Get-ImaRoot;$base=Get-ImaNativeKnowledgeBase $root;$actual=$base.id+" / "+$base.name
            if($base.name -ceq $Entry.name -and (-not $DifferentFrom -or $base.id -cne $DifferentFrom)){
                if($previous -ceq $base.id){$stable++}else{$stable=0};$previous=$base.id
                if($stable -ge 2){
                    # KB enumeration verifies the sidebar-to-document identity only; directory access waits for content separately.
                    $confirmed=Get-ImaNativeKnowledgeBase (Get-ImaRoot)
                    if($confirmed.id -ceq $base.id -and $confirmed.name -ceq $Entry.name){$script:NativeLastNavigation=[pscustomobject]@{id=$confirmed.id;previousId=$beforeId;previousFingerprint=$beforeFingerprint};return $confirmed}
                }
            }
        }catch [OperationCanceledException]{throw}catch{$lastReason=$_.Exception.Message;Write-SyncLog "客户端知识库等待：期望=$($Entry.name)，实际=$actual，原因=$lastReason"}
    }while([DateTime]::UtcNow -lt $deadline)
    throw "知识库页面尚未完成切换，未读取来源目录。期望=$($Entry.name)；实际=$actual；原因=$lastReason"
}
function Get-ImaNativeKnowledgeBases([string]$SelectId=''){
    $root=Open-ImaNativeSidebar;$entries=@(Get-ImaNativeSidebarEntries $root)
    if(-not $entries.Count){throw '没有找到可读取的知识库，请在 IMA 登录并打开知识库。'}
    $result=@{};$seen=@{};$previousId='';$indices=@(0..($entries.Count-1))
    # Start from a differently named entry when the current page could be either
    # of two identically named libraries. Every subsequent click must change ID.
    # Keep presentation in the original sidebar order after the verified walk.
    $current=$null;try{$current=Get-ImaNativeKnowledgeBase $root}catch [OperationCanceledException]{throw}catch{}
    if($current -and $entries[0].name -ceq $current.name -and @($entries|Where-Object{$_.name -ceq $current.name}).Count -gt 1){
        $anchor=@($indices|Where-Object{$entries[$_].name -cne $current.name}|Select-Object -First 1)
        if($anchor.Count){$indices=@($anchor[0])+@($indices|Where-Object{$_ -ne $anchor[0]})}
    }
    foreach($index in $indices){
        $entry=$entries[$index]
        Test-ImaCancellation;$base=Open-ImaNativeSidebarEntry $entry $previousId;$previousId=$base.id
        if($seen.ContainsKey($base.id)){throw '知识库列表在读取期间发生变化，请刷新后重试。'}
        $seen[$base.id]=$true;$result[$index]=$base
        if($SelectId -and $base.id -ceq $SelectId){return $base}
    }
    # A sidebar may omit unexpanded or not-yet-loaded sections. Absence here is
    # unavailable, never a confirmed deletion or migration authorization.
    if($SelectId){throw '原知识库 ID 当前不可用，未切换到同名知识库。'}
    return @(0..($entries.Count-1)|ForEach-Object{$result[$_]})
}
function Test-ImaNativeBreadcrumbPath([string[]]$Actual,[string[]]$Expected) {
    if($null -eq $Actual){$Actual=@()};if($null -eq $Expected){$Expected=@()}
    if(-not $Actual.Count -or $Actual[0] -notmatch '^内容(?:[（(]\d+[）)])?$'){return $false}
    $visible=@($Actual|Select-Object -Skip 1)
    $ellipsis=@(0..([Math]::Max(0,$visible.Count-1))|Where-Object{$visible.Count -gt $_ -and $visible[$_] -cmatch '^(?:\.\.\.|…|⋯)$'})
    if(-not $ellipsis.Count){return ($visible.Count -eq $Expected.Count -and ($visible -join "`n") -ceq ($Expected -join "`n"))}
    if($ellipsis.Count -ne 1 -or $visible.Count -gt $Expected.Count){return $false}
    $split=$ellipsis[0];$tail=$visible.Count-$split-1
    for($i=0;$i -lt $split;$i++){if($visible[$i] -cne $Expected[$i]){return $false}}
    for($i=0;$i -lt $tail;$i++){if($visible[$split+1+$i] -cne $Expected[$Expected.Count-$tail+$i]){return $false}}
    return $true
}
function Assert-ImaNativeKnowledgeBase([string]$ExpectedId){
    $base=Get-ImaNativeKnowledgeBase (Get-ImaRoot)
    if($base.id -cne $ExpectedId){throw '知识库身份已变化，未继续点击或读取。'};return $base
}
function Open-ImaNativeRoot([string]$KnowledgeBaseId){
        $script:SourcePathGuard=$null;$base=$null
    try {$current=Get-ImaNativeKnowledgeBase (Get-ImaRoot);if($current.id -ceq $KnowledgeBaseId){$base=$current}}catch [OperationCanceledException]{throw}catch{}
    if(-not $base){$base=Get-ImaNativeKnowledgeBases $KnowledgeBaseId}
    $script:KnowledgeBaseName=$base.name
    $root=Get-ImaRoot;$crumbs=@(Get-ImaSourceBreadcrumb)
    if($crumbs.Count -gt 1){$rootCrumb=@(Get-ImaBreadcrumbItems $root)[0];Invoke-ImaNamedElement $rootCrumb $crumbs[0]}
        $navigation=Get-Variable -Name NativeLastNavigation -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    if($navigation -and $navigation.id -ceq $KnowledgeBaseId){$root=Wait-ImaNativeContentStable $KnowledgeBaseId $base.name $navigation.previousFingerprint $navigation.previousId}
    else{$root=Wait-ImaNativeContentStable $KnowledgeBaseId $base.name}
    [void](Assert-ImaNativeKnowledgeBase $KnowledgeBaseId);$crumbs=@(Get-ImaSourceBreadcrumb)
    if($crumbs.Count -ne 1 -or $crumbs[0] -notmatch '^内容(?:[（(]\d+[）)])?$'){throw '知识库根目录尚未确认，未读取来源。'}
    $script:NativeCurrentPath=@();$script:SourcePathGuard=[pscustomobject]@{ExpectedPath=@();KnowledgeBaseName=$base.name;KnowledgeBaseId=$base.id;IsKnowledgeBaseRoot=$true};return $root
}
function Test-ImaNativeListEnd([object]$List){
    foreach($label in @('没有更多内容了','文件夹什么也没有','知识库什么也没有','暂无内容，点击右上角新增')){if(Test-ImaNamedElement $List $label){return $true}};return $false
}
function Get-ImaNativeContents([string]$KnowledgeBaseId){
    [void](Assert-ImaNativeKnowledgeBase $KnowledgeBaseId);$root=Get-ImaRoot;$scroller=Get-ImaTitleListScroller $root
    if($scroller){Reset-ImaTitleListToTop $scroller;Start-ImaCancelableSleep 150}
    $records=@{};$order=New-Object Collections.Generic.List[string];$deadline=[DateTime]::UtcNow.AddSeconds(45);$last='';$stalled=0
    for($page=0;$page -lt 180 -and [DateTime]::UtcNow -lt $deadline;$page++){
        Test-ImaCancellation;[void](Assert-ImaNativeKnowledgeBase $KnowledgeBaseId);if($script:SourcePathGuard){Assert-ImaSourcePath}
        $root=Get-ImaRoot;$list=Get-ImaTitleListElement $root
        if(-not $list){if(Test-ImaNativeEmptyContent $root){return @()};Start-ImaCancelableSleep 150;continue}
        $snapshot=Get-ImaGeneralTitleSnapshot $list -IncludeOffscreen
        if($snapshot.PSObject.Properties['Complete'] -and -not $snapshot.Complete){Start-ImaCancelableSleep 150;continue}
        $scroller=Get-ImaTitleListScroller $root
        $percent=if($scroller){[double]$scroller.Pattern.Current.VerticalScrollPercent}else{0.0};$view=if($scroller){[double]$scroller.Pattern.Current.VerticalViewSize}else{100.0}
        foreach($record in @($snapshot.AllRecords)){
            if($record.Kind -eq 'folder' -and (-not $record.PSObject.Properties['FolderId'] -or -not $record.FolderId)){throw '目录稳定 ID 未读取到，未按名称选择。'}
            if(-not $records.ContainsKey($record.Key)){$order.Add($record.Key)}
            $record.ScrollPercent=$percent;$record.ScrollStep=$page;$records[$record.Key]=$record
        }
        $atEnd=(-not $scroller -or $view -ge 99.9 -or $percent -ge 99.9)
        if($atEnd -and (Test-ImaNativeListEnd $list)){return @($order|ForEach-Object{$records[$_]})}
        $progress=($order -join '|')+"@$percent/$view"
        if($progress -ceq $last){$stalled++}else{$stalled=0};$last=$progress;if($stalled -ge 8){break}
        if($scroller -and $view -gt 0 -and $view -lt 100 -and $percent -ge 0){
            if($atEnd){Set-ImaTitleListScrollPercent $scroller ([Math]::Max(0,$percent-5));Start-ImaCancelableSleep 150}
            Set-ImaTitleListScrollPercent $scroller ([Math]::Min(100,$percent+[Math]::Max(1,75*$view/(100-$view))))
        };Start-ImaCancelableSleep 250
    };throw '目录列表尚未完整加载，原配置与记录保持不变。'
}
function Enter-ImaNativeFolder([string]$KnowledgeBaseId,[string]$FolderId){
    $records=@(Get-ImaNativeContents $KnowledgeBaseId);$matches=@($records|Where-Object{$_.Kind -eq 'folder' -and $_.FolderId -ceq $FolderId})
    if($matches.Count -eq 0){Stop-ImaNativeIdentityNotFound '原目录 ID 当前不可用，未选择同名目录。'}
    if($matches.Count -ne 1){throw '目录身份重复，未点击。'}
    $record=$matches[0];$parent=@($script:NativeCurrentPath);Invoke-ImaArticleRecord $record
    $names=@($parent|ForEach-Object{$_.name})+@($record.Name)
    $root=Wait-ImaFolderSelected $record.Name $record -ExpectedPath $names -ParentPath @($parent|ForEach-Object{$_.name})
    [void](Assert-ImaNativeKnowledgeBase $KnowledgeBaseId)
    $script:NativeCurrentPath=@($parent)+@([pscustomobject]@{id=$FolderId;name=$record.Name})
    $script:SourcePathGuard=[pscustomobject]@{ExpectedPath=$names;KnowledgeBaseName=$script:KnowledgeBaseName;KnowledgeBaseId=$KnowledgeBaseId;IsKnowledgeBaseRoot=$true};Assert-ImaSourcePath;return $root
}
function Open-ImaNativePath([string]$KnowledgeBaseId,[object[]]$Path){
    $root=Open-ImaNativeRoot $KnowledgeBaseId;foreach($part in @($Path)){$root=Enter-ImaNativeFolder $KnowledgeBaseId ([string]$part.id)};return $root
}
function Resolve-ImaNativeChoice([object]$Source){
    $source=ConvertTo-ImaNativeSource $Source;[void](Open-ImaNativeRoot $source.knowledgeBaseId)
    if(-not $source.folderId){return [pscustomobject]@{knowledgeBase=(Get-ImaNativeKnowledgeBase (Get-ImaRoot));includeSubfolders=$true}}
    if($source.folderPath.Count){foreach($part in $source.folderPath){[void](Enter-ImaNativeFolder $source.knowledgeBaseId $part.id)}}
    else{
        $queue=New-Object Collections.Generic.Queue[object];$queue.Enqueue(@());$seen=@{};$found=$false
        while($queue.Count -gt 0){
            Test-ImaCancellation;if($seen.Count -ge 500){throw '目录身份搜索超过 500 个目录，请选择更具体的来源。'}
            $path=@($queue.Dequeue());[void](Open-ImaNativePath $source.knowledgeBaseId $path)
            foreach($record in @(Get-ImaNativeContents $source.knowledgeBaseId|Where-Object Kind -eq 'folder')){
                if($seen.ContainsKey($record.FolderId)){throw '目录身份出现重复父级，未自动绑定。'};$seen[$record.FolderId]=$true
                $next=@($path)+@([pscustomobject]@{id=$record.FolderId;name=$record.Name})
                if($record.FolderId -ceq $source.folderId){[void](Enter-ImaNativeFolder $source.knowledgeBaseId $record.FolderId);$found=$true;break};$queue.Enqueue($next)
            };if($found){break}
        };if(-not $found){Stop-ImaNativeIdentityNotFound '原目录 ID 不存在或无权访问，未选择同名新目录。'}
    }
    $path=@($script:NativeCurrentPath);if(-not $path.Count -or $path[-1].id -cne $source.folderId){throw '目录身份路径无法确认。'}
    return [pscustomobject]@{knowledgeBase=(Get-ImaNativeKnowledgeBase (Get-ImaRoot));folder=[pscustomobject]@{id=$path[-1].id;name=$path[-1].name;path=$path};includeSubfolders=$true}
}
function Invoke-ImaNativeIdentity {
    $script:ContentMode='general'
    $input=$script:NativeIdentityInput;$action=[string]$input.action
    if($action -eq 'list-knowledge-bases'){$result=@(Get-ImaNativeKnowledgeBases)}
    else{
        $source=ConvertTo-ImaNativeSource $input;$choice=Resolve-ImaNativeChoice $source
        switch($action){
            'resolve'{$result=$choice}
            'list-folders'{
                $path=@(if($choice.PSObject.Properties['folder']){$choice.folder.path})
                $result=@(Get-ImaNativeContents $source.knowledgeBaseId|Where-Object Kind -eq 'folder'|ForEach-Object{[pscustomobject]@{id=$_.FolderId;name=$_.Name;path=@($path)+@([pscustomobject]@{id=$_.FolderId;name=$_.Name})}})
            }
            'match-records'{
                $wanted=@{};foreach($id in @($input.sourceIds)){$wanted[[string]$id]=$true};$found=@{};$queue=New-Object Collections.Generic.Queue[object]
                $initial=@(if($choice.PSObject.Properties['folder']){$choice.folder.path});$queue.Enqueue($initial);$visited=0
                while($queue.Count -and $found.Count -lt 20){
                    if(++$visited -gt 500){throw '旧记录核对达到目录上限，未关联来源。'}
                    $path=@($queue.Dequeue());[void](Open-ImaNativePath $source.knowledgeBaseId $path)
                    foreach($record in @(Get-ImaNativeContents $source.knowledgeBaseId)){
                        if($record.SourceId -and $wanted.ContainsKey($record.SourceId)){$found[$record.SourceId]=$true}
                        if($input.includeSubfolders -and $record.Kind -eq 'folder'){$queue.Enqueue(@($path)+@([pscustomobject]@{id=$record.FolderId;name=$record.Name}))}
                    }
                };$result=$found.Count
            }
        }
    };return [pscustomobject]@{busy=$false;canceled=$false;items=@();errors=@();skippedTitles=@();identityResult=$result}
}
function Open-ImaNativeBoundSource {
    $choice=Resolve-ImaNativeChoice $script:NativeSource;$script:KnowledgeBaseName=$choice.knowledgeBase.name
    $path=@(if($choice.PSObject.Properties['folder']){$choice.folder.path});$script:NativeSource.folderPath=$path
    $script:SourceFolderPath=@($path|ForEach-Object{$_.name});$script:FolderName=if($path.Count){$path[-1].name}else{''}
    $script:SourceTargetKind=if($path.Count){'folder'}else{'knowledge-base'};$script:GeneralFolderPath=@();return Get-ImaRoot
}
function Open-ImaNativeGeneralPath([string[]]$Parts,[string[]]$FolderIds){
    if($null -eq $Parts){$Parts=@()};if($null -eq $FolderIds){$FolderIds=@()}
    if($Parts.Count -ne $FolderIds.Count){throw '子目录缺少稳定 ID，未按名称或位置猜测。'}
    $desired=@($script:NativeSource.folderPath | ForEach-Object {$_.id})+@($FolderIds)
    if((@($script:NativeCurrentPath|ForEach-Object{$_.id}) -join '/') -ceq ($desired -join '/')) {
        [void](Assert-ImaNativeKnowledgeBase $script:NativeSource.knowledgeBaseId)
        if($script:SourcePathGuard){Assert-ImaSourcePath;$script:GeneralFolderPath=@($script:NativeCurrentPath|Select-Object -Skip $script:NativeSource.folderPath.Count|ForEach-Object{$_.name});return Get-ImaRoot}
    }
    [void](Open-ImaNativeBoundSource)
    foreach($id in $FolderIds){[void](Enter-ImaNativeFolder $script:NativeSource.knowledgeBaseId $id)}
    $script:GeneralFolderPath=@($script:NativeCurrentPath|Select-Object -Skip $script:NativeSource.folderPath.Count|ForEach-Object{$_.name});return Get-ImaRoot
}

function Initialize-ImaInput {
    $script:SkipTitles = @{}
    $script:GeneralSelectionMode = 'per-folder'
    $script:Operation = 'sync'
    $script:SourceTargetKind = 'folder'
$script:SourceFolderPath = @()
$script:SourceCatalogPath = @()
    $script:ResumeRecords = @()
    $script:NativeSource=$null;$script:NativeIdentityInput=$null
    if (-not [string]::IsNullOrWhiteSpace($InputPath)) {
        if (-not [IO.File]::Exists($InputPath)) {
            throw "同步输入文件不存在：$InputPath"
        }
        try {
            $inputJson = [IO.File]::ReadAllText($InputPath, (New-Object Text.UTF8Encoding($false)))
            $inputData = $inputJson | ConvertFrom-Json
            if ($inputData.PSObject.Properties['operation']) {
                if ($inputData.operation -isnot [string] -or $inputData.operation -cnotin @('sync', 'inspect-source', 'list-knowledge-bases', 'list-source-folders', 'native-identity')) {
                    throw '来源操作无效'
                }
                $script:Operation = $inputData.operation
            }
            if ($inputData.PSObject.Properties['nativeSource']) { $script:NativeSource=ConvertTo-ImaNativeSource $inputData.nativeSource }
            if ($script:Operation -eq 'native-identity') {
                if (-not $inputData.PSObject.Properties['nativeIdentity'] -or -not $inputData.nativeIdentity -or $inputData.nativeIdentity.action -cnotin @('list-knowledge-bases','list-folders','resolve','match-records')) { throw '客户端身份操作无效' }
                $script:NativeIdentityInput=$inputData.nativeIdentity
                if ($script:NativeIdentityInput.action -ne 'list-knowledge-bases') { [void](ConvertTo-ImaNativeSource $script:NativeIdentityInput) }
                if ($script:NativeIdentityInput.action -eq 'match-records') {
                    if ($script:NativeIdentityInput.sourceIds -isnot [array] -or $script:NativeIdentityInput.sourceIds.Count -gt 20000) { throw '旧来源记录无效' }
                    foreach($id in $script:NativeIdentityInput.sourceIds){if($id -isnot [string]){throw '旧来源记录无效'}}
                    if (-not $script:NativeIdentityInput.PSObject.Properties['includeSubfolders']) {$script:NativeIdentityInput|Add-Member NoteProperty includeSubfolders $true}
                }
            }
            if ($inputData.PSObject.Properties['sourceTargetKind']) {
                if ($inputData.sourceTargetKind -isnot [string] -or $inputData.sourceTargetKind -cnotin @('folder','knowledge-base')) { throw '来源范围无效' }
                $script:SourceTargetKind = $inputData.sourceTargetKind
            }
            foreach ($pathField in @('sourceFolderPath','sourceCatalogPath')) {
                if ($inputData.PSObject.Properties[$pathField]) {
                    $parts = $inputData.$pathField
                    if ($parts -isnot [array] -or $parts.Count -gt $(if($script:NativeSource){20}else{5})) { throw '来源目录路径无效' }
                    foreach ($part in $parts) { if ($part -isnot [string] -or [string]::IsNullOrWhiteSpace($part)) { throw '来源目录路径无效' } }
                    if ($pathField -eq 'sourceFolderPath') {
                        if (($script:SourceTargetKind -eq 'folder' -and ($parts.Count -eq 0 -or $parts[-1] -cne $script:FolderName)) -or
                            ($script:SourceTargetKind -eq 'knowledge-base' -and $parts.Count -ne 0)) { throw '来源目录路径与文件夹不一致' }
                        $script:SourceFolderPath = @($parts)
                    } else { $script:SourceCatalogPath = @($parts) }
                }
            }
            if ($inputData.PSObject.Properties['resumeRecords']) {
                if ($inputData.resumeRecords -isnot [array] -or $inputData.resumeRecords.Count -gt 1000) {
                    throw '待恢复记录必须为不超过 1000 项的数组'
                }
                $resume = New-Object Collections.Generic.List[object]
                $seenResumeIds = New-Object Collections.Generic.HashSet[string]([StringComparer]::Ordinal)
                foreach ($record in @($inputData.resumeRecords)) {
                    if (-not $record -or $record -isnot [pscustomobject]) { throw '待恢复记录格式无效' }
                    foreach ($field in @('sourceTitle','sourceId','kind','relativeFolder','scrollPercent','scrollStep')) {
                        if (-not $record.PSObject.Properties[$field]) { throw "待恢复记录缺少字段：$field" }
                    }
                    if ($record.sourceTitle -isnot [string] -or [string]::IsNullOrWhiteSpace($record.sourceTitle) -or $record.sourceTitle.Length -gt 4096) {
                        throw '待恢复记录标题无效'
                    }
                    if ($record.sourceId -isnot [string] -or $record.kind -isnot [string]) { throw '待恢复记录来源身份无效' }
                    $identity = [regex]::Match($record.sourceId, '^knowledge-(note|weburl|pdf|file|image|audio|video)_([A-Za-z0-9_-]{16,})$')
                    if (-not $identity.Success -or $identity.Groups[2].Value -match '^\d+$' -or $identity.Groups[1].Value -cne $record.kind) {
                        throw '待恢复记录必须包含与类型一致的稳定来源 ID'
                    }
                    if (-not $seenResumeIds.Add($record.sourceId)) { throw '待恢复记录包含重复来源 ID' }
                    if ($record.relativeFolder -isnot [array] -or $record.relativeFolder.Count -gt 5) { throw '待恢复记录目录层级无效' }
                    foreach ($part in @($record.relativeFolder)) {
                        if ($part -isnot [string] -or [string]::IsNullOrWhiteSpace($part) -or $part.Length -gt 512) { throw '待恢复记录目录名称无效' }
                    }
                    if (($record.scrollPercent -isnot [int] -and $record.scrollPercent -isnot [long] -and $record.scrollPercent -isnot [double] -and $record.scrollPercent -isnot [decimal]) -or
                        [double]::IsNaN([double]$record.scrollPercent) -or [double]::IsInfinity([double]$record.scrollPercent) -or $record.scrollPercent -lt 0 -or $record.scrollPercent -gt 100) {
                        throw '待恢复记录滚动位置无效'
                    }
                    if (($record.scrollStep -isnot [int] -and $record.scrollStep -isnot [long]) -or $record.scrollStep -lt 0 -or $record.scrollStep -gt 10000) {
                        throw '待恢复记录滚动步数无效'
                    }
                                        $relativeIds=@()
                    if($record.PSObject.Properties['relativeFolderIds']) {
                        if($record.relativeFolderIds -isnot [array] -or $record.relativeFolderIds.Count -ne $record.relativeFolder.Count){throw '待恢复目录身份路径无效'}
                        foreach($id in $record.relativeFolderIds){if($id -isnot [string] -or $id -cnotmatch '^folder_\d{8,30}$'){throw '待恢复目录身份无效'}}
                        $relativeIds=@($record.relativeFolderIds)
                    }
                    $resume.Add([pscustomobject]@{
                        Name=$record.sourceTitle; SourceId=$record.sourceId; Key=$record.sourceId; Kind=$record.kind
                        RelativeFolder=@($record.relativeFolder); RelativeFolderIds=@($relativeIds); ScrollPercent=[double]$record.scrollPercent; ScrollStep=[int]$record.scrollStep
                    })
                }
                $script:ResumeRecords = @($resume.ToArray())
            }
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
            if ($inputData.PSObject.Properties['includeSubfolders']) {
                if ($inputData.includeSubfolders -isnot [bool]) { throw '子目录开关无效' }
                $script:IncludeSubfolders = $inputData.includeSubfolders
                if (-not $script:IncludeSubfolders) { $script:MaxFolderDepth = 0 }
            }
            if ($inputData.PSObject.Properties['maxFolders']) {
                if (($inputData.maxFolders -isnot [int] -and $inputData.maxFolders -isnot [long]) -or
                    $inputData.maxFolders -lt 1 -or $inputData.maxFolders -gt 20) { throw '最近目录数必须在 1–20 之间' }
                $script:MaxFolders = [int]$inputData.maxFolders
            }
            if ($inputData.PSObject.Properties['maxFolderDepth']) {
                if (($inputData.maxFolderDepth -isnot [int] -and $inputData.maxFolderDepth -isnot [long]) -or
                    $inputData.maxFolderDepth -lt 0 -or $inputData.maxFolderDepth -gt 5) { throw '最大目录层级必须在 0–5 之间' }
                $script:MaxFolderDepth = [int]$inputData.maxFolderDepth
                $script:IncludeSubfolders = $script:MaxFolderDepth -gt 0
            }
            if ($inputData.PSObject.Properties['generalSelectionMode']) {
                if ($inputData.generalSelectionMode -isnot [string] -or
                    $inputData.generalSelectionMode -cnotin @('total', 'per-folder')) { throw '通用模式取量方式无效' }
                $script:GeneralSelectionMode = $inputData.generalSelectionMode
            }
            if ($inputData.PSObject.Properties['existingFiles']) {
                foreach ($file in @($inputData.existingFiles)) {
                    if ($file -isnot [string]) { throw '已有文件路径无效' }
                    $script:ExistingFiles[$file.ToLowerInvariant()] = $true
                }
            }
            if ($inputData.PSObject.Properties['downloadDirectory']) {
                $script:DownloadDirectory = [string]$inputData.downloadDirectory
                if (-not [IO.Path]::IsPathRooted($script:DownloadDirectory)) { throw '下载暂存目录必须为绝对路径' }
            }
            if ($inputData.PSObject.Properties['syncScopeMode']) {
                if ($inputData.syncScopeMode -notin @('all', 'recent')) { throw '同步范围模式无效' }
                $script:SyncScopeMode = [string]$inputData.syncScopeMode
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

if (-not $CheckDesktop) { Initialize-ImaInput }

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
using System.Text;

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

        [DllImport("user32.dll")]
        public static extern IntPtr GetWindow(IntPtr windowHandle, uint command);

        private delegate bool WindowEnum(IntPtr handle, IntPtr parameter);
        [DllImport("user32.dll")]
        private static extern bool EnumWindows(WindowEnum callback, IntPtr parameter);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr handle, out int processId);
        public static IntPtr[] GetProcessWindows(int[] processIds) {
            var ids = new System.Collections.Generic.HashSet<int>(processIds);
            var handles = new System.Collections.Generic.List<IntPtr>();
            EnumWindows(delegate(IntPtr handle, IntPtr parameter) {
                int processId; GetWindowThreadProcessId(handle, out processId);
                if (ids.Contains(processId)) handles.Add(handle);
                return true;
            }, IntPtr.Zero);
            return handles.ToArray();
        }
        public static bool CloseWindow(IntPtr windowHandle) {
            if (windowHandle == IntPtr.Zero) return false;
            PostMessage(windowHandle, 0x0112, new IntPtr(0xF060), IntPtr.Zero);
            return PostMessage(windowHandle, 0x0010, IntPtr.Zero, IntPtr.Zero);
        }

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

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetThreadDesktop(IntPtr hDesktop);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool CloseDesktop(IntPtr hDesktop);

        [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetDesktopName(IntPtr desktop, int index, StringBuilder name, uint length, out uint needed);

        [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", SetLastError = true)]
        private static extern bool GetDesktopInputState(IntPtr desktop, int index, out int receivingInput, uint length, out uint needed);

        public static bool IsWorkstationLocked() {
            IntPtr hDesktop = IntPtr.Zero;
            try {
                if (!Environment.UserInteractive || System.Diagnostics.Process.GetCurrentProcess().SessionId == 0) return true;
                hDesktop = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS, never switch desktops.
                if (hDesktop == IntPtr.Zero) return true;
                uint needed;
                var name = new StringBuilder(256);
                if (!GetDesktopName(hDesktop, 2, name, (uint)(name.Capacity * 2), out needed)) return true;
                int receivingInput;
                if (!GetDesktopInputState(hDesktop, 6, out receivingInput, 4, out needed)) return true;
                // Opening a handle alone also succeeds in some disconnected sessions.
                return receivingInput == 0 || !String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
            } catch {
                return true;
            } finally {
                if (hDesktop != IntPtr.Zero) CloseDesktop(hDesktop);
            }
        }
    }
}
"@
}

function Test-ImaWorkstationLocked {
    try {
        Initialize-ImaNativeMethods
        return [ImaSpeedSync.NativeMethods]::IsWorkstationLocked()
    } catch {
        return $true
    }
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

function Get-ImaNativeWindowHandles([int[]]$ProcessIds) {
    Initialize-ImaNativeMethods
    return [ImaSpeedSync.NativeMethods]::GetProcessWindows($ProcessIds)
}
function Get-ImaWindowElement([IntPtr]$Handle) {
    return [Windows.Automation.AutomationElement]::FromHandle($Handle)
}
function Get-ImaWindowRoots {
    Add-Type -AssemblyName UIAutomationClient
    $processIds = @{}
    foreach ($imaProcess in @(Get-Process -Name 'ima.copilot' -ErrorAction SilentlyContinue)) { $processIds[[int]$imaProcess.Id] = $true }
    if ($processIds.Count -eq 0) { return @() }
    $roots = New-Object Collections.Generic.List[object]
    # Filter HWNDs before UIA: unrelated desktop providers can stall FindAll for minutes.
    foreach ($handle in @(Get-ImaNativeWindowHandles ([int[]]@($processIds.Keys)))) {
        try {
            $window = Get-ImaWindowElement $handle
            if ($window -and $processIds.ContainsKey([int]$window.Current.ProcessId)) { $roots.Add($window) }
        }
        catch [Windows.Automation.ElementNotAvailableException] { continue }
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
    Initialize-ImaNativeMethods
    try {
        $hDesk = [ImaSpeedSync.NativeMethods]::OpenDesktop("default", 0, $false, 0x01FF)
        if ($hDesk -ne [IntPtr]::Zero) {
            [void][ImaSpeedSync.NativeMethods]::SetThreadDesktop($hDesk)
        }
    } catch {}

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
        try {
            $pids = @(Get-Process -Name "ima.copilot" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
            if ($pids.Count -gt 0) {
                $desktop = [Windows.Automation.AutomationElement]::RootElement
                foreach ($w in $desktop.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)) {
                    if ($w.Current.ProcessId -in $pids -and $w.Current.NativeWindowHandle -ne 0 -and $w.Current.Name -like "*ima*") {
                        $script:MainWindowHandle = [IntPtr]$w.Current.NativeWindowHandle
                        $script:MainProcessId = [int]$w.Current.ProcessId
                        return $w
                    }
                }
            }
        } catch {}
    }

    if (-not $process) {
        $executable = Join-Path $env:LOCALAPPDATA "ima.copilot\Application\ima.copilot.exe"
        if (-not (Test-Path -LiteralPath $executable)) {
            throw "IMA 未运行，且未找到程序文件：$executable"
        }
        Start-Process -FilePath $executable -WindowStyle Hidden | Out-Null
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

function Wait-ImaText([string]$Name, [int]$TimeoutMilliseconds = 45000, [string]$FailureHint = '') {
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
    if ($FailureHint) { throw $FailureHint }
    throw "等待 IMA 界面元素超时：$Name"
}

function Get-ImaSourceBreadcrumb {
    return @(Get-ImaBreadcrumbItems (Get-ImaRoot) | ForEach-Object { [string]$_.Current.Name.Trim() })
}

function Get-ImaKnowledgeBaseNames([Windows.Automation.AutomationElement]$Root) {
    $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty, 'RootWebArea')
    return @($Root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition) | Where-Object {
        -not $_.Current.IsOffscreen -and -not [string]::IsNullOrWhiteSpace($_.Current.Name)
    } | ForEach-Object { [string]$_.Current.Name })
}

function Stop-ImaSourceBinding([string]$Reason, [string[]]$ExpectedPath, [string[]]$ActualPath, [string]$Message) {
    $script:SourceNeedsRebind = [pscustomobject]@{
        reason = $Reason; expectedPath = @($ExpectedPath); actualPath = @($ActualPath); message = $Message
    }
    throw [InvalidOperationException]::new($Message)
}

function Assert-ImaSourcePath([string[]]$ExpectedPath = @()) {
    if (-not $script:SourcePathGuard) { return }
    if ($script:SourcePathGuard.PSObject.Properties['KnowledgeBaseId']) {
        [void](Assert-ImaNativeKnowledgeBase $script:SourcePathGuard.KnowledgeBaseId)
        $nativeExpected=if($PSBoundParameters.ContainsKey('ExpectedPath')){@($ExpectedPath)}else{@($script:SourcePathGuard.ExpectedPath)}
        $nativeActual=@(Get-ImaSourceBreadcrumb)
        if(-not (Test-ImaNativeBreadcrumbPath $nativeActual $nativeExpected)) { Stop-ImaSourceBinding 'path-changed' $nativeExpected $nativeActual '来源路径已变化，未继续点击。' }
        return
    }
    if ($script:SourceNeedsRebind) { throw [InvalidOperationException]::new($script:SourceNeedsRebind.message) }
    if (-not $PSBoundParameters.ContainsKey('ExpectedPath')) { $ExpectedPath = @($script:SourcePathGuard.ExpectedPath) }
    if ($null -eq $ExpectedPath) { $ExpectedPath = @() }
    $actual = @()
    try { $actual = @(Get-ImaSourceBreadcrumb) } catch [OperationCanceledException] { throw } catch {}
    $boundKnowledgeBase = if ($script:SourcePathGuard.PSObject.Properties['KnowledgeBaseName']) {
        [string]$script:SourcePathGuard.KnowledgeBaseName
    } else { '' }
    if ($boundKnowledgeBase) {
        $knowledgeBases = @()
        try { $knowledgeBases = @(Get-ImaKnowledgeBaseNames (Get-ImaRoot)) } catch [OperationCanceledException] { throw } catch {}
        if ($knowledgeBases.Count -ne 1 -or $knowledgeBases[0] -cne $boundKnowledgeBase) {
            $reason = if ($knowledgeBases.Count -eq 0) { 'missing' } elseif ($knowledgeBases.Count -gt 1) { 'ambiguous' } else { 'path-changed' }
            Stop-ImaSourceBinding $reason (@($boundKnowledgeBase) + @($ExpectedPath)) (@($knowledgeBases) + @($actual)) '来源知识库已变化或无法确认，同步已停止；请确认来源后重新绑定'
        }
    }
    $rootScope = $script:SourcePathGuard.PSObject.Properties['IsKnowledgeBaseRoot'] -and $script:SourcePathGuard.IsKnowledgeBaseRoot
    if ($rootScope) {
        if ($actual.Count -lt 1 -or $actual[0] -notmatch '^内容(?:[（(]\d+[）)])?$') {
            Stop-ImaSourceBinding 'path-changed' $ExpectedPath $actual '知识库根目录无法确认，未点击文章'
        }
        $actual = @($actual | Select-Object -Skip 1)
    }
    $matched = if ($rootScope) { $actual.Count -eq $ExpectedPath.Count } else { $actual.Count -ge $ExpectedPath.Count -and $ExpectedPath.Count -gt 0 }
    if ($matched) {
        for ($i = 0; $i -lt $ExpectedPath.Count; $i++) {
            if ($actual[$actual.Count - $ExpectedPath.Count + $i] -cne $ExpectedPath[$i].Trim()) { $matched = $false; break }
        }
    }
    if (-not $matched) {
        $reason = if ($actual.Count -eq 0) { 'missing' } else { 'path-changed' }
        if ($boundKnowledgeBase) { $ExpectedPath = @($boundKnowledgeBase) + @($ExpectedPath); $actual = @($boundKnowledgeBase) + @($actual) }
        Stop-ImaSourceBinding $reason $ExpectedPath $actual '来源目录已变化或无法确认，同步已停止；请确认来源后重新绑定'
    }
}

function Get-ImaExactNavigationTargets([Windows.Automation.AutomationElement]$Root, [string]$Name, [switch]$KnowledgeBase) {
    $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, $Name)
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    $seen = @{}
    foreach ($match in @($Root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition))) {
        if ($match.Current.IsOffscreen -or $match.Current.Name -cne $Name) { continue }
        $candidate = $match
        $target = $null
        $targetPattern = $null
        $article = $false
        $inSidebar = $false
        for ($level = 0; $level -lt 12 -and $candidate; $level++) {
            if (Get-ImaCardIdentity ([string]$candidate.Current.AutomationId)) { $article = $true; break }
            if ($candidate.Current.ClassName -like '*expandable-sidebar-panel-sidebar*' -or
                ($candidate.Current.AutomationId -ceq 'knowledgeBase' -and $candidate.Current.ClassName -match '(^|\s)_knowledgeBase_')) { $inSidebar = $true }
            $isEntry = if ($KnowledgeBase) {
                $candidate.Current.ClassName -match '(^|\s)_knowledgeListItem_[^\s]+'
            } else {
                $level -eq 0 -and $candidate.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and
                    $candidate.Current.ClassName -ceq 'HoverImageButton'
            }
            $pattern = $null
            if ($isEntry -and -not $target -and $candidate.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                $target = $candidate; $targetPattern = $pattern
            }
            if (($candidate.GetRuntimeId() -join '.') -ceq ($Root.GetRuntimeId() -join '.')) { break }
            $candidate = $walker.GetParent($candidate)
        }
        if ($article -or -not $target -or ($KnowledgeBase -and -not $inSidebar)) { continue }
        $key = $target.GetRuntimeId() -join '.'
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        [pscustomobject]@{ Element = $target; Pattern = $targetPattern }
    }
}

function Invoke-ImaExactNavigation([object]$Root, [string]$Name, [string[]]$ExpectedPath, [switch]$KnowledgeBase) {
    $targets = @(Get-ImaExactNavigationTargets $Root $Name -KnowledgeBase:$KnowledgeBase)
    if ($targets.Count -ne 1) {
        $reason = if ($targets.Count -gt 1) { 'ambiguous' } else { 'missing' }
        Stop-ImaSourceBinding $reason $ExpectedPath @(Get-ImaSourceBreadcrumb) "来源入口无法唯一确认：$Name"
    }
    Test-ImaCancellation
    $targets[0].Pattern.Invoke()
}

function Wait-ImaKnowledgeBaseSelected([string]$Name) {
    $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty, 'RootWebArea')
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Test-ImaCancellation
        $root = Get-ImaRoot
        $documents = @($root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition) | Where-Object {
            -not $_.Current.IsOffscreen -and $_.Current.Name -ceq $Name
        })
        if ($documents.Count -eq 1) { return $root }
        if ($documents.Count -gt 1) {
            Stop-ImaSourceBinding 'ambiguous' @($Name, $script:FolderName) @(Get-ImaSourceBreadcrumb) '存在多个同名知识库页面，未选择来源文件夹'
        }
        Start-ImaCancelableSleep 200
    } while ([DateTime]::UtcNow -lt $deadline)
    Stop-ImaSourceBinding 'missing' @($Name, $script:FolderName) @(Get-ImaSourceBreadcrumb) '知识库页面未确认完成跳转，未选择来源文件夹'
}

function Find-ImaSourceFolder([string]$Name, [string[]]$ExpectedPath) {
    # Unlike the ordinary candidate scan, binding must prove it reached the end
    # and must not deduplicate two physical folders by their display name.
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $matches = @{}
    $parent = @(Get-ImaSourceBreadcrumb)
    $root = Get-ImaRoot
    $scroller = Get-ImaTitleListScroller $root
    if ($scroller) { Reset-ImaTitleListToTop $scroller; Start-ImaCancelableSleep 200 }
    $stalled = 0
    $lastProgress = ''
    for ($page = 0; $page -lt 60 -and [DateTime]::UtcNow -lt $deadline; $page++) {
        Test-ImaCancellation
        $actualPath = @(Get-ImaSourceBreadcrumb)
        if (($actualPath -join "`n") -cne ($parent -join "`n")) {
            Stop-ImaSourceBinding 'path-changed' $ExpectedPath $actualPath '检查来源期间目录已变化，未打开文件夹或文章'
        }
        $root = Get-ImaRoot
        $list = Get-ImaTitleListElement $root
        if (-not $list) { break }
        $snapshot = Get-ImaGeneralTitleSnapshot $list -IncludeOffscreen
        $scroller = Get-ImaTitleListScroller $root
        $percent = if ($scroller) { [double]$scroller.Pattern.Current.VerticalScrollPercent } else { 0.0 }
        $view = if ($scroller) { [double]$scroller.Pattern.Current.VerticalViewSize } else { 100.0 }
        foreach ($record in @($snapshot.AllRecords | Where-Object { $_.Kind -eq 'folder' -and $_.Name -ceq $Name })) {
            $physicalId = $record.Card.GetRuntimeId() -join '.'
            $record.ScrollPercent = $percent
            $record.ScrollStep = $page
            $matches[$physicalId] = $record
        }
        if ($matches.Count -gt 1) {
            Stop-ImaSourceBinding 'ambiguous' $ExpectedPath $actualPath "存在多个同名来源文件夹，未自动选择：$Name"
        }
        $atEnd = -not $scroller -or $view -ge 99.9 -or $percent -ge 99.9
        if ($atEnd -and (Test-ImaNamedElement $list '没有更多内容了')) {
            if ($matches.Count -eq 1) {
                $match = @($matches.Values)[0]
                $match | Add-Member NoteProperty SourceParentPath @($parent) -Force
                return $match
            }
            Stop-ImaSourceBinding 'missing' $ExpectedPath $actualPath "未找到完全同名的来源文件夹：$Name"
        }
        if (-not $scroller -or $view -le 0 -or $view -ge 100 -or $percent -lt 0) { break }
        $progress = (@($snapshot.AllRecords | ForEach-Object { $_.Card.GetRuntimeId() -join '.' }) -join '|') + "@$percent/$view"
        if ($progress -ceq $lastProgress) { $stalled++ } else { $stalled = 0 }
        if ($stalled -ge 3) { break }
        $lastProgress = $progress
        $next = [Math]::Min(100, $percent + [Math]::Max(1, 75 * $view / (100 - $view)))
        if ($atEnd) {
            Set-ImaTitleListScrollPercent $scroller ([Math]::Max(0, $percent - 5))
            Start-ImaCancelableSleep 150
        }
        Set-ImaTitleListScrollPercent $scroller $next
        Start-ImaCancelableSleep 250
    }
    Stop-ImaSourceBinding 'missing' $ExpectedPath @(Get-ImaSourceBreadcrumb) '来源列表尚未完整确认，未按当前可见的同名文件夹自动绑定'
}

function Get-ImaSourceBasePath {
    if ($script:SourceTargetKind -eq 'knowledge-base') { return @() }
    if ($script:SourceFolderPath.Count -gt 0) { return @($script:SourceFolderPath) }
    return @($script:FolderName)
}

function Open-ImaKnowledgeBaseRoot {
    if ([string]::IsNullOrWhiteSpace($script:KnowledgeBaseName)) { throw '请选择知识库' }
    $root = Get-ImaRoot
    $root = Wait-ImaText '知识库'
    Invoke-ImaExactNavigation $root '知识库' @($script:KnowledgeBaseName)
    $root = Wait-ImaText $script:KnowledgeBaseName -TimeoutMilliseconds 15000
    Invoke-ImaExactNavigation $root $script:KnowledgeBaseName @($script:KnowledgeBaseName) -KnowledgeBase
    $root = Wait-ImaTitleListStable (Wait-ImaKnowledgeBaseSelected $script:KnowledgeBaseName)
    $crumbs = @(Get-ImaSourceBreadcrumb)
    if ($crumbs.Count -gt 1) { $root = Open-ImaBreadcrumb $crumbs[0] }
    $root = Wait-ImaTitleListStable $root
    $script:SourcePathGuard = [pscustomobject]@{ExpectedPath=@(); KnowledgeBaseName=$script:KnowledgeBaseName; IsKnowledgeBaseRoot=$true}
    Assert-ImaSourcePath
    return $root
}

function Get-ImaVisibleKnowledgeBaseCatalog {
    $root = Get-ImaRoot
    $root = Wait-ImaText '知识库'
    Invoke-ImaExactNavigation $root '知识库' @('知识库')
    Start-ImaCancelableSleep 400
    $root = Get-ImaRoot
    $textCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Text)
    $counts = New-Object 'Collections.Generic.Dictionary[string,int]' ([StringComparer]::Ordinal)
    foreach ($entry in @($root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition))) {
        Test-ImaCancellation
        if ($entry.Current.IsOffscreen -or $entry.Current.ClassName -notmatch '(^|\s)_knowledgeListItem_[^\s]+') { continue }
        $texts = @($entry.FindAll([Windows.Automation.TreeScope]::Descendants,$textCondition) | Where-Object { -not [string]::IsNullOrWhiteSpace($_.Current.Name) })
        if ($texts.Count -ne 1) { continue }
        $name = [string]$texts[0].Current.Name
        $targets = @(Get-ImaExactNavigationTargets $root $name -KnowledgeBase)
        if ($targets.Count -lt 1) { continue }
        $counts[$name] = $targets.Count
    }
    return [pscustomobject]@{kind='knowledge-bases';knowledgeBaseName='';names=@($counts.Keys | Where-Object {$counts[$_] -eq 1} | Sort-Object);ambiguousNames=@($counts.Keys | Where-Object {$counts[$_] -gt 1} | Sort-Object);complete=$false}
}

function Open-ImaAbsoluteFolderPath([string[]]$Parts) {
    # The caller has just verified the knowledge-base root. Every component must
    # be uniquely present in a complete parent list before any folder click.
    $walked = @()
    $root = Get-ImaRoot
    foreach ($part in $Parts) {
        Test-ImaCancellation
        Assert-ImaSourcePath $walked
        $folder = Find-ImaSourceFolder $part ($walked + @($part))
        Invoke-ImaArticleRecord $folder
        $root = Wait-ImaFolderSelected $part $folder -ExpectedPath ($walked + @($part)) -ParentPath $walked
        $walked += $part
        $script:SourcePathGuard = [pscustomobject]@{ExpectedPath=@($walked);KnowledgeBaseName=$script:KnowledgeBaseName;IsKnowledgeBaseRoot=$true}
        Assert-ImaSourcePath
    }
    return $root
}

function Get-ImaRootFolderCatalog {
    $previous = $script:FolderOnlyNavigation
    $script:FolderOnlyNavigation = $true
    try {
        $root = Open-ImaKnowledgeBaseRoot
        if ($script:SourceCatalogPath.Count -gt 0) { $root = Open-ImaAbsoluteFolderPath $script:SourceCatalogPath }
        $scroller = Get-ImaTitleListScroller $root
        if ($scroller) { Reset-ImaTitleListToTop $scroller; Start-ImaCancelableSleep 200 }
        $records = @{}
        $deadline = [DateTime]::UtcNow.AddSeconds(25)
        $lastProgress = ''; $stalled = 0
        for ($page=0; $page -lt 60 -and [DateTime]::UtcNow -lt $deadline; $page++) {
            Test-ImaCancellation
            Assert-ImaSourcePath @($script:SourceCatalogPath)
            $root = Get-ImaRoot
            $list = Get-ImaTitleListElement $root
            if (-not $list) { break }
            $snapshot = Get-ImaGeneralTitleSnapshot $list -IncludeOffscreen
            foreach ($record in @($snapshot.AllRecords | Where-Object Kind -eq 'folder')) {
                $records[($record.Card.GetRuntimeId() -join '.')] = [string]$record.Name
            }
            $scroller = Get-ImaTitleListScroller $root
            $percent = if ($scroller) { [double]$scroller.Pattern.Current.VerticalScrollPercent } else { 0.0 }
            $view = if ($scroller) { [double]$scroller.Pattern.Current.VerticalViewSize } else { 100.0 }
            $atEnd = -not $scroller -or $view -ge 99.9 -or $percent -ge 99.9
            if ($atEnd -and (Test-ImaNamedElement $list '没有更多内容了')) {
                $counts = New-Object 'Collections.Generic.Dictionary[string,int]' ([StringComparer]::Ordinal)
                foreach ($name in $records.Values) { if ($counts.ContainsKey($name)) { $counts[$name]++ } else { $counts[$name]=1 } }
                return [pscustomobject]@{kind='folders';parentPath=@($script:SourceCatalogPath);knowledgeBaseName=$script:KnowledgeBaseName;names=@($counts.Keys|Where-Object {$counts[$_] -eq 1}|Sort-Object);ambiguousNames=@($counts.Keys|Where-Object {$counts[$_] -gt 1}|Sort-Object);complete=$true}
            }
            if (-not $scroller -or $view -le 0 -or $view -ge 100 -or $percent -lt 0) { break }
            $progress=(@($snapshot.AllRecords|ForEach-Object {$_.Card.GetRuntimeId() -join '.'}) -join '|')+"@$percent/$view"
            if ($progress -ceq $lastProgress) { $stalled++ } else { $stalled=0 }
            if ($stalled -ge 3) { break }; $lastProgress=$progress
            if ($atEnd) { Set-ImaTitleListScrollPercent $scroller ([Math]::Max(0,$percent-5)); Start-ImaCancelableSleep 150 }
            Set-ImaTitleListScrollPercent $scroller ([Math]::Min(100,$percent+[Math]::Max(1,75*$view/(100-$view))))
            Start-ImaCancelableSleep 250
        }
        throw '目录列表未完整读取，请稍后重试；未使用部分列表选择来源'
    } finally { $script:FolderOnlyNavigation=$previous }
}

function Invoke-ImaSourceCatalog {
    Write-ImaProgress '正在读取 IMA 来源列表…'
    $catalog = if ($script:Operation -eq 'list-knowledge-bases') { Get-ImaVisibleKnowledgeBaseCatalog } else { Get-ImaRootFolderCatalog }
    return [pscustomobject]@{busy=$false;canceled=$false;items=@();errors=@();skippedTitles=@();sourceCatalog=$catalog}
}

function Open-ImaSpeedFolder {
    if (Get-Variable -Name NativeSource -Scope Script -ValueOnly -ErrorAction SilentlyContinue) { return Open-ImaNativeBoundSource }
    # Always enter the explicitly configured knowledge base. A same-named folder
    # left on screen does not establish which knowledge base owns it.
    $expected = @($script:KnowledgeBaseName, $script:FolderName)
    $previousFolderOnly = $script:FolderOnlyNavigation
    $script:FolderOnlyNavigation = $true
    try {
        $root = Open-ImaKnowledgeBaseRoot
        if ($script:SourceTargetKind -eq 'knowledge-base') {
            $script:GeneralFolderPath = @()
            return $root
        }
        if ($script:SourceFolderPath.Count -gt 0) {
            $root = Open-ImaAbsoluteFolderPath $script:SourceFolderPath
            $script:GeneralFolderPath = @()
            $script:MainWindowHandle = [IntPtr]$root.Current.NativeWindowHandle
            $script:MainProcessId = [int]$root.Current.ProcessId
            return $root
        }
        $folder = Find-ImaSourceFolder $script:FolderName $expected
        $script:SourcePathGuard = [pscustomobject]@{ ExpectedPath = @($folder.SourceParentPath); KnowledgeBaseName = $script:KnowledgeBaseName }
        Invoke-ImaArticleRecord $folder
        $root = Wait-ImaFolderSelected $script:FolderName $folder -ExpectedPath @(Get-ImaSourceBasePath)
        $script:GeneralFolderPath = @()
        $script:SourcePathGuard = [pscustomobject]@{ ExpectedPath = @(Get-ImaSourceBasePath); KnowledgeBaseName = $script:KnowledgeBaseName }
        Assert-ImaSourcePath
        $script:MainWindowHandle = [IntPtr]$root.Current.NativeWindowHandle
        $script:MainProcessId = [int]$root.Current.ProcessId
        return $root
    } catch [OperationCanceledException] { throw }
    catch {
        if ($script:SourceNeedsRebind) { throw }
        $actual = @()
        try { $actual = @(Get-ImaSourceBreadcrumb) } catch {}
        Stop-ImaSourceBinding 'missing' $expected $actual "无法确认配置的来源，未同步文章：$($_.Exception.Message)"
    } finally {
        $script:FolderOnlyNavigation = $previousFolderOnly
    }
}

function Get-ImaTitleListElement([Windows.Automation.AutomationElement]$Root) {
    $condition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::AutomationIdProperty,
        "shareKnowledgeContentList"
    )
    return $Root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}

function Get-ImaTitleReadinessSignature([object[]]$Records) {
    $keys = @($Records | ForEach-Object {
        if ($_.PSObject.Properties['Key']) { "$($_.Key):$($_.Name)" } else { [string]$_.Name }
    })
    if (-not $keys.Count) { return '' }
    return ConvertTo-Json -InputObject $keys -Compress
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
            ReadinessSignature = ""
        }
    }
    if ($script:ContentMode -eq "general" -or $script:FolderOnlyNavigation) { return Get-ImaGeneralTitleSnapshot $ListElement }
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
        ReadinessSignature = Get-ImaTitleReadinessSignature $orderedRecords
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

function Get-ImaTitleListState {
    $root = Get-ImaRoot
    $list = Get-ImaTitleListElement $root
    if (-not $list) {
        $missingFolder = $root.FindFirst([Windows.Automation.TreeScope]::Descendants,
            (New-Object Windows.Automation.PropertyCondition(
                [Windows.Automation.AutomationElement]::NameProperty, '当前文件夹不存在')))
        if ($missingFolder -and -not $missingFolder.Current.IsOffscreen) {
            return [pscustomobject]@{ Root = $root; Signature = ''; Hidden = $false; TerminalError = $true
                Reason = 'IMA 提示“当前文件夹不存在”，请确认原分享文件夹仍可访问，或在设置中重新选择来源' }
        }
        return [pscustomobject]@{ Root = $root; Signature = ''; Reason = '未找到分享文章列表'; Hidden = $false }
    }
    if ($root.Current.IsOffscreen -or $list.Current.IsOffscreen -or $list.Current.BoundingRectangle.Height -le 0) {
        return [pscustomobject]@{ Root = $root; Signature = ''; Reason = 'IMA 文章列表不可见，请展开 IMA 窗口后重试'; Hidden = $true }
    }
    $snapshot = Get-ImaVisibleTitleSnapshot $root $list
    # Layout animation changes Y coordinates without changing the articles.
    # Readiness depends on the ordered titles, not their screen positions.
    $signature = $snapshot.ReadinessSignature
    $reason = if ($signature) { "列表可读取，匹配 $(@($snapshot.Records).Count) 个标题" } else { '列表已找到，但没有识别到可见标题（可能仍在加载或标题规则不匹配）' }
    return [pscustomobject]@{ Root = $root; Signature = $signature; Reason = $reason; Hidden = $false }
}

function Wait-ImaTitleListStable(
    [Windows.Automation.AutomationElement]$Root,
    [int]$TimeoutMilliseconds = 15000,
    [scriptblock]$Recover = $null,
    [int]$RecoveryAfterMilliseconds = 6000
) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
    $started = [DateTime]::UtcNow
    $lastSignature = ""
    $stableCount = 0
    $recovered = $false
    $lastReason = ''
    $lastLoggedReason = ''
    $hiddenCount = 0
    do {
        Test-ImaCancellation
        try {
            $state = Get-ImaTitleListState
            $currentRoot = $state.Root
            $signature = $state.Signature
            $lastReason = $state.Reason
        }
        catch [OperationCanceledException] { throw }
        catch {
            # Chromium may rebuild its accessibility tree during folder navigation.
            $signature = ''
            $state = $null
            $lastReason = "读取列表暂时失败：$($_.Exception.Message)"
        }
        if ($lastReason -cne $lastLoggedReason) {
            Write-SyncLog "列表检测：$lastReason"
            $lastLoggedReason = $lastReason
        }
        if ($null -ne $state -and $state.PSObject.Properties['TerminalError'] -and $state.TerminalError) {
            throw $lastReason
        }
        if ($null -ne $state -and $state.Hidden) { $hiddenCount++ } else { $hiddenCount = 0 }
        if ($hiddenCount -ge 3) {
            throw $lastReason
        }
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
        if (-not $recovered -and $null -ne $Recover -and
            ([DateTime]::UtcNow - $started).TotalMilliseconds -ge $RecoveryAfterMilliseconds) {
            Test-ImaCancellation
            $recovered = $true
            Write-SyncLog '列表尚未就绪，重新定位目标文件夹一次（不抢占前台）'
            Write-ImaProgress '正在重新定位文章列表…'
            try { & $Recover | Out-Null }
            catch [OperationCanceledException] { throw }
            catch { Write-SyncLog "重新定位列表失败：$($_.Exception.Message)" }
            $lastSignature = ''
            $stableCount = 0
        }
        Start-ImaCancelableSleep 400
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "文章列表未就绪：$lastReason（已等待 $TimeoutMilliseconds 毫秒；重新定位：$recovered）"
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
    try {
        if (-not $ScrollTarget) { return $false }
        $rectProp = $ScrollTarget.PSObject.Properties['Rectangle']
        if (-not $rectProp -or -not $rectProp.Value) { return $false }
        $root = Get-ImaRoot
        if (-not $root) { return $false }
        $currentProp = $root.PSObject.Properties['Current']
        if (-not $currentProp -or -not $currentProp.Value) { return $false }
        $hwndProp = $currentProp.Value.PSObject.Properties['NativeWindowHandle']
        if (-not $hwndProp -or -not $hwndProp.Value) { return $false }
        $windowHandle = [IntPtr]$hwndProp.Value
        if ($windowHandle -eq [IntPtr]::Zero) { return $false }

        $beforeSignature = try { Get-ImaVisibleTitleSignature $root } catch { "" }
        $beforePercent = -1.0
        if ($ScrollTarget.PSObject.Properties['Pattern'] -and $ScrollTarget.Pattern -and $ScrollTarget.Pattern.PSObject.Properties['Current']) {
            $beforePercent = [double]$ScrollTarget.Pattern.Current.VerticalScrollPercent
        }
        $rectangle = $rectProp.Value
        $x = [int]($rectangle.X + ($rectangle.Width / 2))
        $y = [int]($rectangle.Y + ($rectangle.Height / 2))
        Invoke-ImaTargetWheel $windowHandle $x $y $Delta
        Start-ImaCancelableSleep 450
        $afterSignature = try { Get-ImaVisibleTitleSignature (Get-ImaRoot) } catch { "" }
        $afterPercent = -1.0
        if ($ScrollTarget.PSObject.Properties['Pattern'] -and $ScrollTarget.Pattern -and $ScrollTarget.Pattern.PSObject.Properties['Current']) {
            $afterPercent = [double]$ScrollTarget.Pattern.Current.VerticalScrollPercent
        }
        return (
            ($beforeSignature -and $afterSignature -and $afterSignature -cne $beforeSignature) -or
            ($beforePercent -ge 0 -and $afterPercent -ge 0 -and [Math]::Abs($afterPercent - $beforePercent) -ge 0.01)
        )
    } catch {
        return $false
    }
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
                if ($script:SourcePathGuard) { Assert-ImaSourcePath }
                Test-ImaCancellation
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
            $isNearBottom = [double]$viewport.ScrollPercent -ge 99
            if (-not $isNearBottom) {
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
    # Chromium accessible titles use NBSP; literal user filters use ordinary spaces.
    $literalTitle = ($Title -replace '[\s\u00A0\u202F]+', ' ').Trim()
    $literalFilter = ($script:TitleFilter -replace '[\s\u00A0\u202F]+', ' ').Trim()
    switch ($script:TitleFilterMode) {
        "all" { return $true }
        "contains" { return $literalTitle.IndexOf($literalFilter, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
        "prefix" { return $literalTitle.StartsWith($literalFilter, [StringComparison]::OrdinalIgnoreCase) }
        "regex" {
            try { return $script:TitleRegex.IsMatch($Title) }
            catch { throw "标题正则匹配超时或失败，请简化筛选表达式" }
        }
    }
    throw "标题筛选方式无效"
}

function Get-ImaCardIdentity([string]$AutomationId) {
    $match = [regex]::Match($AutomationId, '^knowledge-(note|weburl|pdf|file|image|audio|video)_(.+)$')
    if (-not $match.Success) { return $null }
    $id = $match.Groups[2].Value
    # Do not persist short numeric UI row indexes as article identities.
    $sourceId = if ($id -match '^[A-Za-z0-9_-]{16,}$' -and $id -notmatch '^\d+$') { $AutomationId } else { "" }
    return [pscustomobject]@{ Kind = $match.Groups[1].Value; SourceId = $sourceId; AutomationId = $AutomationId }
}

function Get-ImaCardTitleIndex([string[]]$Names, [string]$Kind) {
    $labels = @{ note='笔记'; weburl='网页'; pdf='PDF'; file='文件'; image='图片'; audio='音频'; video='视频' }
    # IMA can expose a thumbnail's entire preview before the actual title.
    # The verified card layout ends in title, kind, update time, not title first.
    if ($Kind -eq 'folder' -and $Names.Count -eq 4 -and $Names[1] -match '^\d+$' -and $Names[2] -eq '项') { return 0 }
    if ($Names.Count -ge 3 -and ($Names[-2] -ceq $labels[$Kind] -or ($Kind -eq 'weburl' -and $Names[-2] -ceq '网址')) -and
        $Names[-1] -match '^(?:(?:\d{4}[/.-])?\d{1,2}[/.-]\d{1,2}(?:\s+\d{1,2}:\d{2})?|\d{1,2}:\d{2}|今天|昨天|前天)(?:更新)?$') {
        return $Names.Count - 3
    }
    throw "IMA 文章卡片结构变化，无法可靠区分标题与摘要"
}

function Get-ImaGeneralTitleSnapshot([Windows.Automation.AutomationElement]$ListElement, [switch]$IncludeOffscreen) {
    $condition = New-Object Windows.Automation.PropertyCondition(
        [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Text)
    $allRecords = New-Object Collections.Generic.List[object]
    $knownArticleCards = 0
    $complete = $true
    $listRectangle = $ListElement.Current.BoundingRectangle
    foreach ($card in $ListElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)) {
        Test-ImaCancellation
        try {
            $texts = @($card.FindAll([Windows.Automation.TreeScope]::Descendants, $condition))
            $names = @($texts | ForEach-Object { [string]$_.Current.Name })
            $identity = Get-ImaCardIdentity ([string]$card.Current.AutomationId)
            if ($script:FolderOnlyNavigation -and $identity) { $knownArticleCards++; continue }
            if ($script:FolderOnlyNavigation -and $card.Current.AutomationId -cmatch '^knowledge-img_[A-Za-z0-9_-]+$' -and
                $names.Count -ge 3 -and $names[-2] -ceq '图片') { $knownArticleCards++; continue }
            if (-not $identity) {
                # Office cards are not supported download formats, but their
                # verified non-folder wrapper must not block source discovery.
                if($names.Count -ge 3 -and (($card.Current.AutomationId -cmatch '^knowledge-word_[A-Za-z0-9_-]{16,}$' -and $names[-2] -ceq 'WORD') -or ($card.Current.AutomationId -cmatch '^knowledge-img_[A-Za-z0-9_-]{16,}$' -and $names[-2] -ceq '图片'))){$knownArticleCards++;continue}
                $folderId = Get-ImaNativeFolderIdFromCard $card
                if ($names.Count -eq 4 -and $names[1] -match '^\d+$' -and $names[2] -eq '项') {
                    $identity = [pscustomobject]@{ Kind='folder'; SourceId=''; AutomationId=if($folderId){'knowledge-'+$folderId}else{''}; FolderId=$folderId }
                } elseif ($names.Count -eq 1 -and $names[0] -eq '没有更多内容了') { continue }
                elseif ($names.Count -eq 0) { if($folderId){$complete=$false}; continue }
                else {
                    if ($script:FolderOnlyNavigation) { throw "来源列表中存在无法识别的条目，未确认文件夹唯一性：$($card.Current.AutomationId) [$($names -join ' | ')]" }
                    $complete=$false
                    Write-SyncLog "跳过列表未就绪或未识别条目: $([string]$card.Current.AutomationId) [$($names -join ' | ')]"
                    continue
                }
            }
            $cardRectangle = $card.Current.BoundingRectangle
            if (-not $IncludeOffscreen -and ($cardRectangle.Bottom -le $listRectangle.Y -or $cardRectangle.Y -ge $listRectangle.Bottom)) { continue }
            $titleIndex = Get-ImaCardTitleIndex $names $identity.Kind
            $textElement = $texts[$titleIndex]
            $key = $identity.AutomationId + ':' + ($card.GetRuntimeId() -join '.')
            $name = [string]$textElement.Current.Name
            $rectangle = $textElement.Current.BoundingRectangle
            if (-not $IncludeOffscreen -and ($textElement.Current.IsOffscreen -or $rectangle.Width -le 0 -or $rectangle.Height -le 0 -or
                $rectangle.Y -ge $listRectangle.Bottom -or $rectangle.Bottom -le $listRectangle.Y)) { continue }
            $allRecords.Add([pscustomobject]@{
                Name = $name; Element = $textElement; Card = $card
                SourceId = $identity.SourceId; AutomationId = $identity.AutomationId; Kind = $identity.Kind
                FolderId = if($identity.Kind -eq 'folder'){$identity.FolderId}else{''}
                Key = if ($identity.Kind -eq 'folder') { if($identity.FolderId){$identity.AutomationId}else{"folder:$name"} } elseif ($identity.SourceId) { $identity.SourceId } else { "$key`:$name" }
                TimeLabel = $names[-1]
                ChildCount = if ($identity.Kind -eq 'folder') { [int]$names[1] } else { 0 }
                X = [double]$rectangle.X; Y = [double]$rectangle.Y; ScrollPercent = 0.0; ScrollStep = 0
            })
        }
        catch [Windows.Automation.ElementNotAvailableException] { $complete=$false; continue }
    }
    $allOrdered = @(if ($IncludeOffscreen) { $allRecords.ToArray() } else { $allRecords.ToArray() | Sort-Object Y, X })
    $records = @($allOrdered | Where-Object { $_.Kind -eq 'folder' -or (Test-ImaGeneralTitle $_.Name) })
    return [pscustomobject]@{
        Records = $records
        AllRecords = $allOrdered
        Complete = $complete
        Elements = @($records | ForEach-Object { $_.Element })
        ReadinessSignature = if ($allOrdered.Count) { Get-ImaTitleReadinessSignature $allOrdered } elseif ($knownArticleCards -gt 0) { "source-list-articles:$knownArticleCards" } elseif (Test-ImaNamedElement $ListElement '没有更多内容了') { 'empty-folder' } else { '' }
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

function Convert-ImaListTime([string]$Label, [datetime]$Now = (Get-Date)) {
    $text = $Label -replace '更新$', ''
    $date = $Now.Date
    try {
        if ($text -match '^(\d{1,2}):(\d{2})$') {
            if ([int]$Matches[1] -gt 23 -or [int]$Matches[2] -gt 59) { throw 'invalid clock' }
            return $date.AddHours([int]$Matches[1]).AddMinutes([int]$Matches[2])
        }
        if ($text -eq '今天') { return $date }
        if ($text -eq '昨天') { return $date.AddDays(-1) }
        if ($text -eq '前天') { return $date.AddDays(-2) }
        if ($text -match '^(?:(\d{4})[/.-])?(\d{1,2})[/.-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$') {
            $year = if ($Matches[1]) { [int]$Matches[1] } else { $Now.Year }
            $date = [datetime]::new($year, [int]$Matches[2], [int]$Matches[3])
            if (-not $Matches[1] -and $date -gt $Now.Date) { $date = $date.AddYears(-1) }
            if ($Matches[4]) {
                if ([int]$Matches[4] -gt 23 -or [int]$Matches[5] -gt 59) { throw 'invalid clock' }
                $date = $date.AddHours([int]$Matches[4]).AddMinutes([int]$Matches[5])
            }
            return $date
        }
    } catch { throw "无法识别 IMA 列表时间：$Label" }
    throw "无法识别 IMA 列表时间：$Label"
}

function Test-ImaGeneralScanBudget {
    Test-ImaCancellation
    if ($script:GeneralScannedFolders -gt 100 -or ($script:GeneralScanStarted -and
        ([DateTime]::UtcNow - $script:GeneralScanStarted).TotalSeconds -gt 180)) {
        throw '目录检查达到上限（100 个目录 / 180 秒），未完成选定目录的检查；请缩小来源文件夹或目录层级'
    }
}

function Get-ImaFolderRecords([Windows.Automation.AutomationElement]$Root, [int]$ExpectedCount = -1) {
    if (Get-Variable -Name NativeSource -Scope Script -ValueOnly -ErrorAction SilentlyContinue) { return @(Get-ImaNativeContents $script:NativeSource.knowledgeBaseId) }
    $records = New-Object Collections.Generic.List[object]
    $seen = @{}
    $scroller = Get-ImaTitleListScroller $Root
    if ($scroller) { Reset-ImaTitleListToTop $scroller }
    $percent = 0.0
    $stalledPages = 0
    for ($page = 0; $page -lt 60; $page++) {
        Test-ImaGeneralScanBudget
        $list = Get-ImaTitleListElement (Get-ImaRoot)
        if (-not $list) { throw '目录列表在检查过程中消失' }
        # Chromium exposes offscreen, already-loaded cards. Read their metadata in
        # one pass instead of opening/scrolling every item on the desktop.
        $snapshot = Get-ImaGeneralTitleSnapshot $list -IncludeOffscreen
        $previousCount = $records.Count
        foreach ($record in @($snapshot.AllRecords)) {
            if ($seen.ContainsKey($record.Key)) { continue }
            $seen[$record.Key] = $true
            $record.ScrollPercent = $percent
            if ($scroller -and $scroller.Pattern.Current.VerticalViewSize -gt 0 -and $scroller.Pattern.Current.VerticalViewSize -lt 100) {
                $bounds = $list.Current.BoundingRectangle
                $extent = $bounds.Height * (100 / $scroller.Pattern.Current.VerticalViewSize - 1)
                if ($extent -gt 0 -and $record.Y -ne 0) {
                    $record.ScrollPercent = [Math]::Max(0, [Math]::Min(100, $percent + ($record.Y - $bounds.Y - $bounds.Height * 0.2) / $extent * 100))
                }
            }
            $record.ScrollStep = $page
            $records.Add($record)
        }
        $notScrollable = -not $scroller -or $scroller.Pattern.Current.VerticalViewSize -ge 99.9
        $atEnd = $notScrollable -or $percent -ge 99.9
        $countComplete = $ExpectedCount -ge 0 -and $records.Count -eq $ExpectedCount
        $hasFooter = Test-ImaNamedElement $list '没有更多内容了'
        if ($countComplete -or ($hasFooter -and $atEnd)) {
            if ($ExpectedCount -ge 0 -and $records.Count -ne $ExpectedCount) {
                if ($stalledPages -lt 4) {
                    $stalledPages++
                    Start-ImaCancelableSleep 400
                    continue
                }
                if ($records.Count -gt 0) {
                    Write-SyncLog "目录条目数与预期存在轻微差异（预期 $ExpectedCount，读取 $($records.Count)），已按当前实际读取内容继续同步"
                    return $records.ToArray()
                }
                throw "目录内容数量发生变化或列表未完整加载（预期 $ExpectedCount，读取 $($records.Count)），请重试"
            }
            return $records.ToArray()
        }
        if ($atEnd) {
            if ($ExpectedCount -ge 0 -and $records.Count -ne $ExpectedCount) {
                if ($stalledPages -lt 4) {
                    $stalledPages++
                    Start-ImaCancelableSleep 400
                    if ($scroller) {
                        $jiggle = [Math]::Max(0.0, [Math]::Min(100.0, $percent - 5.0))
                        Set-ImaTitleListScrollPercent $scroller $jiggle
                        Start-ImaCancelableSleep 150
                        Set-ImaTitleListScrollPercent $scroller 100.0
                    }
                    continue
                }
                if ($records.Count -gt 0) {
                    Write-SyncLog "目录条目数与预期存在轻微差异（预期 $ExpectedCount，读取 $($records.Count)），已按当前实际读取内容继续同步"
                    return $records.ToArray()
                }
                throw "目录内容数量发生变化或列表未完整加载（预期 $ExpectedCount，读取 $($records.Count)），请重试"
            }
            return $records.ToArray()
        }
        if ($records.Count -gt 10000) { throw '单个目录条目超过 10000，请缩小同步范围' }
        $nextPercent = [Math]::Min(100, $percent + [Math]::Max(5, $scroller.Pattern.Current.VerticalViewSize * 0.75))
        Set-ImaTitleListScrollPercent $scroller $nextPercent
        Start-ImaCancelableSleep 200
        $actual = [double]$scroller.Pattern.Current.VerticalScrollPercent
        if ($actual -le $percent + 0.01) {
            if ($scroller -and (Get-Command 'Invoke-ImaTitleListMouseWheel' -ErrorAction SilentlyContinue)) {
                [void](Invoke-ImaTitleListMouseWheel $scroller -900)
                Start-ImaCancelableSleep 300
                $actual = [double]$scroller.Pattern.Current.VerticalScrollPercent
            }
            if ($actual -le $percent + 0.01) {
                Start-ImaCancelableSleep 350
                $actual = [double]$scroller.Pattern.Current.VerticalScrollPercent
            }
        }
        if ([double]::IsNaN($actual) -or [double]::IsInfinity($actual) -or $actual -lt 0 -or $actual -gt 100) {
            throw '目录滚动位置无效，未保存部分结果'
        }
        # Lazy loading expands the scroll extent: 99% can become 88% while
        # advancing. A lower percentage alone is not evidence of a stalled list.
        if ([Math]::Abs($actual - $percent) -lt 0.01 -and $records.Count -eq $previousCount) { $stalledPages++ }
        else { $stalledPages = 0 }
        if ($stalledPages -ge 3) {
            if ($records.Count -gt 0) {
                Write-SyncLog "目录滚动未继续推进，已成功读取并保留当前已发现的 $($records.Count) 项条目"
                return $records.ToArray()
            }
            throw "目录滚动未前进（已读取 $($records.Count)/$ExpectedCount，位置 $percent → $actual，目标 $nextPercent），未保存部分结果"
        }
        $percent = $actual
    }
    throw '目录分页检查达到上限，请缩小同步范围'
}

function Get-ImaBreadcrumbItems([Windows.Automation.AutomationElement]$Root) {
    # 优先在 ant-breadcrumb / breadcrumb 专用容器中查找
    $breadcrumbContainer = $Root.FindFirst([Windows.Automation.TreeScope]::Descendants,
        (New-Object Windows.Automation.PropertyCondition(
            [Windows.Automation.AutomationElement]::ClassNameProperty, "ant-breadcrumb", [Windows.Automation.PropertyConditionFlags]::IgnoreCase)))
    if (-not $breadcrumbContainer) {
        $condition = New-Object Windows.Automation.PropertyCondition(
            [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Group)
        foreach ($group in $Root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
            if ($group.Current.ClassName -like "*breadcrumb*") {
                $breadcrumbContainer = $group
                break
            }
        }
    }
    if ($breadcrumbContainer) {
        $listItems = @($breadcrumbContainer.FindAll([Windows.Automation.TreeScope]::Descendants,
            (New-Object Windows.Automation.PropertyCondition(
                [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ListItem))) |
            Where-Object { -not $_.Current.IsOffscreen -and -not [string]::IsNullOrWhiteSpace($_.Current.Name) })
        if ($listItems.Count -gt 0) { return $listItems }

        # 若容器无 ListItem 结构（如纯链接或文本节点），按视觉顺序提取有效具名子项
        $candidates = @($breadcrumbContainer.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) |
            Where-Object {
                -not $_.Current.IsOffscreen -and
                -not [string]::IsNullOrWhiteSpace($_.Current.Name) -and
                ($_.Current.Name.Trim() -cnotin @('/', '>', '\', '|', '·', '-', '»'))
            })
        $leafTexts=@($candidates|Where-Object{$_.Current.ControlType -eq [Windows.Automation.ControlType]::Text})
        if($leafTexts.Count -gt 0){return $leafTexts}
        $validItems = New-Object Collections.Generic.List[Windows.Automation.AutomationElement]
        foreach ($c in $candidates) {
            $t = $c.Current.ControlType
            if ($t -eq [Windows.Automation.ControlType]::Hyperlink -or
                $t -eq [Windows.Automation.ControlType]::Button -or
                $t -eq [Windows.Automation.ControlType]::Text -or
                $t -eq [Windows.Automation.ControlType]::Custom -or
                $t -eq [Windows.Automation.ControlType]::Group) {
                $name = $c.Current.Name.Trim()
                $alreadyAdded = $false
                foreach ($existing in $validItems) {
                    if ($existing.Current.Name.Trim() -ceq $name) {
                        $alreadyAdded = $true; break
                    }
                }
                if (-not $alreadyAdded) { $validItems.Add($c) }
            }
        }
        if ($validItems.Count -gt 0) { return $validItems.ToArray() }
    }
    # 回退机制：全树查找 ListItem，但排除 shareKnowledgeContentList 内容列表内的项
    $listElement = Get-ImaTitleListElement $Root
    $listId = if ($listElement) { $listElement.GetRuntimeId() -join '.' } else { '' }
    $allItems = @($Root.FindAll([Windows.Automation.TreeScope]::Descendants,
        (New-Object Windows.Automation.PropertyCondition(
            [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ListItem))) |
        Where-Object { -not $_.Current.IsOffscreen })
    if (-not $listId) { return $allItems }
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    $filtered = New-Object Collections.Generic.List[Windows.Automation.AutomationElement]
    foreach ($item in $allItems) {
        $curr = $item
        $isInsideContentList = $false
        for ($i = 0; $i -lt 10 -and $curr; $i++) {
            if (($curr.GetRuntimeId() -join '.') -ceq $listId) { $isInsideContentList = $true; break }
            $curr = $walker.GetParent($curr)
        }
        if (-not $isInsideContentList) { $filtered.Add($item) }
    }
    return $filtered.ToArray()
}

$script:ImaNativeClickInvoker = $null

function Invoke-ImaSafeNativeClick(
    [int]$TargetX,
    [int]$TargetY,
    [IntPtr]$ExpectedRootHandle = [IntPtr]::Zero
) {
    # 防线 1：前台交互许可检查（核心约束：不能在 allowForeground=false 时发送真实输入）
    if (-not $script:AllowForeground) {
        Write-SyncLog "原生补点击被拒绝：当前配置禁止前台交互 (allowForeground=false)"
        return [pscustomobject]@{ Success = $false; Executed = $false; Reason = 'PermissionDenied' }
    }

    # 防线 2：测试环境假能力注入
    if ($script:ImaNativeClickInvoker) {
        return & $script:ImaNativeClickInvoker $TargetX $TargetY $ExpectedRootHandle
    }

    # 防线 3：类型与方法有效性解析
    Initialize-ImaNativeMethods
    $type = "ImaSpeedSync.NativeMethods" -as [type]
    if (-not $type) {
        foreach ($asm in [AppDomain]::CurrentDomain.GetAssemblies()) {
            $t = $asm.GetType('ImaSpeedSync.NativeMethods')
            if ($t) { $type = $t; break }
        }
    }
    if (-not $type) {
        Write-SyncLog "原生补点击失败：ImaSpeedSync.NativeMethods 类型无法取得"
        return [pscustomobject]@{ Success = $false; Executed = $false; Reason = 'TypeNotFound' }
    }

    $mSetPos = $type.GetMethod('SetCursorPos')
    $mMouseEv = $type.GetMethod('mouse_event')
    $mWindowFromPoint = $type.GetMethod('WindowFromPoint', [Reflection.BindingFlags]'Static,NonPublic,Public')
    $mGetAncestor = $type.GetMethod('GetAncestor', [Reflection.BindingFlags]'Static,NonPublic,Public')

    if (-not $mSetPos -or -not $mMouseEv) {
        Write-SyncLog "原生补点击失败：未找到 SetCursorPos 或 mouse_event 方法"
        return [pscustomobject]@{ Success = $false; Executed = $false; Reason = 'MethodNotFound' }
    }

    # 防线 4：工作站锁定检查
    if (Test-ImaWorkstationLocked) {
        Write-SyncLog "原生补点击被拒绝：工作站处于锁定状态"
        return [pscustomobject]@{ Success = $false; Executed = $false; Reason = 'WorkstationLocked' }
    }

    # 防线 5：目标坐标遮挡与窗口归属校验（Hit-Test / Occlusion Check）
    if ($ExpectedRootHandle -ne [IntPtr]::Zero -and $mWindowFromPoint -and $mGetAncestor) {
        try {
            $pointType = $type.GetNestedType('POINT', [Reflection.BindingFlags]'Public,NonPublic')
            if ($pointType) {
                $pt = [Activator]::CreateInstance($pointType)
                $pt.X = $TargetX
                $pt.Y = $TargetY
                $hitWnd = $mWindowFromPoint.Invoke($null, @($pt))
                if ($hitWnd -ne [IntPtr]::Zero) {
                    $ancestor = $mGetAncestor.Invoke($null, @($hitWnd, [uint32]2))
                    if ($ancestor -ne $ExpectedRootHandle -and $hitWnd -ne $ExpectedRootHandle) {
                        Write-SyncLog "原生补点击被拒绝：目标坐标 ($TargetX, $TargetY) 被其他窗口遮挡或属于其他窗口 (HitWnd=$hitWnd, Expected=$ExpectedRootHandle)"
                        return [pscustomobject]@{ Success = $false; Executed = $false; Reason = 'OccludedOrMismatch' }
                    }
                }
            }
        } catch {
            Write-SyncLog "窗口归属探测异常，放弃点击以防误点: $($_.Exception.Message)"
            return [pscustomobject]@{ Success = $false; Executed = $false; Reason = 'HitTestFailed' }
        }
    }

    # 执行点击
    try {
        [void]$mSetPos.Invoke($null, @($TargetX, $TargetY))
        Start-Sleep -Milliseconds 40
        [void]$mMouseEv.Invoke($null, @([uint32]2, [uint32]0, [uint32]0, [int]0, [UIntPtr]::Zero))
        Start-Sleep -Milliseconds 40
        [void]$mMouseEv.Invoke($null, @([uint32]4, [uint32]0, [uint32]0, [int]0, [UIntPtr]::Zero))
        return [pscustomobject]@{ Success = $true; Executed = $true; Reason = 'Clicked' }
    } catch {
        Write-SyncLog "原生补点击调用执行异常: $($_.Exception.Message)"
        return [pscustomobject]@{ Success = $false; Executed = $false; Reason = $_.Exception.Message }
    }
}

function Invoke-ImaNativeClick([int]$TargetX, [int]$TargetY, [IntPtr]$ExpectedRootHandle = [IntPtr]::Zero) {
    return Invoke-ImaSafeNativeClick $TargetX $TargetY $ExpectedRootHandle
}

function Test-ImaFolderSelected([string]$Name, [string[]]$ExpectedPath = $null) {
    if ([string]::IsNullOrWhiteSpace($Name) -and ($null -eq $ExpectedPath -or $ExpectedPath.Count -eq 0)) { return $false }
    $crumbs = @(Get-ImaBreadcrumbItems (Get-ImaRoot))
    if ($crumbs.Count -eq 0) { return $false }
    $crumbNames = @($crumbs | ForEach-Object { [string]$_.Current.Name.Trim() })

    if ($ExpectedPath -and $ExpectedPath.Count -gt 0 -and (Get-Variable -Name NativeSource -Scope Script -ValueOnly -ErrorAction SilentlyContinue)) { return Test-ImaNativeBreadcrumbPath $crumbNames $ExpectedPath }
    if ($ExpectedPath -and $ExpectedPath.Count -gt 0) {
        if ($crumbNames.Count -ge $ExpectedPath.Count) {
            $matched = $true
            for ($i = 0; $i -lt $ExpectedPath.Count; $i++) {
                $actualPart = $crumbNames[$crumbNames.Count - $ExpectedPath.Count + $i]
                $expectedPart = $ExpectedPath[$i].Trim()
                if ($actualPart -cne $expectedPart) {
                    $matched = $false
                    break
                }
            }
            if ($matched) { return $true }
        }
        return $false
    }

    $lastCrumb = $crumbs[-1]
    if (Test-ImaNamedElement $lastCrumb $Name) { return $true }
    if ($lastCrumb.Current.Name -ceq $Name -or $lastCrumb.Current.Name.Trim() -ceq $Name.Trim()) { return $true }
    if ($crumbs.Count -eq 1 -and ($crumbs[0].Current.Name.Trim() -ceq $Name.Trim())) { return $true }
    return $false
}

function Get-ImaFolderPageState(
    [string]$TargetName,
    [string[]]$ExpectedPath = $null,
    [string[]]$ParentPath = $null
) {
    $root = Get-ImaRoot
    if (-not $root) {
        return [pscustomobject]@{
            Status = 'RootInvalid'
            Reason = 'IMA 根窗口未找到或句柄已失效'
            Breadcrumbs = @()
            ListElement = $null
            IsTerminalError = $false
        }
    }

    $isRootOffscreen = $false
    try {
        if ($root.Current -and $null -ne $root.Current.PSObject.Properties['IsOffscreen']) {
            $isRootOffscreen = [bool]$root.Current.IsOffscreen
        }
    } catch {}
    if ($isRootOffscreen) {
        return [pscustomobject]@{
            Status = 'WindowHidden'
            Reason = 'IMA 根窗口处于隐藏或最小化状态'
            Breadcrumbs = @()
            ListElement = $null
            IsTerminalError = $false
        }
    }

    # 终态错误页检测：例如“当前文件夹不存在”
    try {
        $missingFolder = $null
        if ($root -is [Windows.Automation.AutomationElement] -or ($root.PSObject -and $null -ne $root.PSObject.Methods['FindFirst'])) {
            $missingFolder = $root.FindFirst([Windows.Automation.TreeScope]::Descendants,
                (New-Object Windows.Automation.PropertyCondition(
                    [Windows.Automation.AutomationElement]::NameProperty, '当前文件夹不存在')))
        } elseif ($root.PSObject -and $null -ne $root.PSObject.Properties['FindFirst'] -and $root.PSObject.Properties['FindFirst'].Value -is [scriptblock]) {
            $missingFolder = & $root.FindFirst [Windows.Automation.TreeScope]::Descendants $null
        }
        if ($missingFolder) {
            $isMissOffscreen = $false
            if ($missingFolder.Current -and $null -ne $missingFolder.Current.PSObject.Properties['IsOffscreen']) {
                $isMissOffscreen = [bool]$missingFolder.Current.IsOffscreen
            }
            if (-not $isMissOffscreen) {
                return [pscustomobject]@{
                    Status = 'TerminalError'
                    Reason = 'IMA 提示“当前文件夹不存在”，请确认原分享文件夹仍可访问，或在设置中重新选择来源'
                    Breadcrumbs = @()
                    ListElement = $null
                    IsTerminalError = $true
                }
            }
        }
    } catch {}

    $crumbs = @(Get-ImaBreadcrumbItems $root)
    $crumbNames = @($crumbs | ForEach-Object { [string]$_.Current.Name.Trim() })
    $listElement = Get-ImaTitleListElement $root

    # 判断是否到达目标目录
    $isTarget = $false
    if ($ExpectedPath -and $ExpectedPath.Count -gt 0 -and ((Get-Variable -Name NativeSource -Scope Script -ValueOnly -ErrorAction SilentlyContinue) -or (Get-Variable -Name NativeIdentityInput -Scope Script -ValueOnly -ErrorAction SilentlyContinue))) {
        $isTarget=Test-ImaNativeBreadcrumbPath $crumbNames $ExpectedPath
    }
    elseif ($ExpectedPath -and $ExpectedPath.Count -gt 0) {
        if ($crumbNames.Count -ge $ExpectedPath.Count) {
            $isTarget = $true
            for ($i = 0; $i -lt $ExpectedPath.Count; $i++) {
                if ($crumbNames[$crumbNames.Count - $ExpectedPath.Count + $i] -cne $ExpectedPath[$i].Trim()) {
                    $isTarget = $false
                    break
                }
            }
        }
    } elseif ($crumbNames.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($TargetName)) {
        $last = $crumbNames[-1]
        if ($last -ceq $TargetName.Trim()) { $isTarget = $true }
    }

    if ($isTarget) {
        return [pscustomobject]@{
            Status = 'ReachedTarget'
            Reason = "已确认到达目标路径 [$($crumbNames -join ' > ')]"
            Breadcrumbs = $crumbNames
            ListElement = $listElement
            IsTerminalError = $false
        }
    }

    # 判断是否仍在父目录
    $isInParent = $false
    if ((Get-Variable -Name NativeSource -Scope Script -ValueOnly -ErrorAction SilentlyContinue) -or (Get-Variable -Name NativeIdentityInput -Scope Script -ValueOnly -ErrorAction SilentlyContinue)) {
        # The native root has a valid empty folder path. A no-op Invoke while
        # selection mode is active must remain InParent, not fake Navigating.
        $isInParent=Test-ImaNativeBreadcrumbPath $crumbNames @($ParentPath)
    }
    elseif ($ParentPath -and $ParentPath.Count -gt 0) {
        if ($crumbNames.Count -ge $ParentPath.Count) {
            $isInParent = $true
            for ($i = 0; $i -lt $ParentPath.Count; $i++) {
                if ($crumbNames[$crumbNames.Count - $ParentPath.Count + $i] -cne $ParentPath[$i].Trim()) {
                    $isInParent = $false
                    break
                }
            }
        }
    }

    if ($isInParent) {
        return [pscustomobject]@{
            Status = 'InParent'
            Reason = "仍处于父目录路径 [$($crumbNames -join ' > ')]"
            Breadcrumbs = $crumbNames
            ListElement = $listElement
            IsTerminalError = $false
        }
    }

    return [pscustomobject]@{
        Status = 'Navigating'
        Reason = if ($crumbNames.Count -eq 0) { '导航进行中（当前面包屑暂时为空，等待页面渲染）' } else { "导航进行中（当前过渡面包屑：$($crumbNames -join ' > ')）" }
        Breadcrumbs = $crumbNames
        ListElement = $listElement
        IsTerminalError = $false
    }
}

function Wait-ImaFolderSelected(
    [string]$Name,
    [object]$FolderRecord = $null,
    [scriptblock]$RetryAction = $null,
    [string[]]$ExpectedPath = $null,
    [string[]]$ParentPath = $null,
    [int]$TimeoutSeconds = 12
) {
    $navCorrId = [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $expectedPathText = if ($ExpectedPath) { $ExpectedPath -join ' > ' } else { $Name }
    $parentPathText = if ($ParentPath) { $ParentPath -join ' > ' } else { '（未指定）' }
    Write-SyncLog "[$navCorrId] 开始等待进入目标文件夹 [$Name]，预期路径：$expectedPathText，父路径：$parentPathText"

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastRetryTime = [DateTime]::UtcNow
    $retryCount = 0
    $maxRetries = 2
    $minRetryIntervalMs = 2000
    $navigatingObserved = $false
    $lastState = $null

    while ([DateTime]::UtcNow -lt $deadline) {
        Test-ImaCancellation
        Test-ImaGeneralScanBudget

        $state = Get-ImaFolderPageState -TargetName $Name -ExpectedPath $ExpectedPath -ParentPath $ParentPath
        $lastState = $state

        switch ($state.Status) {
            'ReachedTarget' {
                $crumbsText = if ($state.Breadcrumbs.Count) { $state.Breadcrumbs -join ' > ' } else { $Name }
                Write-SyncLog "[$navCorrId] 已确认进入目标文件夹 [$Name]，面包屑：$crumbsText"
                if ((Get-Variable -Name NativeSource -Scope Script -ValueOnly -ErrorAction SilentlyContinue) -or (Get-Variable -Name NativeIdentityInput -Scope Script -ValueOnly -ErrorAction SilentlyContinue)) {
                    $nativeBase=Get-ImaNativeKnowledgeBase (Get-ImaRoot)
                    return Wait-ImaNativeContentStable $nativeBase.id $nativeBase.name
                }
                try {
                    return Wait-ImaTitleListStable (Get-ImaRoot) -TimeoutMilliseconds 8000
                }
                catch {
                    # 通用模式下：空目录（合法无条目）或纯子目录列表，列表容器存在且可见即视为就绪
                    $list = Get-ImaTitleListElement (Get-ImaRoot)
                    if ($list -and -not $list.Current.IsOffscreen) {
                        return Get-ImaRoot
                    }
                    throw
                }
            }
            'TerminalError' {
                Write-SyncLog "[$navCorrId] 目标文件夹呈现终态错误: $($state.Reason)"
                throw $state.Reason
            }
            'WindowHidden' {
                Write-SyncLog "[$navCorrId] 根窗口处于隐藏状态，中止等待: $($state.Reason)"
                throw $state.Reason
            }
            'Navigating' {
                $navigatingObserved = $true
                # 导航过渡中（面包屑或列表暂时不可见），严禁补发输入，保持观察
            }
            'InParent' {
                # 只有未观察到导航切换痕迹、且仍在父目录、且超过最小重试间隔时，才允许有限重试
                $elapsedSinceRetry = ([DateTime]::UtcNow - $lastRetryTime).TotalMilliseconds
                if (-not $navigatingObserved -and $elapsedSinceRetry -ge $minRetryIntervalMs -and $retryCount -lt $maxRetries) {
                    $retryCount++
                    $lastRetryTime = [DateTime]::UtcNow
                    Write-SyncLog "[$navCorrId] 确认仍处于父目录，第 $retryCount 次尝试受控重试打开 [$Name]..."

                    if ($FolderRecord) {
                        try {
                            # 重新在当前父目录根节点查找新鲜目标卡片，严禁直接使用旧缓存对象
                            $freshRoot = Get-ImaRoot
                            $freshList = Get-ImaTitleListElement $freshRoot
                            $freshCandidates = if ($freshList) {
                                @((Get-ImaGeneralTitleSnapshot $freshList -IncludeOffscreen).AllRecords |
                                    Where-Object { $_.Kind -eq 'folder' -and $(if($FolderRecord.PSObject.Properties['FolderId'] -and $FolderRecord.FolderId){$_.FolderId -ceq $FolderRecord.FolderId}else{$_.Name -ceq $Name}) })
                            } else { @() }

                            if ($freshCandidates.Count -eq 1) {
                                Invoke-ImaArticleRecord $freshCandidates[0]
                            } elseif ($freshCandidates.Count -gt 1) {
                                Write-SyncLog "[$navCorrId] 父目录中存在同名文件夹歧义 ($($freshCandidates.Count) 项)，放弃盲目补点"
                            } else {
                                Write-SyncLog "[$navCorrId] 父目录中未重新找到目标文件夹卡片 [$Name]，放弃盲目补点"
                            }
                        } catch {
                            Write-SyncLog "[$navCorrId] 重试打开文件夹 [$Name] 异常: $($_.Exception.Message)"
                        }
                    }
                    elseif ($RetryAction) {
                        try {
                            & $RetryAction
                        } catch {
                            Write-SyncLog "[$navCorrId] 执行重试动作异常: $($_.Exception.Message)"
                        }
                    }
                }
            }
            default {
                # 其他未知状态，不补点击，等待下一次采样
            }
        }

        Start-ImaCancelableSleep 120
    }

    $finalCrumbs = if ($lastState -and $lastState.Breadcrumbs.Count) { $lastState.Breadcrumbs -join ' > ' } else { '（无面包屑）' }
    $finalReason = if ($lastState) { $lastState.Reason } else { '等待超时' }
    $diagMsg = "文件夹跳转未完成：$Name（当前停留在：$finalCrumbs，状态：$($lastState.Status)，诊断：$finalReason，重试次数：$retryCount，未继续点击其他条目）"
    Write-SyncLog "[$navCorrId] 导航最终失败: $diagMsg"
    throw $diagMsg
}

function Open-ImaBreadcrumb([string]$Name) {
    # 增加带重试的探测逻辑（最多重试 4 次，每次间隔 250ms）
    $crumbs = @()
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        $crumbs = @(Get-ImaBreadcrumbItems (Get-ImaRoot) | Where-Object {
            (Test-ImaNamedElement $_ $Name) -or ($_.Current.Name -ceq $Name) -or ($_.Current.Name.Trim() -ceq $Name.Trim())
        })
        if ($crumbs.Count -gt 0) { break }
        Start-ImaCancelableSleep 250
    }

    if ($crumbs.Count -ne 1) {
        $allCrumbs = @(Get-ImaBreadcrumbItems (Get-ImaRoot) | ForEach-Object { [string]$_.Current.Name.Trim() })
        $crumbsText = if ($allCrumbs.Count) { $allCrumbs -join ' > ' } else { '（无面包屑）' }
        throw "文件夹导航不唯一或已丢失：$Name（当前停留在：$crumbsText，匹配到 $($crumbs.Count) 项）"
    }

    Invoke-ImaNamedElement $crumbs[0] $Name
    return Wait-ImaFolderSelected $Name -ExpectedPath @($Name)
}

function Get-ImaGeneralCandidates([Windows.Automation.AutomationElement]$Root, [int]$Limit) {
    if ($script:MaxFolders -lt 1 -or $script:MaxFolders -gt 20 -or $script:MaxFolderDepth -lt 0 -or $script:MaxFolderDepth -gt 5 -or $Limit -lt 1 -or $Limit -gt 1000) {
        throw '通用模式的目录数量、层级或文件检查数量无效'
    }
    if ($script:GeneralSelectionMode -isnot [string] -or $script:GeneralSelectionMode -cnotin @('total', 'per-folder')) {
        throw '通用模式取量方式无效'
    }
    $script:GeneralScanStarted = [DateTime]::UtcNow
    $script:GeneralScannedFolders = 0
    $script:GeneralNavigationCache = @{}
    $selected = New-Object Collections.Generic.List[object]
    $pending = New-Object Collections.Generic.List[object]
    $pending.Add([pscustomobject]@{Path=@(); IdPath=@(); Expected=-1; Time=[datetime]::MaxValue; Ordinal=0; Phase='visit'; Records=@()})
    $selectedFolders = 0
    $nextOrdinal = 1
    $seen = @{}
    $scanTime = Get-Date
    $folderQuota = if ($script:SyncScopeMode -eq 'all') { [int]::MaxValue } else { $script:MaxFolders }
    try {
        while ($pending.Count -gt 0 -and $selectedFolders -lt $folderQuota) {
            Test-ImaGeneralScanBudget
            # Best-first over discovered directory metadata, not a global tree scan.
            # A cached selection shares its visit's ordinal, preserving source order
            # for date-only ties and avoiding opening older siblings unnecessarily.
            $folder = @($pending.ToArray() | Sort-Object @{Expression='Time';Descending=$true}, Ordinal)[0]
            [void]$pending.Remove($folder)
            if ($folder.Phase -eq 'select') {
                $selectedFolders++
                $ranked = New-Object Collections.Generic.List[object]
                $ordinal = 0
                foreach ($record in @($folder.Records)) {
                    if ($record.Kind -eq 'folder' -or -not (Test-ImaGeneralTitle $record.Name)) { continue }
                    $record | Add-Member NoteProperty RelativeFolder @($folder.Path) -Force
                    $record | Add-Member NoteProperty RelativeFolderIds @($folder.IdPath) -Force
                    $record | Add-Member NoteProperty SourceTime (Convert-ImaListTime $record.TimeLabel $scanTime) -Force
                    $record | Add-Member NoteProperty Ordinal ($ordinal++) -Force
                    $ranked.Add($record)
                }
                $localSeen = @{}
                $recent = @($ranked.ToArray() | Sort-Object @{Expression='SourceTime';Descending=$true}, Ordinal |
                    Where-Object {
                        $key = if ($_.SourceId) { $_.SourceId } else { $_.Key }
                        if ($localSeen.ContainsKey($key)) { return $false }; $localSeen[$key]=$true; return $true
                    } | Select-Object -First $Limit)
                foreach ($record in $recent) {
                    if ($script:GeneralSelectionMode -eq 'total') {
                        # Explicit sequence keeps directory/list order for equal
                        # timestamps, including on Windows PowerShell 5.1.
                        $record | Add-Member NoteProperty SelectionOrdinal $selected.Count -Force
                        $selected.Add($record)
                        continue
                    }
                    $key = if ($record.SourceId) { $record.SourceId } else { (@($folder.Path) + @($record.Key)) -join '/' }
                    # A duplicate across chosen directories consumes its original
                    # candidate slot. Existing/failed files likewise never backfill.
                    if ($seen.ContainsKey($key)) { continue }
                    $seen[$key] = $true
                    $selected.Add($record)
                }
                if ($script:SyncScopeMode -eq 'all') {
                    Write-SyncLog "选中目录 $selectedFolders（全量穷尽）：$(@(Get-ImaSourceBasePath) + @($folder.Path) -join ' / ')，包含 $($recent.Count) 条"
                } else {
                    Write-SyncLog "选中目录 $selectedFolders / $($script:MaxFolders)：$(@(Get-ImaSourceBasePath) + @($folder.Path) -join ' / ')，最近 $($recent.Count) 条"
                }
                continue
            }

            if (-not $script:NativeSource -and @($folder.Path).Count -gt 0 -and $folder.Path[-1] -in (@(Get-ImaSourceBasePath) + @($folder.Path | Select-Object -SkipLast 1))) {
                throw '父子文件夹同名，无法安全导航，请选择更具体的来源文件夹'
            }
            $currentRoot = Open-ImaGeneralPath $folder.Path $folder.IdPath
            $script:GeneralScannedFolders++
            Write-ImaProgress "检查目录：$(@(Get-ImaSourceBasePath) + @($folder.Path) -join ' / ')"
            $records = @(Get-ImaFolderRecords $currentRoot $folder.Expected)
            $script:GeneralNavigationCache[(@($folder.Path) -join "`n")] = $records
            $children = @($records | Where-Object { $_.Kind -eq 'folder' })
            $canDescend = $script:IncludeSubfolders -and @($folder.Path).Count -lt $script:MaxFolderDepth
            $rootWithChildren = @($folder.Path).Count -eq 0 -and $canDescend -and $children.Count -gt 0
            if (-not $rootWithChildren -and @($records | Where-Object { $_.Kind -ne 'folder' }).Count -gt 0) {
                $pending.Add([pscustomobject]@{Path=@($folder.Path); IdPath=@($folder.IdPath); Expected=$folder.Expected; Time=$folder.Time; Ordinal=$folder.Ordinal; Phase='select'; Records=$records})
            }
            if ($canDescend) {
                foreach ($child in $children) {
                    if ($child.ChildCount -eq 0) { continue }
                    $pending.Add([pscustomobject]@{
                        Path=@($folder.Path) + @($child.Name); IdPath=@($folder.IdPath)+@(if($child.PSObject.Properties['FolderId']){$child.FolderId}else{''}); Expected=$child.ChildCount
                        Time=(Convert-ImaListTime $child.TimeLabel $scanTime); Ordinal=($nextOrdinal++); Phase='visit'; Records=@()
                    })
                }
            }
        }
        if ($script:GeneralSelectionMode -eq 'total') {
            # Truncate before cross-directory identity deduplication. A duplicate
            # consumes a slot; existing/failed candidates never trigger backfill.
            $recentTotal = @($selected.ToArray() | Sort-Object @{Expression='SourceTime';Descending=$true}, SelectionOrdinal | Select-Object -First $Limit)
            $selected.Clear()
            foreach ($record in $recentTotal) {
                $key = if ($record.SourceId) { $record.SourceId } else { (@($record.RelativeFolder) + @($record.Key)) -join '/' }
                if ($seen.ContainsKey($key)) { continue }
                $seen[$key] = $true
                $selected.Add($record)
            }
            Write-SyncLog "目录检查完成：读取 $($script:GeneralScannedFolders) 个目录，选中 $selectedFolders 个取文件目录，合并按列表时间排序，整轮最多 $Limit 条，待检查 $($selected.Count) 条"
        } else {
            Write-SyncLog "目录检查完成：读取 $($script:GeneralScannedFolders) 个目录，选中 $selectedFolders 个取文件目录，每目录最多 $Limit 条，待检查 $($selected.Count) 条"
        }
        return $selected.ToArray()
    } finally {
        $script:GeneralScanStarted = $null
    }
}

function Open-ImaGeneralPath([string[]]$Parts, [string[]]$FolderIds=@()) {
    if ($script:NativeSource) { return Open-ImaNativeGeneralPath $Parts $FolderIds }
    try {
    if ($script:SourcePathGuard) { Assert-ImaSourcePath }
    $crumbs = @(Get-ImaBreadcrumbItems (Get-ImaRoot))
    $crumbNames = @($crumbs | ForEach-Object { [string]$_.Current.Name.Trim() })

    # 在真实面包屑中定位来源根目录（例如过滤掉“内容(16966)”等前置父节点）
    $rootIndex = if ($script:SourceTargetKind -eq 'knowledge-base') { 0 } else { -1 }
    for ($i = 0; $i -lt @($crumbNames).Count; $i++) {
        if ($crumbNames[$i] -ceq $script:FolderName -or $crumbNames[$i] -ceq $script:FolderName.Trim()) {
            $rootIndex = $i
            break
        }
    }

    if ($script:SourceFolderPath.Count -gt 0 -and $script:SourceTargetKind -ne 'knowledge-base') {
        $rootIndex = $script:SourceFolderPath.Count
    }

    if ($rootIndex -ge 0) {
        $currentParts = New-Object Collections.Generic.List[string]
        for ($i = $rootIndex + 1; $i -lt @($crumbNames).Count; $i++) {
            $currentParts.Add($crumbNames[$i])
        }
        $matchesCurrent = ($currentParts.Count -eq @($Parts).Count)
        if ($matchesCurrent) {
            for ($i = 0; $i -lt @($Parts).Count; $i++) {
                if ($currentParts[$i] -cne $Parts[$i]) { $matchesCurrent = $false; break }
            }
        }
        if ($matchesCurrent) {
            $script:GeneralFolderPath = @($Parts)
            return Get-ImaRoot
        }
    }

    $root = if ($script:SourceTargetKind -eq 'knowledge-base') {
        if ($crumbNames.Count -eq 1) { Get-ImaRoot } else { Open-ImaBreadcrumb $crumbNames[0] }
    } elseif ($script:SourceFolderPath.Count -gt 0) { Open-ImaSpeedFolder } elseif (Test-ImaFolderSelected $script:FolderName) { Get-ImaRoot } else { Open-ImaBreadcrumb $script:FolderName }
    if ($script:SourcePathGuard) {
        Assert-ImaSourcePath @(Get-ImaSourceBasePath)
        $script:SourcePathGuard.ExpectedPath = @(Get-ImaSourceBasePath)
    }
    $walked = @()
    foreach ($part in $Parts) {
        Test-ImaGeneralScanBudget
        $cacheKey = $walked -join "`n"
        $cached = if ($script:GeneralNavigationCache.ContainsKey($cacheKey)) { $script:GeneralNavigationCache[$cacheKey] } else { @(Get-ImaFolderRecords $root) }
        $folders = @($cached | Where-Object { $_.Kind -eq 'folder' -and $_.Name -ceq $part })
        if ($folders.Count -ne 1) {
            if ($script:SourcePathGuard) {
                $reason = if ($folders.Count -gt 1) { 'ambiguous' } else { 'missing' }
                Stop-ImaSourceBinding $reason (@(Get-ImaSourceBasePath) + $walked + @($part)) @(Get-ImaSourceBreadcrumb) "子目录无法唯一定位：$part"
            }
            throw "子目录无法唯一定位：$part"
        }
        Invoke-ImaArticleRecord $folders[0]
        $parentPath = @(Get-ImaSourceBasePath) + $walked
        $expectedPath = @(Get-ImaSourceBasePath) + $walked + @($part)
        $root = Wait-ImaFolderSelected $part $folders[0] -ExpectedPath $expectedPath -ParentPath $parentPath
        $walked += $part
        if ($script:SourcePathGuard) {
            Assert-ImaSourcePath $expectedPath
            $script:SourcePathGuard.ExpectedPath = @($expectedPath)
        }
    }
    $script:GeneralFolderPath = @($walked)
    return $root
    } catch [OperationCanceledException] { throw }
    catch {
        if ($script:SourcePathGuard -and -not $script:SourceNeedsRebind) {
            $actual = @()
            try { $actual = @(Get-ImaSourceBreadcrumb) } catch {}
            $reason = if ($actual.Count -eq 0) { 'missing' } else { 'path-changed' }
            Stop-ImaSourceBinding $reason (@(Get-ImaSourceBasePath) + @($Parts)) $actual "来源目录导航无法确认，同步已停止：$($_.Exception.Message)"
        }
        throw
    }
}

function Convert-ImaLocalName([string]$Name) {
    $safe = ($Name -replace '[\r\n\t]+', ' ' -replace '\s{2,}', ' ').Trim()
    $replacements = @{ '<'='＜'; '>'='＞'; ':'='：'; '"'='＂'; '/'='／'; '\'='＼'; '|'='｜'; '?'='？'; '*'='＊' }
    foreach ($key in $replacements.Keys) { $safe = $safe.Replace($key, $replacements[$key]) }
    $safe = ($safe -replace '[\x00-\x1f\x7f]', ' ' -replace '\s{2,}', ' ').Trim().TrimEnd('.', ' ')
    if (-not $safe) { $safe = '未命名文章' }
    $safe = (@([regex]::Matches($safe, '(?s)[\uD800-\uDBFF][\uDC00-\uDFFF]|.') | Select-Object -First 120 | ForEach-Object { $_.Value }) -join '').TrimEnd('.', ' ')
    if ($safe -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$') { $safe += '_' }
    return $safe
}

function Get-ImaOriginalFileExtension([object]$Record) {
    # IMA titles are display text, not Windows paths. Read the suffix before
    # sanitizing/truncating the stem, so long titles retain their file type.
    $suffix = [regex]::Match(([string]$Record.Name).Trim(), '(?i)\.[a-z0-9]+\z')
    $extension = $suffix.Value.ToLowerInvariant()
    if ($extension -notin @('.pdf','.png','.jpg','.jpeg','.gif','.webp','.mp3','.wav','.m4a','.mp4','.webm','.ogg')) {
        throw "尚未支持此原文件类型：$($Record.Kind)；未将预览或摘要当作原文件保存"
    }
    return $extension
}

function Get-ImaLocalRelativePath([object]$Record) {
    $parts = @()
    foreach ($part in @($Record.RelativeFolder)) {
        $safe = Convert-ImaLocalName $part
        if ($safe -cne $part) {
            $hash = [Security.Cryptography.SHA256]::Create()
            try { $digest = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($part))).Replace('-','').ToLowerInvariant() }
            finally { $hash.Dispose() }
            $safe += '-' + $digest.Substring(0,8)
        }
        $parts += $safe
    }
    if ($Record.Kind -eq 'note' -or $Record.Kind -eq 'weburl') { $name = (Convert-ImaLocalName $Record.Name) + '.md' }
    else {
        $extension = Get-ImaOriginalFileExtension $Record
        $name = (Convert-ImaLocalName ($Record.Name -replace '\.[^.]+$', '')) + $extension
    }
    return (@($parts) + @($name)) -join '/'
}

function Write-ImaArticleMatchDiagnostics([object]$Record, [object[]]$Candidates, [string]$Phase, [string]$Scope = 'visible') {
    $index = 0
    foreach ($matchRecord in @($Candidates)) {
        $index++
        try {
            $detail = [ordered]@{ Phase = $Phase; Scope = $Scope; Index = $index; TargetKey = [string]$Record.Key }
            foreach ($propertyName in @('Key', 'SourceId', 'AutomationId', 'Name', 'Kind')) {
                $property = $matchRecord.PSObject.Properties[$propertyName]
                $detail[$propertyName] = if ($property) { [string]$property.Value } else { $null }
            }
            foreach ($elementName in @('Card', 'Element')) {
                $elementProperty = $matchRecord.PSObject.Properties[$elementName]
                $element = if ($elementProperty) { $elementProperty.Value } else { $null }
                $elementDetail = [ordered]@{ RuntimeId = $null; Bounds = $null; IsOffscreen = $null }
                if ($element) {
                    try { $elementDetail.RuntimeId = $element.GetRuntimeId() -join '.' }
                    catch { $elementDetail.RuntimeIdError = $_.Exception.Message }
                    try {
                        $current = $element.Current
                        foreach ($propertyName in @('Name', 'AutomationId', 'IsOffscreen')) {
                            $property = $current.PSObject.Properties[$propertyName]
                            if ($property) { $elementDetail[$propertyName] = $property.Value }
                        }
                        $boundsProperty = $current.PSObject.Properties['BoundingRectangle']
                        if ($boundsProperty) {
                            $bounds = $boundsProperty.Value
                            $elementDetail.Bounds = [ordered]@{ X = $bounds.X; Y = $bounds.Y; Width = $bounds.Width; Height = $bounds.Height }
                        }
                    }
                    catch { $elementDetail.CurrentError = $_.Exception.Message }
                }
                $detail[$elementName] = $elementDetail
            }
            Write-SyncLog ("候选身份详情：" + (ConvertTo-Json -InputObject $detail -Depth 6 -Compress))
        }
        catch {
            # An expired UIA element must not make optional diagnostics change the result.
            Write-SyncLog "候选身份详情读取失败 [$($Record.Name)]: 阶段=$Phase, 集合=$Scope, 序号=$index, $($_.Exception.Message)"
        }
    }
}

function Wait-ImaLoadedArticleMatchReady([object]$Record, [object]$Root, [object]$List, [object[]]$Candidates, [datetime]$Deadline, [string]$Phase) {
    $loadedMatches = @($Candidates)
    $waitUntil = [DateTime]::UtcNow.AddMilliseconds(600)
    if ($loadedMatches.Count -gt 1) { Write-ImaArticleMatchDiagnostics $Record $loadedMatches $Phase 'loaded' }
    while ($loadedMatches.Count -gt 1 -and [DateTime]::UtcNow -lt $waitUntil -and [DateTime]::UtcNow -lt $Deadline) {
        Test-ImaCancellation
        Start-ImaCancelableSleep 150
        $Root = Get-ImaRoot
        $List = Get-ImaTitleListElement $Root
        $loadedMatches = @()
        if ($List) {
            $loadedMatches = @((Get-ImaGeneralTitleSnapshot $List -IncludeOffscreen).AllRecords | Where-Object { $_.Key -ceq $Record.Key })
        }
    }
    return [pscustomobject]@{ Root = $Root; List = $List; Records = @($loadedMatches) }
}

function Find-ImaArticleWithProgressiveLoading([object]$Record, [string[]]$ExpectedPath, [switch]$RestartFromTop) {
    # A saved percentage describes the old loaded extent, not an article index.
    # Continue by overlapping viewports when that extent has been rebuilt. This
    # fallback is reserved for an absent target; ambiguity never advances it.
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    $scrolls = 0
    $stalledScrolls = 0
    $lastProgress = ''
    $settleUntil = [DateTime]::MinValue
    $matches = @()
    $status = 'deadline'
    $rewindPending = $RestartFromTop.IsPresent
    while ([DateTime]::UtcNow -lt $deadline) {
        Test-ImaCancellation
        if (-not (Test-ImaFolderSelected $ExpectedPath[-1] -ExpectedPath $ExpectedPath)) {
            if ($script:SourcePathGuard) { Assert-ImaSourcePath $ExpectedPath }
            throw "定位期间来源目录已变化或无法确认，未继续滚动或点击：$($ExpectedPath -join ' > ')"
        }
        $root = Get-ImaRoot
        $list = Get-ImaTitleListElement $root
        $scroller = Get-ImaTitleListScroller $root
        if (-not $list -or -not $scroller -or -not $scroller.Pattern) {
            $status = 'list-unavailable'
            break
        }
        $snapshot = Get-ImaVisibleTitleSnapshot $root
        $matches = @($snapshot.Records | Where-Object { $_.Key -ceq $Record.Key })
        if ($matches.Count -eq 1) { $status = 'found'; break }
        if ($matches.Count -gt 1) {
            Write-ImaArticleMatchDiagnostics $Record $matches 'progressive-load' 'visible'
            Start-ImaCancelableSleep 150
            continue
        }
        $allLoaded = @((Get-ImaGeneralTitleSnapshot $list -IncludeOffscreen).AllRecords)
        $loaded = @($allLoaded | Where-Object { $_.Key -ceq $Record.Key })
        if ($loaded.Count -gt 1) {
            Write-ImaArticleMatchDiagnostics $Record $loaded 'progressive-load' 'loaded'
            Start-ImaCancelableSleep 150
            continue
        }
        # Reading the tree itself may allow a pending load to expand the range.
        $root = Get-ImaRoot
        $list = Get-ImaTitleListElement $root
        $scroller = Get-ImaTitleListScroller $root
        if (-not $list -or -not $scroller -or -not $scroller.Pattern) { $status = 'list-unavailable'; break }
        $current = [double]$scroller.Pattern.Current.VerticalScrollPercent
        $view = [double]$scroller.Pattern.Current.VerticalViewSize
        if ($current -lt 0 -or $view -le 0 -or $view -ge 100) { $status = 'not-scrollable'; break }
        if ($rewindPending -and $loaded.Count -eq 0) {
            # A stale saved percentage can land beyond the target. One bounded
            # second pass must cover earlier viewports instead of retrying bottom.
            $rewindPending = $false
            Set-ImaTitleListScrollPercent $scroller 0
            $scrolls++
            Start-ImaCancelableSleep 300
            continue
        }
        $progress = (@($allLoaded | ForEach-Object { [string]$_.Key }) -join '|') +
            "@$([Math]::Round($current, 2))/$([Math]::Round($view, 2))"
        if ($scrolls -gt 0 -and $progress -ceq $lastProgress) {
            # Give a requested move time to mount the next batch before deciding
            # it made no progress. Repeated identical reads are not progress.
            if ([DateTime]::UtcNow -lt $settleUntil) { Start-ImaCancelableSleep 150; continue }
            $stalledScrolls++
            if ($stalledScrolls -ge 2) { $status = 'no-progress'; break }
        } else { $stalledScrolls = 0 }
        if ($scrolls -ge 12) { $status = 'scroll-limit'; break }
        if (-not (Test-ImaFolderSelected $ExpectedPath[-1] -ExpectedPath $ExpectedPath)) {
            if ($script:SourcePathGuard) { Assert-ImaSourcePath $ExpectedPath }
            throw "定位期间来源目录已变化或无法确认，未继续滚动或点击：$($ExpectedPath -join ' > ')"
        }
        if ($loaded.Count -eq 1) {
            $bounds = $list.Current.BoundingRectangle
            $extent = $bounds.Height * (100 / $view - 1)
            if ($extent -le 0) { $status = 'invalid-extent'; break }
            $position = [Math]::Max(0, [Math]::Min(100, $current + ($loaded[0].Y - $bounds.Y - $bounds.Height * 0.2) / $extent * 100))
        } else {
            # Percent is relative to scrollable extent, so this is 3/4 of the
            # visible viewport with overlap, not a jump across unseen pages.
            $position = [Math]::Min(100, $current + [Math]::Max(1, 75 * $view / (100 - $view)))
        }
        Write-SyncLog "候选继续加载 [$($Record.Name)]: 目标Key=$($Record.Key), 目录=$($ExpectedPath -join ' > '), 第$($scrolls + 1)次, 已加载条目=$($allLoaded.Count), 目标匹配=$($loaded.Count), 当前滚动=$current%, 可见比=$view%, 调整滚动=$position%"
        $lastProgress = $progress
        if ($loaded.Count -eq 0 -and $current -ge 99.9) {
            # IMA can retain a provisional bottom until another real scroll
            # event requests the next batch. A bounded back-and-return is one
            # loading attempt; unchanged extent/keys afterward still stalls.
            if ($scrolls -ge 11) { $status = 'scroll-limit'; break }
            $backPosition = [Math]::Max(0, $current - [Math]::Max(1, 25 * $view / (100 - $view)))
            Write-SyncLog "候选底部重新加载 [$($Record.Name)]: 目标Key=$($Record.Key), 回退滚动=$backPosition%"
            Set-ImaTitleListScrollPercent $scroller $backPosition
            $scrolls++
            Start-ImaCancelableSleep 150
            Test-ImaCancellation
            if (-not (Test-ImaFolderSelected $ExpectedPath[-1] -ExpectedPath $ExpectedPath)) {
                if ($script:SourcePathGuard) { Assert-ImaSourcePath $ExpectedPath }
                throw "定位期间来源目录已变化或无法确认，未继续滚动或点击：$($ExpectedPath -join ' > ')"
            }
            $scroller = Get-ImaTitleListScroller (Get-ImaRoot)
            if (-not $scroller -or -not $scroller.Pattern) { $status = 'list-unavailable'; break }
            $position = 100.0
        }
        Set-ImaTitleListScrollPercent $scroller $position
        $scrolls++
        $settleUntil = [DateTime]::UtcNow.AddMilliseconds(1000)
        Start-ImaCancelableSleep 300
    }
    Write-SyncLog "候选继续加载结束 [$($Record.Name)]: 状态=$status, 滚动次数=$scrolls, 无进展次数=$stalledScrolls, 目标Key=$($Record.Key)"
    if (-not $RestartFromTop -and $matches.Count -eq 0 -and $status -in @('no-progress', 'scroll-limit', 'deadline')) {
        Write-SyncLog "候选滚动提示失准，重新从顶部按唯一 ID 查找 [$($Record.Name)]"
        $retry = Find-ImaArticleWithProgressiveLoading $Record $ExpectedPath -RestartFromTop
        return [pscustomobject]@{ Records = @($retry.Records); Status = $retry.Status; Scrolls = ($scrolls + $retry.Scrolls) }
    }
    return [pscustomobject]@{ Records = @($matches); Status = $status; Scrolls = $scrolls }
}

function Invoke-ImaArticleRecord([object]$Record) {
    if ($script:SourcePathGuard) {
        $expectedPath = @($script:SourcePathGuard.ExpectedPath)
        if ($Record.Kind -ne 'folder' -and $Record.PSObject.Properties['RelativeFolder']) {
            $expectedPath = @(Get-ImaSourceBasePath) + @($Record.RelativeFolder)
        }
        Assert-ImaSourcePath $expectedPath
    }
    # A pre-existing same-title window cannot safely be attributed to this card.
    $presence = if ($Record.Kind -ne 'folder') { Get-ImaArticleWindowPresence $Record.Name } else { $null }
    if ($presence -and ($presence.State -ne "Absent" -or (Find-ImaArticleWindow $Record.Name))) {
        throw "同名文章窗口已打开或身份无法确认，请先关闭该文章窗口后重试：$($Record.Name)"
    }
    $root = Get-ImaRoot
    $deadline = [DateTime]::UtcNow.AddMilliseconds(3500)
    $recoveryPhase = 'initial'

    # 阶段 1：首屏快速检查
    $snapshot = Get-ImaVisibleTitleSnapshot $root
    $matches = @($snapshot.Records | Where-Object { $_.Key -ceq $Record.Key })
    if ($matches.Count -gt 1) {
        Write-ImaArticleMatchDiagnostics $Record $matches $recoveryPhase 'visible'
        # A refreshed list can briefly expose two representations. Re-read without
        # choosing either; an absent target still enters the normal scroll recovery.
        while ($matches.Count -gt 1 -and [DateTime]::UtcNow -lt $deadline) {
            Test-ImaCancellation
            Start-ImaCancelableSleep 150
            $snapshot = Get-ImaVisibleTitleSnapshot (Get-ImaRoot)
            $matches = @($snapshot.Records | Where-Object { $_.Key -ceq $Record.Key })
        }
    }

    # 阶段 2：检查离屏已加载集合并滚动定位，附带轮询等待目标就绪
    if ($matches.Count -eq 0 -and [DateTime]::UtcNow -lt $deadline) {
        $recoveryPhase = 'loaded-scroll'
        $list = Get-ImaTitleListElement $root
        if ($list) {
            $loaded = @((Get-ImaGeneralTitleSnapshot $list -IncludeOffscreen).AllRecords | Where-Object { $_.Key -ceq $Record.Key })
            if ($loaded.Count -gt 1) {
                $loadedState = Wait-ImaLoadedArticleMatchReady $Record $root $list $loaded $deadline $recoveryPhase
                $root = $loadedState.Root
                $list = $loadedState.List
                $loaded = @($loadedState.Records)
            }
            if ($loaded.Count -eq 1) {
                $scrollItem = $null
                foreach ($element in @($loaded[0].Element, $loaded[0].Card)) {
                    if ($element) {
                        $hasMethod = $element -is [Windows.Automation.AutomationElement] -or $null -ne $element.PSObject.Methods['TryGetCurrentPattern']
                        if ($hasMethod -and $element.TryGetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern, [ref]$scrollItem)) {
                            if ($scrollItem -is [Windows.Automation.ScrollItemPattern]) {
                                ([Windows.Automation.ScrollItemPattern]$scrollItem).ScrollIntoView()
                            } else {
                                $scrollItem.ScrollIntoView()
                            }
                            break
                        }
                    }
                }
                if (-not $scrollItem) {
                    $scroller = Get-ImaTitleListScroller $root
                    if ($scroller) {
                        $view = [double]$scroller.Pattern.Current.VerticalViewSize
                        if ($view -gt 0 -and $view -lt 100) {
                            $bounds = $list.Current.BoundingRectangle
                            $scrollExtent = $bounds.Height * (100 / $view - 1)
                            $delta = ($loaded[0].Y - $bounds.Y - $bounds.Height * 0.2) / $scrollExtent * 100
                            $position = [Math]::Max(0, [Math]::Min(100, $scroller.Pattern.Current.VerticalScrollPercent + $delta))
                            Set-ImaTitleListScrollPercent $scroller $position
                        }
                    }
                }
                # 轮询等待目标在视口就绪（最长 800ms）
                $waitLoadedUntil = [DateTime]::UtcNow.AddMilliseconds(800)
                while ([DateTime]::UtcNow -lt $waitLoadedUntil -and [DateTime]::UtcNow -lt $deadline) {
                    Test-ImaCancellation
                    Start-ImaCancelableSleep 120
                    $snapshot = Get-ImaVisibleTitleSnapshot (Get-ImaRoot)
                    $matches = @($snapshot.Records | Where-Object { $_.Key -ceq $Record.Key })
                    if ($matches.Count -eq 1) { break }
                    if ($matches.Count -gt 1) { Write-ImaArticleMatchDiagnostics $Record $matches $recoveryPhase 'visible' }
                }
            }
        }
    }

    # 阶段 3：回放扫描提示位置（ScrollPercent / ScrollStep），附带目标就绪轮询
    if ($matches.Count -eq 0 -and [DateTime]::UtcNow -lt $deadline) {
        $recoveryPhase = 'hint-playback'
        $target = Get-ImaTitleListScroller $root
        if ($target) {
            if ($target.Pattern -or $target.RangePattern) {
                Set-ImaTitleListScrollPercent $target $Record.ScrollPercent
            }
            else {
                $distance = $Record.ScrollStep - $script:CurrentTitleScrollStep
                $delta = if ($distance -gt 0) { -900 } else { 900 }
                for ($step = 0; $step -lt [Math]::Abs($distance); $step++) {
                    Test-ImaCancellation
                    [void](Invoke-ImaTitleListMouseWheel $target $delta)
                }
            }
            # 轮询等待回放后目标出现（最长 1000ms）
            $waitHintUntil = [DateTime]::UtcNow.AddMilliseconds(1000)
            while ([DateTime]::UtcNow -lt $waitHintUntil -and [DateTime]::UtcNow -lt $deadline) {
                Test-ImaCancellation
                Start-ImaCancelableSleep 150
                $snapshot = Get-ImaVisibleTitleSnapshot (Get-ImaRoot)
                $matches = @($snapshot.Records | Where-Object { $_.Key -ceq $Record.Key })
                if ($matches.Count -eq 1) { break }
                if ($matches.Count -gt 1) { Write-ImaArticleMatchDiagnostics $Record $matches $recoveryPhase 'visible' }
            }
        }
    }

    # 阶段 4：大幅跳转后目标可能尚未加载；在剩余预算内等待新范围，最多几何补偿 1 次。
    if ($matches.Count -eq 0 -and [DateTime]::UtcNow -lt $deadline) {
        $recoveryPhase = 'extent-recovery'
        $extentAdjusted = $false
        while ($matches.Count -ne 1 -and [DateTime]::UtcNow -lt $deadline) {
            Test-ImaCancellation
            $root = Get-ImaRoot
            $list = Get-ImaTitleListElement $root
            $scroller = Get-ImaTitleListScroller $root
            $snapshot = Get-ImaVisibleTitleSnapshot $root
            $matches = @($snapshot.Records | Where-Object { $_.Key -ceq $Record.Key })
            if ($matches.Count -eq 1) { break }
            if ($matches.Count -gt 1) { Write-ImaArticleMatchDiagnostics $Record $matches $recoveryPhase 'visible' }
            $loaded = @()
            if ($list) {
                $loaded = @((Get-ImaGeneralTitleSnapshot $list -IncludeOffscreen).AllRecords | Where-Object { $_.Key -ceq $Record.Key })
            }
            if ($loaded.Count -gt 1) { Write-ImaArticleMatchDiagnostics $Record $loaded $recoveryPhase 'loaded' }
            if (-not $extentAdjusted -and $matches.Count -eq 0 -and $loaded.Count -eq 1 -and [DateTime]::UtcNow -lt $deadline) {
                # Loading this card can expand the list while its snapshot is read.
                # Reacquire the provider after that read before computing geometry.
                $root = Get-ImaRoot
                $list = Get-ImaTitleListElement $root
                $scroller = Get-ImaTitleListScroller $root
            }
            if (-not $extentAdjusted -and $matches.Count -eq 0 -and $loaded.Count -eq 1 -and $list -and $scroller -and $scroller.Pattern -and [DateTime]::UtcNow -lt $deadline) {
                $bounds = $list.Current.BoundingRectangle
                $view = [double]$scroller.Pattern.Current.VerticalViewSize
                if ($view -gt 0 -and $view -lt 100) {
                    $scrollExtent = $bounds.Height * (100 / $view - 1)
                    $delta = ($loaded[0].Y - $bounds.Y - $bounds.Height * 0.2) / $scrollExtent * 100
                    $position = [Math]::Max(0, [Math]::Min(100, $scroller.Pattern.Current.VerticalScrollPercent + $delta))
                    Write-SyncLog "候选范围恢复 [$($Record.Name)]: 当前滚动=$($scroller.Pattern.Current.VerticalScrollPercent)%, 可见比=$view%, 目标Y=$($loaded[0].Y), 调整滚动=$position%"
                    Set-ImaTitleListScrollPercent $scroller $position
                    $extentAdjusted = $true
                    $waitAdjustUntil = [DateTime]::UtcNow.AddMilliseconds(800)
                    while ([DateTime]::UtcNow -lt $waitAdjustUntil -and [DateTime]::UtcNow -lt $deadline) {
                        Test-ImaCancellation
                        Start-ImaCancelableSleep 150
                        $snapshot = Get-ImaVisibleTitleSnapshot (Get-ImaRoot)
                        $matches = @($snapshot.Records | Where-Object { $_.Key -ceq $Record.Key })
                        if ($matches.Count -eq 1) { break }
                        if ($matches.Count -gt 1) { Write-ImaArticleMatchDiagnostics $Record $matches $recoveryPhase 'visible' }
                    }
                }
            }
            if ($matches.Count -ne 1 -and [DateTime]::UtcNow -lt $deadline) { Start-ImaCancelableSleep 150 }
        }
    }

    # A duplicate observed near the end of a scroll poll still gets the remaining
    # shared budget to settle; never select the first candidate or match by title.
    if ($matches.Count -gt 1 -and [DateTime]::UtcNow -lt $deadline) {
        Write-ImaArticleMatchDiagnostics $Record $matches $recoveryPhase 'visible'
        while ($matches.Count -ne 1 -and [DateTime]::UtcNow -lt $deadline) {
            Test-ImaCancellation
            Start-ImaCancelableSleep 150
            $snapshot = Get-ImaVisibleTitleSnapshot (Get-ImaRoot)
            $matches = @($snapshot.Records | Where-Object { $_.Key -ceq $Record.Key })
        }
    }

    $recoveryExpectedPath = @()
    if ($matches.Count -eq 0 -and $Record.Kind -ne 'folder' -and
        $Record.PSObject.Properties['RelativeFolder'] -and ($script:SourceTargetKind -eq 'knowledge-base' -or -not [string]::IsNullOrWhiteSpace($script:FolderName))) {
        $recoveryPhase = 'progressive-load'
        $recoveryExpectedPath = @(Get-ImaSourceBasePath) + @($Record.RelativeFolder)
        $progressive = Find-ImaArticleWithProgressiveLoading $Record $recoveryExpectedPath
        $matches = @($progressive.Records)
    }

    # 阶段 5：终态严格核验与现场诊断
    if ($matches.Count -eq 0) {
        $diagRoot = Get-ImaRoot
        $diagList = if ($diagRoot) { Get-ImaTitleListElement $diagRoot } else { $null }
        $diagScroller = if ($diagRoot) { Get-ImaTitleListScroller $diagRoot } else { $null }
        $currentPct = if ($diagScroller -and $diagScroller.Pattern -and $diagScroller.Pattern.Current) { [Math]::Round([double]$diagScroller.Pattern.Current.VerticalScrollPercent, 1) } else { -1 }
        $currentView = if ($diagScroller -and $diagScroller.Pattern -and $diagScroller.Pattern.Current) { [Math]::Round([double]$diagScroller.Pattern.Current.VerticalViewSize, 1) } else { -1 }
        $diagLoaded = if ($diagList) {
            $allSnap = Get-ImaGeneralTitleSnapshot $diagList -IncludeOffscreen
            if ($allSnap -and $allSnap.AllRecords) {
                @($allSnap.AllRecords | Where-Object { $_.Key -ceq $Record.Key })
            } else { @() }
        } else { @() }
        $diagLoadedCount = @($diagLoaded).Count
        $loadedStatus = if ($diagLoadedCount -gt 0 -and $diagLoaded[0].Element -and $diagLoaded[0].Element.Current) {
            "首个已加载匹配(Y=$([Math]::Round($diagLoaded[0].Y)), Offscreen=$($diagLoaded[0].Element.Current.IsOffscreen))"
        } else {
            "未在已加载树中发现"
        }
        if ($diagLoadedCount -gt 1) { Write-ImaArticleMatchDiagnostics $Record $diagLoaded $recoveryPhase 'loaded' }
        Write-SyncLog "候选定位诊断 [$($Record.Name)]: 阶段=$recoveryPhase, 视口匹配=0, 已加载匹配=$diagLoadedCount, 状态=$loadedStatus, 当前滚动=$currentPct%(可见比$currentView%), 提示滚动=$($Record.ScrollPercent)%, 目标Key=$($Record.Key)"
        throw "未在当前列表中定位到文章，本轮不点击：$($Record.Name)"
    }
    if ($matches.Count -gt 1) {
        Write-ImaArticleMatchDiagnostics $Record $matches $recoveryPhase 'visible'
        Write-SyncLog "候选定位歧义 [$($Record.Name)]: 阶段=$recoveryPhase, 匹配到 $($matches.Count) 个相同 Key 的条目"
        throw "文章条目来源 ID 存在歧义，本轮不点击：$($Record.Name)"
    }
    if ($recoveryExpectedPath.Count -gt 0 -and
        -not (Test-ImaFolderSelected $recoveryExpectedPath[-1] -ExpectedPath $recoveryExpectedPath)) {
        if ($script:SourcePathGuard) { Assert-ImaSourcePath $recoveryExpectedPath }
        throw "定位期间来源目录已变化或无法确认，本轮不点击：$($recoveryExpectedPath -join ' > ')"
    }
    Write-ImaArticleMatchDiagnostics $Record $matches 'verified' 'visible'
    # The card container's InvokePattern can be a silent no-op. Resolve the
    # nearest invokable title/ancestor, bounded by this exact identity's card.
    $pattern = $null
    $candidate = $matches[0].Element
    $cardRuntimeId = $matches[0].Card.GetRuntimeId() -join '.'
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    for ($level = 0; $level -lt 12 -and $candidate; $level++) {
        $hasMethod = $candidate -is [Windows.Automation.AutomationElement] -or $null -ne $candidate.PSObject.Methods['TryGetCurrentPattern']
        if ($hasMethod -and $candidate.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { break }
        if (($candidate.GetRuntimeId() -join '.') -ceq $cardRuntimeId) { break }
        $candidate = $walker.GetParent($candidate)
    }
    if (-not $pattern) { throw "文章条目未提供可安全调用的打开操作：$($Record.Name)" }
    if ($script:SourcePathGuard) { Assert-ImaSourcePath $expectedPath }
    Test-ImaCancellation
    $script:CurrentTitleScrollStep = $Record.ScrollStep
    $invokedOk = $false
    try {
        if ($pattern -is [Windows.Automation.InvokePattern]) {
            ([Windows.Automation.InvokePattern]$pattern).Invoke()
        } else {
            $pattern.Invoke()
        }
        $invokedOk = $true
    }
    catch {
        Write-SyncLog "条目 [$($Record.Name)] 调用 InvokePattern 出现提示: $($_.Exception.Message)"
        if ($Record.Kind -eq 'folder') {
            # 针对文件夹：页面切换常导致 Chromium DOM 节点销毁抛错，但实际已成功进入
            Start-ImaCancelableSleep 250
            if (Test-ImaFolderSelected $Record.Name) {
                Write-SyncLog "文件夹 [$($Record.Name)] 已确认进入目标目录，忽略界面刷新异常"
                return
            }
            # 若未完成跳转，重新定位可见条目再尝试一次打开
            Start-ImaCancelableSleep 250
            try {
                $retrySnapshot = Get-ImaVisibleTitleSnapshot (Get-ImaRoot)
                $retryMatches = @($retrySnapshot.Records | Where-Object { $_.Key -ceq $Record.Key })
                if ($retryMatches.Count -eq 1) {
                    $retryCandidate = $retryMatches[0].Element
                    $retryCardId = $retryMatches[0].Card.GetRuntimeId() -join '.'
                    $retryWalker = [Windows.Automation.TreeWalker]::RawViewWalker
                    $retryPattern = $null
                    for ($lvl = 0; $lvl -lt 12 -and $retryCandidate; $lvl++) {
                        if ($retryCandidate.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$retryPattern)) { break }
                        if (($retryCandidate.GetRuntimeId() -join '.') -ceq $retryCardId) { break }
                        $retryCandidate = $retryWalker.GetParent($retryCandidate)
                    }
                    if ($retryPattern) {
                        if ($script:SourcePathGuard) { Assert-ImaSourcePath $expectedPath }
                        Test-ImaCancellation
                        ([Windows.Automation.InvokePattern]$retryPattern).Invoke()
                        $invokedOk = $true
                    }
                }
            } catch {}
            if (Test-ImaFolderSelected $Record.Name) {
                return
            }
        }
        else {
            # 针对文章或原文件：检查对应阅读器窗口是否已经打开
            Start-ImaCancelableSleep 250
            $presence = Get-ImaArticleWindowPresence $Record.Name
            if ($presence -and $presence.State -eq 'Present') {
                $invokedOk = $true
            } else {
                $orig = Get-ImaOriginalWindowPresence $Record.Name
                if ($orig -and $orig.State -eq 'Present') {
                    $invokedOk = $true
                }
            }
        }
        if (-not $invokedOk) {
            throw "无法确认文章是否已打开，本轮不重复点击：$($Record.Name)"
        }
    }
    if ($Record.Kind -eq 'folder') {
        # 文件夹卡片已通过 UIA 发起打开；导航确认与受控重试统一由 Wait-ImaFolderSelected 处理，不在 200ms 内盲目补发真实输入
        return
    }
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
    if ([double]::IsNaN($Snapshot.ScrollPercent)) { return $false }
    # ScrollPercent is relative to the scrollable range; ViewSize cannot be added to it.
    # Below 99%, only independently observed content geometry can prove completion.
    return $Snapshot.ScrollPercent -ge 99 -and $Snapshot.ScrollPercent -le 105
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

function Get-ImaNormalizedTitleKey([string]$Title) {
    if ([string]::IsNullOrWhiteSpace($Title)) { return '' }
    # A title is not an ID. Preserve punctuation, dates and the extension.
    # Win32/UIA title bars strip or replace '&' (mnemonic accelerator) with spaces, and normalize NBSP, dashes and tildes.
    return ($Title -replace '&', ' ' -replace '[—–]', '-' -replace '[~～]', '~' -replace '\s+', ' ').Trim()
}

function Get-ImaOriginalWindowPresence([string]$Title) {
    # File cards use NBSP while their native reader title uses ordinary spaces.
    # Normalize whitespace only; ambiguous matches must never select a window.
    $normalized = Get-ImaNormalizedTitleKey $Title
    try {
        $roots = @(Get-ImaWindowRoots)
        $matches = @($roots | Where-Object { (Get-ImaNormalizedTitleKey $_.Current.Name) -ceq $normalized })
        if ($matches.Count -eq 1) { return [pscustomobject]@{State='Present';Root=$matches[0]} }
        if ($matches.Count -gt 1) { return [pscustomobject]@{State='Unknown';Root=$null} }
        return [pscustomobject]@{State='Absent';Root=$null}
    } catch { return [pscustomobject]@{State='Unknown';Root=$null} }
}

function Get-ImaOwnedWindowIdentity([object]$Window) {
    if (-not $Window) { throw '窗口身份不可用' }
    $handle = [string]$Window.Current.NativeWindowHandle
    $process = [int]$Window.Current.ProcessId
    $runtime = @($Window.GetRuntimeId()) -join '.'
    if (-not $handle -or $handle -eq '0' -or $process -le 0 -or -not $runtime) { throw '窗口身份不完整' }
    return "$process/$handle/$runtime"
}

function Get-ImaReaderTabs([object]$Window) {
    if(-not $Window.PSObject.Methods['FindAll']){return @()}
    foreach($tab in @($Window.FindAll([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::TabItem))))){
        $selection=$null
        if($tab.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$selection)){[pscustomobject]@{Element=$tab;Id=($tab.GetRuntimeId()-join'.');Title=(Get-ImaNormalizedTitleKey $tab.Current.Name);Selected=$selection.Current.IsSelected}}
    }
}
function Test-ImaReaderSource([object]$Window,[string]$SourceId) {
    if($SourceId -cnotmatch '^knowledge-(.+)$'){return $false};$expected=$Matches[1];$ids=@{}
    foreach($value in @(Get-ImaReaderDocumentUrls $Window)){
        try{
            $uri=[uri]$value
            if($uri.Scheme -ceq 'chrome-extension'){
                if($uri.Host -cne 'elhgpcianbbmeilccnddimfddkgegeee' -or $uri.AbsolutePath -cne '/index.html'){continue}
                $q=ConvertFrom-ImaUrlQuery $uri;if(-not $q.ContainsKey('originUrl')){continue};$uri=[uri]$q['originUrl']
            }
            if(-not (Test-ImaTrustedDownloadUri $uri)){continue};$q=ConvertFrom-ImaUrlQuery $uri
            if($q.ContainsKey('media_id')){$ids[$q['media_id']]=$true}
        }catch{}
    };return $ids.Count -eq 1 -and $ids.ContainsKey($expected)
}
function Select-ImaOwnedOriginalWindow([object[]]$Windows, [hashtable]$BeforeHandles, [string]$Title, [hashtable]$BeforeTabs=@{}, [string]$SourceId='', [switch]$AllowExisting) {
    $key = Get-ImaNormalizedTitleKey $Title
    $compactKey = ($key -replace '\s+', '')
    $matches = @($Windows | Where-Object {
        if ($BeforeHandles.ContainsKey([string]$_.Current.NativeWindowHandle)) { return $false }
        $wKey = Get-ImaNormalizedTitleKey $_.Current.Name
        if ($wKey -ceq $key) { return $true }
        if (($wKey -replace '\s+', '') -ceq $compactKey) { return $true }
        return $false
    })
    $tabMatches=@()
    if($SourceId){foreach($window in $Windows){
        $handle=[string]$window.Current.NativeWindowHandle
        if(-not $BeforeTabs.ContainsKey($handle) -or (Get-ImaOwnedWindowIdentity $window) -cne $BeforeHandles[$handle]){continue}
        $tabs=@(Get-ImaReaderTabs $window|Where-Object{($AllowExisting -or $_.Id -cnotin $BeforeTabs[$handle]) -and $_.Title -ceq $key})
        if($tabs.Count -gt 1){throw '出现多个本轮新文件标签页，未操作不确定内容'}
        if($tabs.Count -eq 1 -and $tabs[0].Selected -and (Get-ImaNormalizedTitleKey $window.Current.Name) -ceq $key -and (Test-ImaReaderSource $window $SourceId)){
            $tabMatches+= [pscustomobject]@{Window=$window;Identity=(Get-ImaOwnedWindowIdentity $window);Title=$key;TabId=$tabs[0].Id;SourceId=$SourceId;KeepOpen=($tabs[0].Id -cin $BeforeTabs[$handle])}
        }
    }}
    if($matches.Count+$tabMatches.Count -gt 1){throw '出现多个同名文件阅读器，未操作不确定窗口'}
    if($tabMatches.Count -eq 1){$script:PreserveImaWindows=$true;return $tabMatches[0]}
    if ($matches.Count -eq 1) {
        return [pscustomobject]@{ Window=$matches[0]; Identity=(Get-ImaOwnedWindowIdentity $matches[0]); Title=(Get-ImaNormalizedTitleKey $matches[0].Current.Name) }
    }
    return $null
}

function Test-ImaOwnedWindow([object]$Owned) {
    if (-not $Owned) { return $false }
    try {
        if((Get-ImaOwnedWindowIdentity $Owned.Window) -cne $Owned.Identity -or (Get-ImaNormalizedTitleKey $Owned.Window.Current.Name) -cne $Owned.Title){return $false}
        if($Owned.PSObject.Properties['TabId']){
            $tabs=@(Get-ImaReaderTabs $Owned.Window|Where-Object{$_.Selected})
            return $tabs.Count -eq 1 -and $tabs[0].Id -ceq $Owned.TabId -and (Test-ImaReaderSource $Owned.Window $Owned.SourceId)
        };return $true
    } catch { return $false }
}

function Close-ImaOwnedOriginalWindow([object]$Owned) {
    # Never enumerate or close unrelated windows, even on failure/cancellation.
    if($Owned -and $Owned.PSObject.Properties['KeepOpen'] -and $Owned.KeepOpen){return}
    if(-not (Test-ImaOwnedWindow $Owned)){return}
    if($Owned.PSObject.Properties['TabId']){
        $tab=@(Get-ImaReaderTabs $Owned.Window|Where-Object{$_.Id -ceq $Owned.TabId})[0]
        $close=@($tab.Element.FindAll([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'关闭'))))
        $pattern=$null
        if($close.Count -eq 1 -and $close[0].TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern) -and (Test-ImaOwnedWindow $Owned)){$pattern.Invoke()}
        return
    };Close-ImaOriginalWindow $Owned.Window
}

function Close-ImaApplicationAfterSync {
    if ($script:PreserveImaWindows) {
        Write-SyncLog '保留用户已有或新打开的 IMA 窗口，本轮未关闭应用'
        return
    }
    Close-ImaApplication | Out-Null
}

function Get-ImaNativeOwnerHandle([IntPtr]$Handle) {
    Initialize-ImaNativeMethods
    return [ImaSpeedSync.NativeMethods]::GetWindow($Handle, 4) # GW_OWNER
}

function Test-ImaSaveDialogOwner([object]$Dialog, [object]$Reader) {
    if ($Dialog.Current.ProcessId -ne $Reader.Current.ProcessId) { return $false }
    $target = [IntPtr]$Reader.Current.NativeWindowHandle
    $owner = [IntPtr]$Dialog.Current.NativeWindowHandle
    for ($i=0; $i -lt 8; $i++) {
        $owner = Get-ImaNativeOwnerHandle $owner
        if ($owner -eq [IntPtr]::Zero) { return $false }
        if ($owner -eq $target) { return $true }
    }
    return $false
}

function Get-ImaOriginalDownloadControl([object]$Reader) {
    $controls = @($Reader.FindAll([Windows.Automation.TreeScope]::Descendants,
        (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, '下载'))) |
        Where-Object { $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
    if ($controls.Count -ne 1) { throw 'IMA 未提供唯一可用的下载入口，未导出此文件' }
    return $controls[0]
}

function Invoke-ImaOwnedDownload([object]$Owned) {
    Test-ImaCancellation
    if (-not (Test-ImaOwnedWindow $Owned)) { throw '文件阅读器身份已变化' }
    $control = Get-ImaOriginalDownloadControl $Owned.Window
    $pattern = $null
    if (-not $control.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw '下载入口无法安全调用' }
    ([Windows.Automation.InvokePattern]$pattern).Invoke()
}

function Select-ImaOwnedSaveDialog([object[]]$Windows, [hashtable]$BeforeHandles, [object]$Reader) {
    $matches = @($Windows | Where-Object {
        -not $BeforeHandles.ContainsKey([string]$_.Current.NativeWindowHandle) -and
        $_.Current.Name -match '^(另存为|保存为|Save As)$' -and (Test-ImaSaveDialogOwner $_ $Reader)
    })
    if ($matches.Count -gt 1) { throw '出现多个目标文件的保存窗口，未自动操作' }
    if ($matches.Count -eq 1) {
        return [pscustomobject]@{ Window=$matches[0]; Identity=(Get-ImaOwnedWindowIdentity $matches[0]); Title=(Get-ImaNormalizedTitleKey $matches[0].Current.Name) }
    }
    return $null
}

function Get-ImaReaderDocumentUrls([object]$Reader) {
    $urls = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $documents = @($Reader.FindAll([Windows.Automation.TreeScope]::Descendants,
        (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Document))))
    foreach ($document in $documents) {
        try {
            $pattern = $null
            if ($document.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                $value = [string]$pattern.Current.Value
                if ($value -match '^(https://|chrome-extension://)') { [void]$urls.Add($value) }
            }
        } catch {}
    }
    return @($urls)
}

function ConvertFrom-ImaUrlQuery([uri]$Uri) {
    $result = New-Object 'Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
    foreach ($part in $Uri.Query.TrimStart('?').Split('&')) {
        if (-not $part) { continue }
        if ($part -match '%(?![0-9a-fA-F]{2})') { throw '文件链接编码无效' }
        $pair = $part -split '=', 2
        $name = [uri]::UnescapeDataString($pair[0].Replace('+',' '))
        $value = if ($pair.Length -eq 2) { [uri]::UnescapeDataString($pair[1].Replace('+',' ')) } else { '' }
        if ($result.ContainsKey($name)) { throw '文件链接包含重复参数' }
        $result.Add($name, $value)
    }
    return ,$result
}

function Decode-ImaUrlTitle([string]$Raw) {
    if ([string]::IsNullOrWhiteSpace($Raw)) { return '' }
    $val = $Raw
    for ($i = 0; $i -lt 3; $i++) {
        if ($val -match '%[0-9a-fA-F]{2}') {
            try { $val = [uri]::UnescapeDataString($val) } catch { break }
        } else { break }
    }
    return $val
}

function Test-ImaTrustedDownloadUri([uri]$Uri) {
    if (-not $Uri -or -not $Uri.IsAbsoluteUri -or $Uri.Scheme -cne 'https' -or
        $Uri.UserInfo -or -not $Uri.IsDefaultPort -or $Uri.Fragment -or $Uri.IsLoopback) { return $false }
    $hostName = $Uri.DnsSafeHost.ToLowerInvariant()
    # Service/CDN boundary only. Identity still MUST come from the owned reader,
    # and an enabled export control; a Tencent-hosted URL alone is not identity.
    return $hostName -eq 'ima.qq.com' -or $hostName.EndsWith('.ima.qq.com') -or
        $hostName -eq 'ima.myqcloud.com' -or $hostName.EndsWith('.ima.myqcloud.com') -or
        $hostName -match '^[a-z0-9][a-z0-9-]*-[0-9]+\.cos\.[a-z0-9-]+\.myqcloud\.com$'
}

function Get-ImaReaderFileUrl([object]$Owned, [string]$TargetTitle, [DateTime]$SinceTime = [DateTime]::MinValue) {
    if (-not (Test-ImaOwnedWindow $Owned)) { throw '文件阅读器身份已变化' }
    $urls = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($value in @(Get-ImaReaderDocumentUrls $Owned.Window)) {
        try {
            $uri = [uri]$value
            if ($uri.Scheme -ceq 'chrome-extension') {
                if ($uri.Host -cne 'elhgpcianbbmeilccnddimfddkgegeee' -or $uri.AbsolutePath -cne '/index.html') { continue }
                $query = ConvertFrom-ImaUrlQuery $uri
                if (-not $query.ContainsKey('originUrl')) { continue }
                $uri = [uri]$query['originUrl']
            }
            if (-not (Test-ImaTrustedDownloadUri $uri)) { continue }
            $query = ConvertFrom-ImaUrlQuery $uri
            if (-not $query.ContainsKey('media_title') -or
                (Get-ImaNormalizedTitleKey (Decode-ImaUrlTitle $query['media_title'])) -cne (Get-ImaNormalizedTitleKey $TargetTitle)) { continue }
            [void]$urls.Add($uri.AbsoluteUri)
        } catch { continue }
    }
    if (-not (Test-ImaOwnedWindow $Owned)) { throw '文件阅读器身份已变化' }
    if ($urls.Count -gt 1) { throw '阅读器提供多个不同文件链接，未下载不确定内容' }
    if ($urls.Count -eq 1) { return @($urls)[0] }

    # 若 UIA 属性未暴露（嵌入式 Chromium PDF 页面常态），调用基于时间戳与精准全等标题的可信直链嗅探
    $intercepted = Get-ImaInterceptedFileUrl $TargetTitle -SinceTime $SinceTime
    if ($intercepted) { return $intercepted }

    return $null
}

function Close-ImaOriginalWindow([Windows.Automation.AutomationElement]$Window) {
    if (-not $Window) { return }
    $handle = [IntPtr]$Window.Current.NativeWindowHandle

    # 1. 优先尝试点击界面上的「关闭」按钮（独立阅读器窗口的右上角关闭按钮 AutomationId 常为 view_4）
    try {
        $closeBtns = @($Window.FindAll([Windows.Automation.TreeScope]::Descendants,
            (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, "关闭"))) |
            Where-Object { -not $_.Current.IsOffscreen })

        # 优先点击 view_4（独立阅读器窗口的右上角关闭按钮）
        $view4Btns = @($closeBtns | Where-Object { $_.Current.AutomationId -eq "view_4" })
        if ($view4Btns.Count -gt 0) {
            $inv = $null
            if ($view4Btns[0].TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) {
                ([Windows.Automation.InvokePattern]$inv).Invoke()
                Start-ImaCancelableSleep 200
                return
            }
        }

        # 其次尝试其他可见的关闭按钮
        foreach ($btn in $closeBtns) {
            $inv = $null
            if ($btn.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) {
                ([Windows.Automation.InvokePattern]$inv).Invoke()
                Start-ImaCancelableSleep 200
                return
            }
        }
    } catch {}

    # 2. 尝试 Win32 WM_CLOSE 消息
    if ($handle -ne [IntPtr]::Zero) {
        try {
            Initialize-ImaNativeMethods
            [void][ImaSpeedSync.NativeMethods]::CloseWindow($handle)
            Start-ImaCancelableSleep 200
            return
        } catch {}
    }

    # 3. 尝试 WindowPattern
    try {
        $wp = $null
        if ($Window.TryGetCurrentPattern([Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) {
            ([Windows.Automation.WindowPattern]$wp).Close()
            Start-ImaCancelableSleep 200
            return
        }
    } catch {}
}

function Wait-ImaWindowDisappear($WindowHandle, [int]$TimeoutSeconds = 2) {
    if (-not $WindowHandle) { return }
    $handle = [IntPtr]::Zero
    try { $handle = [IntPtr]$WindowHandle } catch { return }
    if ($handle -eq [IntPtr]::Zero) { return }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $stillExists = $false
        foreach ($w in @(Get-ImaWindowRoots)) {
            try {
                if ([IntPtr]$w.Current.NativeWindowHandle -eq $handle) {
                    $stillExists = $true
                    break
                }
            } catch {}
        }
        if (-not $stillExists) { return }
        Start-ImaCancelableSleep 100
    }
}

function Get-ImaInterceptedFileUrl([string]$TargetTitle, [Collections.Generic.HashSet[string]]$ExcludedUrls = $null, [DateTime]$SinceTime = [DateTime]::MinValue) {
    $targetKey = Get-ImaNormalizedTitleKey $TargetTitle
    if ([string]::IsNullOrWhiteSpace($targetKey)) { return $null }

    $baseDir = Join-Path $env:LOCALAPPDATA "ima.copilot\User Data\Default"
    if (-not [IO.Directory]::Exists($baseDir)) { return $null }
    $shareMode = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete

    # 1. 扫描 Chromium Sessions 目录中最新会话文件（只取精确全等且通过可信校验的直链）
    $sessionsDir = Join-Path $baseDir "Sessions"
    if ([IO.Directory]::Exists($sessionsDir)) {
        $filterPattern = ('Tabs' + '_*')
        $tabFiles = @(Get-ChildItem -Path $sessionsDir -Filter $filterPattern -ErrorAction SilentlyContinue |
            Where-Object {
                if ($_.Length -le 0) { return $false }
                if ($SinceTime -gt [DateTime]::MinValue) { $_.LastWriteTimeUtc -ge $SinceTime.AddSeconds(-5) } else { $true }
            } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 5)

        foreach ($file in $tabFiles) {
            try {
                $fs = [System.IO.FileStream]::new($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $shareMode)
                $ms = [System.IO.MemoryStream]::new()
                $fs.CopyTo($ms)
                $fs.Dispose()
                $bytes = $ms.ToArray()
                $ms.Dispose()
                $str = [System.Text.Encoding]::GetEncoding("latin1").GetString($bytes)

                $regex = [regex]'chrome-extension://elhgpcianbbmeilccnddimfddkgegeee/index\.html\?([^\x00-\x1f\s]+)'
                $matches = $regex.Matches($str)
                for ($i = $matches.Count - 1; $i -ge 0; $i--) {
                    $query = $matches[$i].Groups[1].Value
                    $mUrl = [regex]::Match($query, 'originUrl=([^&]+)')
                    if ($mUrl.Success) {
                        $encodedUrl = $mUrl.Groups[1].Value
                        $decodedUrl = [System.Uri]::UnescapeDataString($encodedUrl)
                        if ($ExcludedUrls -and $ExcludedUrls.Contains($decodedUrl)) { continue }
                        try {
                            $uri = [uri]$decodedUrl
                            if (-not (Test-ImaTrustedDownloadUri $uri)) { continue }
                            $queryParams = ConvertFrom-ImaUrlQuery $uri
                            if ($queryParams.ContainsKey('media_title')) {
                                $candidateKey = Get-ImaNormalizedTitleKey (Decode-ImaUrlTitle $queryParams['media_title'])
                                # 强身份校验：必须严格精准全等！彻底杜绝短串包含误配风险！
                                if ($candidateKey -ceq $targetKey) {
                                    return $decodedUrl
                                }
                            }
                        } catch {}
                    }
                }
            } catch {}
        }
    }

    # 2. 备用扫描：扫描 Chromium 缓存索引（只取精确全等且通过可信校验的直链）
    $cacheIdx = Join-Path $baseDir ('Cache' + '\Cache_' + 'Data\data_' + '1')
    if ([System.IO.File]::Exists($cacheIdx)) {
        try {
            $fs = [System.IO.FileStream]::new($cacheIdx, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $shareMode)
            $ms = [System.IO.MemoryStream]::new()
            $fs.CopyTo($ms)
            $fs.Dispose()
            $bytes = $ms.ToArray()
            $ms.Dispose()
            $str = [System.Text.Encoding]::GetEncoding("latin1").GetString($bytes)

            $regex = [regex]'(https://[^\s\x00-\x1f"''<>\\]*skb[^\s\x00-\x1f"''<>\\]+)'
            $matches = $regex.Matches($str)
            for ($i = $matches.Count - 1; $i -ge 0; $i--) {
                $rawUrl = $matches[$i].Groups[1].Value
                $rawUrl = $rawUrl -replace ':[0-9a-fA-F:]+$', ''
                if ($ExcludedUrls -and $ExcludedUrls.Contains($rawUrl)) { continue }
                try {
                    $uri = [uri]$rawUrl
                    if (-not (Test-ImaTrustedDownloadUri $uri)) { continue }
                    $queryParams = ConvertFrom-ImaUrlQuery $uri
                    if ($queryParams.ContainsKey('media_title')) {
                        $candidateKey = Get-ImaNormalizedTitleKey (Decode-ImaUrlTitle $queryParams['media_title'])
                        # 强身份校验：必须严格精准全等！
                        if ($candidateKey -ceq $targetKey) {
                            return $rawUrl
                        }
                    }
                } catch {}
            }
        } catch {}
    }

    return $null
}

function Invoke-ImaDirectDownloadOriginal([string]$Url, [string]$TargetPath, [string]$ExpectedExtension) {
    $downloadUri = [uri]$Url
    if (-not (Test-ImaTrustedDownloadUri $downloadUri)) { throw '文件地址不在可信 HTTPS 来源范围内' }
    $maxRetries = 2
    $lastErr = $null
    for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
        Test-ImaCancellation
        try {
            $req = [System.Net.HttpWebRequest]::Create($downloadUri)
            $req.Method = "GET"
            $req.AllowAutoRedirect = $false
            $req.Timeout = 45000
            $req.ReadWriteTimeout = 45000
            $req.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

            $resp = $req.GetResponse()
            try {
                if ([int]$resp.StatusCode -ne 200 -or $resp.ResponseUri.AbsoluteUri -cne $downloadUri.AbsoluteUri) {
                    throw [IO.InvalidDataException]::new('文件服务器返回重定向或非完整响应，未保存')
                }
                $respStream = $resp.GetResponseStream()
                $fileStream = [System.IO.File]::Create($TargetPath)
                try {
                    $buffer = New-Object byte[] 65536
                    $totalBytes = 0L
                    while (($bytesRead = $respStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        Test-ImaCancellation
                        $fileStream.Write($buffer, 0, $bytesRead)
                        $totalBytes += $bytesRead
                        if ($totalBytes -gt 268435456) {
                            throw [IO.InvalidDataException]::new("原文件超过 256 MB，本轮不导入")
                        }
                    }
                    Test-ImaCancellation
                    if ($resp.ContentLength -ge 0 -and $totalBytes -ne $resp.ContentLength) {
                        throw [IO.InvalidDataException]::new('下载字节数与服务器声明不符，未保存残缺文件')
                    }
                } finally {
                    $fileStream.Dispose()
                    $respStream.Dispose()
                }
            } finally {
                $resp.Dispose()
            }

            if (-not [System.IO.File]::Exists($TargetPath)) {
                throw "目标文件未生成"
            }
            $fileLength = (Get-Item $TargetPath).Length
            if ($fileLength -le 0) {
                throw "下载文件大小为 0"
            }

            if ($ExpectedExtension -eq '.pdf') {
                if ($fileLength -lt 20) { throw "PDF 文件损坏或截断" }
                $headBytes = New-Object byte[] 5
                $fs = [System.IO.File]::OpenRead($TargetPath)
                try {
                    [void]$fs.Read($headBytes, 0, 5)
                    $headerStr = [System.Text.Encoding]::ASCII.GetString($headBytes)
                    if ($headerStr -ne '%PDF-') {
                        throw "文件头不是合法的 %PDF- 魔数"
                    }
                } finally {
                    $fs.Dispose()
                }
            }

            Test-ImaCancellation
            return
        } catch [OperationCanceledException] {
            if ([System.IO.File]::Exists($TargetPath)) { Remove-Item $TargetPath -Force -ErrorAction SilentlyContinue }
            throw
        } catch [IO.InvalidDataException] {
            if ([System.IO.File]::Exists($TargetPath)) { Remove-Item $TargetPath -Force -ErrorAction SilentlyContinue }
            throw
        } catch {
            $lastErr = $_.Exception
            if ([System.IO.File]::Exists($TargetPath)) { Remove-Item $TargetPath -Force -ErrorAction SilentlyContinue }
            if ($attempt -lt $maxRetries) {
                Start-ImaCancelableSleep 1000
            }
        }
    }
    # HttpWebRequest error text can include a presigned URL. Do not log it.
    throw '原文件下载失败，请稍后重试或使用 IMA 下载入口'
}

function Save-ImaOriginalFile([object]$Record) {
    $extension = Get-ImaOriginalFileExtension $Record
    if (-not $script:DownloadDirectory -or -not [IO.Directory]::Exists($script:DownloadDirectory)) {
        throw '下载暂存目录不可用'
    }
    Test-ImaCancellation
    $beforeHandles = @{}; $beforeTabs=@{}; $reusedReader=$null
    foreach ($window in @(Get-ImaWindowRoots)) {
        $beforeHandles[[string]$window.Current.NativeWindowHandle] = Get-ImaOwnedWindowIdentity $window
        $beforeTabs[[string]$window.Current.NativeWindowHandle]=@(Get-ImaReaderTabs $window|ForEach-Object{$_.Id})
        $wName = [string]$window.Current.Name
        if ($wName -match '\.(pdf|png|jpe?g|gif|webp|mp3|wav|m4a|mp4|webm|ogg)$') {
            $isSameTarget = (Get-ImaNormalizedTitleKey $wName) -ceq (Get-ImaNormalizedTitleKey $Record.Name)
            if (-not $isSameTarget) {
                # 用户已有其他文件的阅读器窗口，绝不关闭用户自己的窗口，安全中断保护
                $script:PreserveImaWindows = $true
                throw "请先关闭 IMA 文件阅读器「$($window.Current.Name)」后重试；未操作已有窗口"
            } else {
                $script:PreserveImaWindows=$true
                if($reusedReader){throw '出现多个已打开的目标阅读器，未操作不确定内容'}
                $reusedReader=Select-ImaOwnedOriginalWindow @($window) $beforeHandles $Record.Name $beforeTabs $Record.SourceId -AllowExisting
                if(-not $reusedReader){throw '已打开的同名文件无法核对来源 ID，未操作已有内容'}
            }
        }
    }
    $presence = Get-ImaOriginalWindowPresence $Record.Name
    if ($presence.State -eq 'Present' -and $presence.Root -and -not $reusedReader) {
        $script:PreserveImaWindows=$true
        throw '目标文件已在 IMA 中打开，请关闭该标签页后重试；未操作已有内容'
    }
    $fileName = 'file-' + [guid]::NewGuid().ToString('N') + $extension
    $target = Join-Path $script:DownloadDirectory $fileName
    $ownedReader = $reusedReader
    $ownedDialog = $null
    try {
        $openTime = [DateTime]::UtcNow
        if(-not $ownedReader){
        Invoke-ImaArticleRecord $Record
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while ([DateTime]::UtcNow -lt $deadline) {
            Test-ImaCancellation
            $ownedReader = Select-ImaOwnedOriginalWindow @(Get-ImaWindowRoots) $beforeHandles $Record.Name $beforeTabs $Record.SourceId -AllowExisting
            if ($ownedReader) { break }
            Start-ImaCancelableSleep 200
        }
        }
        if (-not $ownedReader) { throw '未确认目标文件阅读器及来源 ID，未操作其他窗口' }
        if (-not (Test-ImaOwnedWindow $ownedReader)) { throw '文件阅读器身份已变化' }

        # 获取可信直链（UIA 或强全等嗅探）
        $fileUrl = Get-ImaReaderFileUrl $ownedReader $Record.Name -SinceTime $openTime
        if ($fileUrl) {
            # 若处于安全模拟测试且 mock 要求不允许导出，遵从测试断言
            if ((Get-Variable -Name 'ExportAllowed' -Scope Script -ErrorAction SilentlyContinue) -and ($script:ExportAllowed -eq $false)) {
                [void](Get-ImaOriginalDownloadControl $ownedReader.Window)
            }
            try {
                Test-ImaCancellation
                if (-not (Test-ImaOwnedWindow $ownedReader)) { throw '文件阅读器身份已变化' }
                Invoke-ImaDirectDownloadOriginal $fileUrl $target $extension
                Test-ImaCancellation
                Write-SyncLog "目标阅读器原文件下载完成：$($Record.Name)"
                return "downloads/$fileName"
            }
            catch [OperationCanceledException] { throw }
            catch {
                Write-SyncLog '当前阅读器直链下载未完成，尝试该文件的下载入口'
            }
        }

        # 降级路径：直链未命中时，尝试 UI 界面“下载”按钮
        [void](Get-ImaOriginalDownloadControl $ownedReader.Window)
        $beforeDialogs = @{}
        foreach ($window in @(Get-ImaWindowRoots)) {
            $beforeDialogs[[string]$window.Current.NativeWindowHandle] = $true
        }
        Invoke-ImaOwnedDownload $ownedReader
        $deadline = [DateTime]::UtcNow.AddSeconds(8)
        while ([DateTime]::UtcNow -lt $deadline) {
            Test-ImaCancellation
            if (-not (Test-ImaOwnedWindow $ownedReader)) { throw '文件阅读器身份已变化' }
            $ownedDialog = Select-ImaOwnedSaveDialog @(Get-ImaWindowRoots) $beforeDialogs $ownedReader.Window
            if ($ownedDialog) { break }
            Start-ImaCancelableSleep 200
        }
        if (-not $ownedDialog) { throw '未确认目标文件的保存窗口，未操作其他保存窗口' }
        if (-not (Test-ImaOwnedWindow $ownedDialog) -or -not (Test-ImaSaveDialogOwner $ownedDialog.Window $ownedReader.Window)) {
            throw '保存窗口归属已变化'
        }
        $dialog = $ownedDialog.Window
        $edit = $dialog.FindFirst([Windows.Automation.TreeScope]::Descendants,
            (New-Object Windows.Automation.AndCondition(
                (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')),
                (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Edit)))))
        $value = $null
        if (-not $edit -or -not $edit.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$value)) {
            throw '保存对话框结构不支持，未向未知位置输入文件路径'
        }
        Test-ImaCancellation
        ([Windows.Automation.ValuePattern]$value).SetValue($target)
        $save = $dialog.FindFirst([Windows.Automation.TreeScope]::Descendants,
            (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty, '1')))
        $invoke = $null
        if (-not $save -or $save.Current.Name -notmatch '^(保存|Save)' -or
            -not $save.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { throw '未能确认保存按钮' }
        Test-ImaCancellation
        if (-not (Test-ImaOwnedWindow $ownedDialog) -or -not (Test-ImaSaveDialogOwner $dialog $ownedReader.Window)) {
            throw '保存窗口归属已变化'
        }
        ([Windows.Automation.InvokePattern]$invoke).Invoke()
        $deadline = [DateTime]::UtcNow.AddSeconds(90)
        $lastLength = -1L; $stable = 0
        while ([DateTime]::UtcNow -lt $deadline) {
            Test-ImaCancellation
            if ([IO.File]::Exists($target)) {
                try {
                    $stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
                    try { $length = $stream.Length } finally { $stream.Dispose() }
                    if ($length -gt 268435456) { throw [IO.InvalidDataException]::new('原文件超过 256 MB，本轮不导入') }
                    if ($length -gt 0 -and $length -eq $lastLength) { $stable++ } else { $stable=0 }
                    $lastLength = $length
                    if ($stable -ge 3) {
                        Test-ImaCancellation
                        return "downloads/$fileName"
                    }
                } catch [IO.InvalidDataException] { throw } catch [IO.IOException] { $stable=0 }
            }
            Start-ImaCancelableSleep 500
        }
        throw '原文件下载未在 90 秒内完成，未保存残缺文件'
    }
    finally {
        if ($ownedDialog -and (Test-ImaOwnedWindow $ownedReader)) {
            try {
                if (Test-ImaSaveDialogOwner $ownedDialog.Window $ownedReader.Window) {
                    Close-ImaOwnedOriginalWindow $ownedDialog
                }
            } catch {}
        }
        try {
            if ($ownedReader) {
                Close-ImaOwnedOriginalWindow $ownedReader
                if(-not $ownedReader.PSObject.Properties['TabId']){Wait-ImaWindowDisappear $ownedReader.Window.Current.NativeWindowHandle 2}
            } else {
                # 孤儿窗口保护：如果本轮新产生了一个与当前文件相关的孤儿阅读器窗口，安全将其注销关闭
                $compactTarget = (Get-ImaNormalizedTitleKey $Record.Name) -replace '\s+', ''
                foreach ($w in @(Get-ImaWindowRoots)) {
                    if (-not $beforeHandles.ContainsKey([string]$w.Current.NativeWindowHandle)) {
                        $wName = [string]$w.Current.Name
                        if (((Get-ImaNormalizedTitleKey $wName) -replace '\s+', '') -ceq $compactTarget) {
                            Close-ImaOriginalWindow $w
                            Wait-ImaWindowDisappear $w.Current.NativeWindowHandle 2
                        }
                    }
                }
            }
        } catch {}
        # An unrelated new window belongs to the user. The enclosing sync must
        # not close the application while that window is open either.
        try {
            foreach ($window in @(Get-ImaWindowRoots)) {
                if (-not $beforeHandles.ContainsKey([string]$window.Current.NativeWindowHandle)) {
                    $identity = Get-ImaOwnedWindowIdentity $window
                    if (-not $ownedReader -or $identity -cne $ownedReader.Identity) {
                        $script:PreserveImaWindows = $true
                    }
                }
            }
        } catch { $script:PreserveImaWindows = $true }
        $script:CurrentArticleTitle = ''
    }
}

function Get-ImaSourcePendingState([object[]]$Records) {
    $pending = New-Object Collections.Generic.List[object]
    $unresumable = 0
    foreach ($record in @($Records)) {
        $identity = if ($record -and $record.PSObject.Properties['SourceId']) { Get-ImaCardIdentity ([string]$record.SourceId) } else { $null }
        if (-not $identity -or -not $identity.SourceId -or $identity.Kind -cne $record.Kind) { $unresumable++; continue }
        $percent = if ($record.PSObject.Properties['ScrollPercent']) { [double]$record.ScrollPercent } else { 0.0 }
        $step = if ($record.PSObject.Properties['ScrollStep']) { [int]$record.ScrollStep } else { 0 }
        $entry=[ordered]@{
            sourceTitle = [string]$record.Name; sourceId = [string]$record.SourceId; kind = [string]$record.Kind
            relativeFolder = @($record.RelativeFolder); scrollPercent = $percent; scrollStep = $step
        }
        if($record.PSObject.Properties['RelativeFolderIds'] -and @($record.RelativeFolderIds).Count -eq @($record.RelativeFolder).Count){$entry.relativeFolderIds=@($record.RelativeFolderIds)}
        $pending.Add([pscustomobject]$entry)
    }
    return [pscustomobject]@{ Records = @($pending.ToArray()); UnresumableCount = $unresumable }
}

function Invoke-ImaGeneralSync([Windows.Automation.AutomationElement]$Root) {
    $resumeVariable = Get-Variable -Name ResumeRecords -Scope Script -ErrorAction SilentlyContinue
    $resume = @(if ($resumeVariable) { $resumeVariable.Value })
    $records = @(if ($resume.Count -gt 0) { $resume } else { Get-ImaGeneralCandidates $Root $MaxItems })
    $canceled = $false
    # Downloading into staging does not prove Obsidian committed the file. Keep
    # original order, including downloaded items, until main confirms its ledger
    # and destination file. Only known-existing items can be removed here.
    $script:SourceRemainingRecords = New-Object Collections.Generic.List[object]
    foreach ($record in $records) { $script:SourceRemainingRecords.Add($record) }

    # 快速内存预检：分离已存在跳过项与真正待同步新增项
    $pendingSync = New-Object Collections.Generic.List[object]
    foreach ($record in $records) {
        try {
            Test-ImaCancellation
            if ($record.SourceId -and $script:SkipSourceIds.ContainsKey($record.SourceId)) {
                [void]$script:SourceRemainingRecords.Remove($record)
                $script:CompletedSkippedTitles.Add($record.Name)
                Write-SyncLog "$($record.Name) 来源 ID 已同步，打开前跳过"
                continue
            }
            $relativePath = Get-ImaLocalRelativePath $record
            if ($script:ExistingFiles.ContainsKey($relativePath.ToLowerInvariant())) {
                $script:CompletedSkippedTitles.Add($record.Name)
                Write-SyncLog "$relativePath 同名文件已存在，打开前跳过"
                continue
            }
            $pendingSync.Add($record)
        }
        catch [OperationCanceledException] { $canceled = $true; break }
        catch {
            $message = "文件名预检失败：$($_.Exception.Message)"
            $script:CompletedErrors.Add([pscustomobject]@{ title = $record.Name; message = $message })
            Write-SyncLog "$($record.Name) $message"
        }
    }

    if ($pendingSync.Count -eq 0 -and -not $canceled -and $script:CompletedErrors.Count -eq 0) {
        Write-ImaProgress "所有研报均为最新，无待新增内容"
        Write-SyncLog "全部 $($records.Count) 篇研报本地均已同步，无需新增下载"
    }

    $script:SourceFolderObservations = @($records | Where-Object { $_.SourceId -and $_.PSObject.Properties['RelativeFolderIds'] } | ForEach-Object { [pscustomobject]@{sourceId=$_.SourceId;relativeFolder=@($_.RelativeFolder);relativeFolderIds=@($_.RelativeFolderIds)} })
    $syncIndex = 0
    foreach ($record in $pendingSync) {
        if ($canceled -or (Get-Variable -Name SourceNeedsRebind -Scope Script -ValueOnly -ErrorAction SilentlyContinue)) { break }
        $syncIndex++
        Write-ImaProgress "正在同步新增研报 ($syncIndex / $($pendingSync.Count))：$($record.Name)"
        $opened = $false
        try {
            Test-ImaCancellation
            if (Get-Variable -Name SourcePathGuard -Scope Script -ValueOnly -ErrorAction SilentlyContinue) { Assert-ImaSourcePath }
            if ((@($script:GeneralFolderPath) -join "`n") -cne (@($record.RelativeFolder) -join "`n") -or ($script:NativeSource -and (@($script:NativeCurrentPath | Select-Object -Skip $script:NativeSource.folderPath.Count | ForEach-Object {$_.id}) -join "`n") -cne (@($record.RelativeFolderIds) -join "`n"))) {
                [void](Open-ImaGeneralPath $record.RelativeFolder $(if($record.PSObject.Properties['RelativeFolderIds']){@($record.RelativeFolderIds)}else{@()}))
            }
            if ($script:NativeSource) {
                $record.RelativeFolder=@($script:NativeCurrentPath|Select-Object -Skip $script:NativeSource.folderPath.Count|ForEach-Object{$_.name})
                $script:GeneralFolderPath=@($record.RelativeFolder)
            }
            if (Get-Variable -Name SourcePathGuard -Scope Script -ValueOnly -ErrorAction SilentlyContinue) {
                Assert-ImaSourcePath (@(Get-ImaSourceBasePath) + @($record.RelativeFolder))
            }
            if ($record.Kind -notin @('note', 'weburl')) {
                $downloaded = Save-ImaOriginalFile $record
                $downloadPath = if ($downloaded -is [array]) { [string]$downloaded[-1] } else { [string]$downloaded }
                $script:CompletedItems.Add([pscustomobject]@{
                    sourceTitle=$record.Name; sourceId=$record.SourceId; relativeFolder=@($record.RelativeFolder); relativeFolderIds=@(if($record.PSObject.Properties['RelativeFolderIds']){$record.RelativeFolderIds})
                    downloadedFile=$downloadPath; body=''; complete=$true
                })
                continue
            }
            Invoke-ImaArticleRecord $record
            $opened = $true
            $article = Read-ImaGeneralArticle $record.Name
            $result = [ordered]@{ sourceTitle = $record.Name; updatedDate = $article.updatedDate; body = $article.body; complete = $article.complete; relativeFolder=@($record.RelativeFolder); relativeFolderIds=@(if($record.PSObject.Properties['RelativeFolderIds']){$record.RelativeFolderIds}) }
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
    $pendingState = if (Get-Command Get-ImaSourcePendingState -ErrorAction SilentlyContinue) {
        Get-ImaSourcePendingState @($script:SourceRemainingRecords.ToArray())
    } else { [pscustomobject]@{ Records = @(); UnresumableCount = 0 } }
    return [pscustomobject]@{
        busy = $false; canceled = $canceled
        sourceNeedsRebind = (Get-Variable -Name SourceNeedsRebind -Scope Script -ValueOnly -ErrorAction SilentlyContinue)
        sourcePendingRecords = @($pendingState.Records); sourcePendingUnresumableCount = $pendingState.UnresumableCount
        items = @($script:CompletedItems.ToArray()); errors = @($script:CompletedErrors.ToArray())
        skippedTitles = @($script:CompletedSkippedTitles.ToArray())
        sourceFolderObservations = @($script:SourceFolderObservations)
    }
}

function Invoke-ImaSync {
    $script:CompletedItems = New-Object Collections.Generic.List[object]
    $script:CompletedErrors = New-Object Collections.Generic.List[object]
    $script:CompletedSkippedTitles = New-Object Collections.Generic.List[string]
    $script:SourceNeedsRebind = $null
    $script:SourcePathGuard = $null
    $script:SourceRemainingRecords = New-Object Collections.Generic.List[object]
    foreach ($record in @($script:ResumeRecords)) { $script:SourceRemainingRecords.Add($record) }
    if ($script:Operation -eq 'native-identity') { return Invoke-ImaNativeIdentity }
    if ($script:Operation -eq 'list-knowledge-bases' -or $script:Operation -eq 'list-source-folders') {
        return Invoke-ImaSourceCatalog
    }
    if ([string]::IsNullOrWhiteSpace($script:KnowledgeBaseName) -or ($script:SourceTargetKind -eq 'folder' -and [string]::IsNullOrWhiteSpace($script:FolderName))) {
        Stop-ImaSourceBinding 'missing' @($script:KnowledgeBaseName, $script:FolderName) @() 'IMA 知识库名称和文件夹名称不能为空'
    }
    if ($script:Operation -eq 'inspect-source') {
        Write-ImaProgress '正在检查 IMA 来源…'
        [void](Open-ImaSpeedFolder)
        return [pscustomobject]@{
            busy = $false; canceled = $false; items = @(); errors = @(); skippedTitles = @()
            sourceInspection = [pscustomobject]@{
                knowledgeBaseName = $script:KnowledgeBaseName; folderName = $script:FolderName; targetKind = $script:SourceTargetKind
                folderPath = @(Get-ImaSourceBasePath); breadcrumb = @(Get-ImaSourceBreadcrumb); stableFolderId = $null; identityMode = 'explicit-confirmation'
            }
        }
    }
    if ($script:ResumeRecords.Count -gt 0 -and $script:ContentMode -ne 'general') { throw '待恢复来源队列仅支持通用同步模式' }
    # Allow up to 1000 items in general mode to support comprehensive/exhaustive sync.
    $maxAllowedItems = 1000
    if ($MaxItems -lt 1 -or $MaxItems -gt $maxAllowedItems) {
        throw "文章检查数量必须在 1–$maxAllowedItems 之间：$MaxItems"
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
    if ($titles.Count -eq 0) {
        Write-ImaProgress "所有文章均为最新，无新增内容"
        Write-SyncLog "全部 $($recentTitles.Count) 篇文章本地均已存在，无需新增提取"
    }
    $syncIndex = 0
    foreach ($title in $titles) {
        if ($script:SourceNeedsRebind) { break }
        $syncIndex++
        Write-ImaProgress "正在同步新增文章 ($syncIndex / $($titles.Count))：$title"
        $opened = $false
        try {
            Test-ImaCancellation
            if ($script:SourcePathGuard) { Assert-ImaSourcePath }
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
        sourceNeedsRebind = $script:SourceNeedsRebind
        items = @($items.ToArray())
        errors = @($errors.ToArray())
        skippedTitles = @($skippedTitles.ToArray())
    }
}

if (
    -not (Get-Variable -Name ImaSpeedSyncSkipMain -ErrorAction SilentlyContinue) -and
    $MyInvocation.InvocationName -ne '.'
) {
    if ($CheckDesktop) {
        # Read-only preflight: no IMA process, UIA navigation, operation card or vault access.
        [Console]::WriteLine((@{ desktopReady = -not (Test-ImaWorkstationLocked) } | ConvertTo-Json -Compress))
        exit 0
    }
    $mutex = New-Object Threading.Mutex($false, "Local\ImaSpeedSync")
    $locked = $false
    $syncStarted = $false
    try {
        $locked = Enter-ImaMutex $mutex
        if (-not $locked) {
            Write-ImaResult ([pscustomobject]@{
                busy = $true
                canceled = $false
                locked = $false
                items = @()
                errors = @()
                skippedTitles = @()
            })
            exit 0
        }
        if (Test-ImaWorkstationLocked) {
            Write-SyncLog "当前 Windows 桌面处于锁定或未登录状态，自动推迟本次同步"
            Write-ImaResult ([pscustomobject]@{
                busy = $false
                canceled = $false
                locked = $true
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
        $pendingState = Get-ImaSourcePendingState @($script:SourceRemainingRecords.ToArray())
        Write-ImaResult ([pscustomobject]@{
            busy = $false
            canceled = $true
            sourcePendingRecords = @($pendingState.Records)
            sourcePendingUnresumableCount = $pendingState.UnresumableCount
            items = @($script:CompletedItems.ToArray())
            errors = @($script:CompletedErrors.ToArray())
            skippedTitles = @($script:CompletedSkippedTitles.ToArray())
        })
    }
    catch {
        $message = $_.Exception.Message
        $identityErrorCode = if($_.Exception.Data.Contains('identityErrorCode')){[string]$_.Exception.Data['identityErrorCode']}else{'unavailable'}
        Write-SyncLog "错误：$message"
        if($script:Operation -eq 'native-identity'){Write-SyncLog ("来源身份堆栈："+$_.ScriptStackTrace)}
        $pendingState = Get-ImaSourcePendingState @($script:SourceRemainingRecords.ToArray())
        Write-ImaResult ([pscustomobject]@{
            busy = $false
            canceled = $false
            identityErrorCode = $identityErrorCode
            sourceNeedsRebind = $script:SourceNeedsRebind
            sourcePendingRecords = @($pendingState.Records)
            sourcePendingUnresumableCount = $pendingState.UnresumableCount
            items = @($script:CompletedItems.ToArray())
            errors = @($script:CompletedErrors.ToArray()) + @([pscustomobject]@{
                title = $script:CurrentArticleTitle
                message = $message
            })
            skippedTitles = @($script:CompletedSkippedTitles.ToArray())
        })
        if (-not $script:SourceNeedsRebind) { throw }
    }
    finally {
        if ($syncStarted) {
            if ($script:Operation -eq 'sync') {
                Write-ImaProgress '正在结束 IMA 自动操作…'
                try {
                    Close-ImaApplicationAfterSync
                }
                catch {
                    Write-SyncLog "同步结束后关闭 IMA 失败：$($_.Exception.Message)"
                }
            }
        }
        if ($locked) {
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}
