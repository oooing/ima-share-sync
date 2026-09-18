param([string]$StatePath, [int]$OwnerProcessId, [string]$PreviewPath = "", [switch]$SmokeTest)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
if ($SmokeTest) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CardFocusProbe { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
}

[xml]$layout = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="IMA Share Sync · 桌面操作提示" Width="340" SizeToContent="Height"
        WindowStyle="None" ResizeMode="NoResize" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" ShowActivated="False" Topmost="True" FontFamily="Microsoft YaHei UI">
  <Border Background="#242329" BorderBrush="#55515F" BorderThickness="1" CornerRadius="12" Padding="16">
    <StackPanel>
      <StackPanel Orientation="Horizontal">
        <!-- Same simplified panda/book geometry as src/icon.ts; no external image dependency. -->
        <Viewbox x:Name="BrandIcon" Width="20" Height="20" Margin="0,0,8,0">
          <Canvas Width="256" Height="256">
            <Canvas.Resources>
              <Style TargetType="Path">
                <Setter Property="Stroke" Value="#C8ACFF"/>
                <Setter Property="StrokeThickness" Value="14.933333333333332"/>
                <Setter Property="StrokeStartLineCap" Value="Round"/>
                <Setter Property="StrokeEndLineCap" Value="Round"/>
                <Setter Property="StrokeLineJoin" Value="Round"/>
              </Style>
            </Canvas.Resources>
            <Path Data="M45 160V61.67A40.67 40.67 0 0 1 85.67 21H170.33A40.67 40.67 0 0 1 211 61.67V160"/>
            <Path StrokeThickness="10.666666666666666">
              <Path.Data>
                <GeometryGroup>
                  <EllipseGeometry Center="67.41,47.97" RadiusX="14.77" RadiusY="24.36"><EllipseGeometry.Transform><RotateTransform Angle="36" CenterX="67.41" CenterY="47.97"/></EllipseGeometry.Transform></EllipseGeometry>
                  <EllipseGeometry Center="188.59,47.97" RadiusX="14.77" RadiusY="24.36"><EllipseGeometry.Transform><RotateTransform Angle="-36" CenterX="188.59" CenterY="47.97"/></EllipseGeometry.Transform></EllipseGeometry>
                  <EllipseGeometry Center="96.46,110.61" RadiusX="16.6" RadiusY="24.36"><EllipseGeometry.Transform><RotateTransform Angle="36" CenterX="96.46" CenterY="110.61"/></EllipseGeometry.Transform></EllipseGeometry>
                  <EllipseGeometry Center="159.54,110.61" RadiusX="16.6" RadiusY="24.36"><EllipseGeometry.Transform><RotateTransform Angle="-36" CenterX="159.54" CenterY="110.61"/></EllipseGeometry.Transform></EllipseGeometry>
                </GeometryGroup>
              </Path.Data>
            </Path>
            <Path Fill="#C8ACFF" StrokeThickness="0"><Path.Data><EllipseGeometry Center="128,131.49" RadiusX="9.13" RadiusY="6.79"/></Path.Data></Path>
            <Path Data="M24 161C65 158 102 169 128 188C154 169 191 158 232 161V218C191 216 154 225 128 241C102 225 65 216 24 218Z"/>
            <Path Data="M128 188V241" StrokeThickness="10.666666666666666"/>
          </Canvas>
        </Viewbox>
        <TextBlock Text="IMA Share Sync" Foreground="#C8ACFF" FontSize="12" FontWeight="SemiBold" VerticalAlignment="Center"/>
      </StackPanel>
      <TextBlock x:Name="Heading" Text="即将自动同步" Foreground="#FFFFFF" FontSize="16" FontWeight="SemiBold" Margin="0,8,0,8"/>
      <TextBlock x:Name="Body" TextWrapping="Wrap" TextTrimming="CharacterEllipsis" MaxHeight="63" Foreground="#DDD9E5" FontSize="13" LineHeight="21"/>
      <TextBlock x:Name="Hint" TextWrapping="Wrap" Foreground="#AAA4B5" FontSize="12" Margin="0,10,0,0"/>
      <ScrollViewer x:Name="DetailsBox" Visibility="Collapsed" MaxHeight="120" VerticalScrollBarVisibility="Auto" Margin="0,12,0,0">
        <TextBlock x:Name="DetailsText" TextWrapping="Wrap" Foreground="#DDD9E5" FontSize="12" LineHeight="20"/>
      </ScrollViewer>
      <WrapPanel Margin="0,16,0,0">
        <WrapPanel.Resources>
          <Style TargetType="Button">
            <Setter Property="Padding" Value="12,7"/>
            <Setter Property="Margin" Value="0,0,8,4"/>
            <Setter Property="FontSize" Value="12"/>
            <Setter Property="Cursor" Value="Hand"/>
            <Setter Property="Background" Value="#E2D4FF"/>
            <Setter Property="Foreground" Value="#242329"/>
            <Setter Property="BorderThickness" Value="0"/>
          </Style>
        </WrapPanel.Resources>
        <Button x:Name="Start" Content="立即开始"/>
        <Button x:Name="Later" Content="5 分钟后"/>
        <Button x:Name="Cancel" Content="取消"/>
        <Button x:Name="Stop" Content="停止" Visibility="Collapsed"/>
        <Button x:Name="Details" Content="查看记录" Visibility="Collapsed"/>
        <Button x:Name="Dismiss" Content="关闭" Visibility="Collapsed"/>
      </WrapPanel>
    </StackPanel>
  </Border>
</Window>
'@
$window = [Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $layout))
$controls = @{}
foreach ($name in @('Heading','Body','Hint','Start','Later','Cancel','Stop','Details','Dismiss','DetailsBox','DetailsText')) { $controls[$name] = $window.FindName($name) }
$script:phase = ''
$script:decided = $false
$script:deadline = [DateTime]::UtcNow.AddSeconds(5)
$script:closeAt = [DateTime]::MaxValue
$script:lastState = ''

function Send-CardCommand([string]$Command) { [Console]::WriteLine($Command); [Console]::Out.Flush() }
function Set-CardState([string]$Phase, [string]$Text) {
    if ($script:phase -ne $Phase) {
        $controls.DetailsBox.Visibility = 'Collapsed'
        $controls.Details.Content = '查看原因'
        $script:closeAt = [DateTime]::MaxValue
    }
    $script:phase = $Phase
    foreach ($name in @('Start','Later','Cancel','Stop','Details','Dismiss')) { $controls[$name].Visibility = 'Collapsed' }
    $controls.Body.Text = $Text
    $controls.Heading.Foreground = [Windows.Media.Brushes]::White
    $controls.Hint.Text = ''
    switch ($Phase) {
        'before' {
            $controls.Heading.Text = '即将自动同步'
            $controls.Hint.Text = '5 秒后开始'
            foreach ($name in @('Start','Later','Cancel')) { $controls[$name].Visibility = 'Visible' }
        }
        'running' {
            $controls.Heading.Text = '正在同步'
            $controls.Hint.Text = '正在操作 IMA，可随时停止。'
            $controls.Stop.Visibility = 'Visible'
            $controls.Stop.IsEnabled = $true
        }
        'stopping' {
            $controls.Heading.Text = '正在停止…'
            $controls.Stop.Visibility = 'Visible'
            $controls.Stop.IsEnabled = $false
        }
        { $_ -in @('success','canceled','failed') } {
            $controls.Heading.Text = switch ($Phase) { 'canceled' { '同步已停止' } 'failed' { '同步有异常' } default { '同步完成' } }
            $controls.Dismiss.Visibility = 'Visible'
            if ($Phase -eq 'failed') {
                $controls.Heading.Foreground = [Windows.Media.Brushes]::Gold
                $controls.Details.Visibility = 'Visible'
                $controls.Details.Content = '查看原因'
            } else {
                $script:closeAt = [DateTime]::UtcNow.AddSeconds(5)
                $controls.Hint.Text = '5 秒后关闭'
            }
        }
        'close' { $window.Close() }
    }
    $controls.Hint.Visibility = if ($controls.Hint.Text) { 'Visible' } else { 'Collapsed' }
}
function Start-CardOperation {
    if ($script:decided) { return }
    $script:decided = $true
    Set-CardState 'running' '正在准备同步…'
    Send-CardCommand 'start'
}
$controls.Start.Add_Click({ Start-CardOperation })
$controls.Later.Add_Click({ if (-not $script:decided) { $script:decided = $true; Send-CardCommand 'later'; $window.Close() } })
$controls.Cancel.Add_Click({ if (-not $script:decided) { $script:decided = $true; Send-CardCommand 'cancel'; $window.Close() } })
$controls.Stop.Add_Click({ Set-CardState 'stopping' '已保存内容会保留。'; Send-CardCommand 'stop' })
$controls.Details.Add_Click({
    # Show this run's details here; Obsidian may be minimized or behind another app.
    $script:closeAt = [DateTime]::MaxValue
    $controls.DetailsBox.Visibility = if ($controls.DetailsBox.Visibility -eq 'Visible') { 'Collapsed' } else { 'Visible' }
    $controls.Details.Content = if ($controls.DetailsBox.Visibility -eq 'Visible') { '收起原因' } else { '查看原因' }
    if ($controls.DetailsBox.Visibility -eq 'Visible') { Send-CardCommand 'details' }
})
$controls.Dismiss.Add_Click({ $window.Close() })
$window.Add_Closing({ param($sender, $eventArgs)
    if ($script:phase -in @('running','stopping')) {
        $eventArgs.Cancel = $true
        if ($script:phase -ne 'stopping') { Set-CardState 'stopping' '正在结束本次同步…'; Send-CardCommand 'stop' }
    }
})

function Read-CardState {
    try {
        $stream = [IO.FileStream]::new($StatePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
        try { $raw = $reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($raw -eq $script:lastState) { return }
        $state = $raw | ConvertFrom-Json
        # Once stop is pressed, stale progress must not revert the stopping state.
        if ($script:phase -eq 'stopping' -and $state.phase -eq 'running') { return }
        Set-CardState ([string]$state.phase) ([string]$state.text)
        $controls.DetailsText.Text = if ($state.PSObject.Properties['details']) { [string]$state.details } else { [string]$state.text }
        $script:lastState = $raw
    } catch { } # Atomic replacement may briefly contend on Windows; retry next tick.
}
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(200)
$timer.Add_Tick({
    if (-not (Get-Process -Id $OwnerProcessId -ErrorAction SilentlyContinue)) { $script:phase = 'close'; $window.Close(); return }
    Read-CardState
    if ($script:phase -eq 'before' -and -not $script:decided) {
        $seconds = [Math]::Max(0, [Math]::Ceiling(($script:deadline - [DateTime]::UtcNow).TotalSeconds))
        $controls.Hint.Text = "$seconds 秒后开始"
        if ($seconds -le 0) { Start-CardOperation }
    }
    if ([DateTime]::UtcNow -ge $script:closeAt) { $window.Close() }
})
$window.Add_SizeChanged({
    $area = [Windows.SystemParameters]::WorkArea
    $window.Left = [Math]::Max($area.Left, $area.Right - $window.ActualWidth - 20)
    $window.Top = [Math]::Max($area.Top, $area.Bottom - $window.ActualHeight - 20)
})
$window.Add_ContentRendered({
    if ($SmokeTest) {
        $ownHandle = [Windows.Interop.WindowInteropHelper]::new($window).Handle
        Send-CardCommand $(if ([CardFocusProbe]::GetForegroundWindow() -ne $ownHandle) { 'nonactivating' } else { 'focus-stolen' })
    }
    $script:deadline = [DateTime]::UtcNow.AddSeconds(5)
    Send-CardCommand 'ready'
    if ($script:phase -eq 'running') { Start-CardOperation }
    $timer.Start()
})
Read-CardState
if (-not $PreviewPath -and -not $script:phase) { throw '无法读取桌面卡片状态，未启动自动操作。' }
if ($PreviewPath) {
    $brandIcon = $window.FindName('BrandIcon')
    if (-not $brandIcon -or $brandIcon.Width -ne 20 -or $brandIcon.Child.Children.Count -ne 5) { throw 'Shared panda brand icon missing' }
    # Render the actual WPF control tree off-screen; never launch IMA or move focus.
    foreach ($previewPhase in @('before','running','stopping','success','failed','failed-details')) {
        $previewText = switch ($previewPhase) {
            'before' { '将操作 IMA，保存分享文章。' }
            'running' { '正在检查第 3 / 7 篇文章：全球八大投行每日速看' }
            'stopping' { '已保存内容会保留。' }
            'success' { '新增 1 篇 · 跳过 6 篇' }
            'failed' { '跳过 6 篇 · 失败 1 篇' }
            'failed-details' { '跳过 6 篇 · 失败 1 篇' }
        }
        Set-CardState $(if ($previewPhase -eq 'failed-details') { 'failed' } else { $previewPhase }) $previewText
        if ($previewPhase -eq 'failed') {
            if ($controls.DetailsBox.Visibility -ne 'Collapsed') { throw 'Failure details must be collapsed initially' }
        }
        if ($previewPhase -eq 'failed-details') {
            $controls.DetailsText.Text = '速看-0913：正文未读取完整，请重试。'
            $controls.Details.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
        }
        $root = $window.Content
        $root.Measure([Windows.Size]::new(340, [double]::PositiveInfinity))
        $root.Arrange([Windows.Rect]::new(0, 0, 340, $root.DesiredSize.Height))
        $root.UpdateLayout()
        $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new(340, [int][Math]::Ceiling($root.ActualHeight), 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
        $bitmap.Render($root)
        $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
        $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
        $stream = [IO.File]::Create((Join-Path $PreviewPath "$previewPhase.png"))
        try { $encoder.Save($stream) } finally { $stream.Dispose() }
    }
    if ($controls.Details.Content -ne '收起原因') { throw 'Expanded failure action missing' }
    if ($controls.DetailsBox.Visibility -ne 'Visible' -or $script:closeAt -ne [DateTime]::MaxValue) { throw 'Inline details must remain visible without activating Obsidian' }
    if ($window.ShowActivated -or -not $window.Topmost -or $window.ShowInTaskbar) { throw 'Non-activating window policy failed' }
    Set-CardState 'running' 'test'
    if ($controls.DetailsBox.Visibility -ne 'Collapsed') { throw 'Old details must collapse for a new phase' }
    $controls.Stop.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.Button]::ClickEvent))
    if ($script:phase -ne 'stopping' -or $controls.Stop.IsEnabled) { throw 'Stop must wait for worker acknowledgment' }
    Set-CardState 'success' 'test'
    if ($controls.Stop.Visibility -ne 'Collapsed' -or $script:closeAt -eq [DateTime]::MaxValue) { throw 'Completion controls failed' }
    Write-Output 'PASS: native WPF states rendered without desktop automation'
} else {
    # A modal dialog can activate itself. Use a non-modal window and our own pump.
    $window.Add_Closed({ $timer.Stop(); $window.Dispatcher.InvokeShutdown() })
    try { $window.Show(); [Windows.Threading.Dispatcher]::Run() } finally { $timer.Stop() }
}
