param([switch]$SelfTest, [switch]$UiSelfTest, [switch]$DetectUiSelfTest, [switch]$BundleUiSelfTest, [string]$BundleRoot)

# Development-only UI for the installer. It never installs runtimes or changes
# Codex authentication. The installer remains the owner of planning, file
# identity, Revit process checks and application of an approved plan.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function ConvertTo-WindowsArgument([string]$Value) {
    if ($null -eq $Value -or $Value -match '[\x00-\x1f"]') { throw '路径包含无效字符。' }
    # Windows paths cannot contain quotes; duplicate trailing backslashes so
    # the final quote is not consumed by CommandLineToArgvW.
    return '"' + [regex]::Replace($Value, '(\\+)$', '$1$1') + '"'
}

function Test-RealNode([string]$Value) {
    try {
        if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z]:\\' -or
            [IO.Path]::GetFileName($Value) -ine 'node.exe' -or
            -not [string]::Equals([IO.Path]::GetFullPath($Value), $Value, [StringComparison]::OrdinalIgnoreCase) -or
            $Value -match '(?i)(^|\\)WindowsApps(\\|$)' -or -not [IO.File]::Exists($Value)) { return $false }
        $info = New-Object IO.FileInfo $Value
        if (($info.Attributes -band [IO.FileAttributes]::Directory) -ne 0 -or
            ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        $parent = $info.Directory
        while ($null -ne $parent) {
            if (($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            $parent = $parent.Parent
        }
        return $true
    } catch { return $false }
}

function Find-ExistingNode {
    foreach ($entry in ([string]$env:Path -split ';')) {
        $directory = $entry.Trim().Trim('"')
        if ([string]::IsNullOrWhiteSpace($directory) -or -not [IO.Path]::IsPathRooted($directory)) { continue }
        try {
            $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($directory, 'node.exe'))
            if (Test-RealNode $candidate) { return $candidate }
        } catch { continue }
    }
    return ''
}

function Find-AdjacentPackage([string]$ToolsDirectory) {
    try {
        $parent = [IO.Directory]::GetParent([IO.Path]::GetFullPath($ToolsDirectory)).FullName
        $nested = [IO.Path]::Combine($parent, 'package')
        $parentHasPackage = [IO.File]::Exists([IO.Path]::Combine($parent, 'buildx-package.json'))
        $nestedHasPackage = [IO.File]::Exists([IO.Path]::Combine($nested, 'buildx-package.json'))
        if ($parentHasPackage -eq $nestedHasPackage) { return '' }
        if ($parentHasPackage) { return $parent }
        return $nested
    } catch { return '' }
}

function Format-RuntimeObservation($Item, [string]$Name) {
    if ($null -eq $Item) { return $Name + '：状态未知，请重新检测。' }
    $status = [string]$Item.status
    if ($status -eq 'found' -and -not [string]::IsNullOrWhiteSpace([string]$Item.path)) { return $Name + '：已发现，版本及登录仍待验证。' }
    if ($status -eq 'missing') { return $Name + '：未发现，请安装或选择已有程序。' }
    if ($status -eq 'ambiguous') { return $Name + '：发现多个候选，请手动选择。' }
    if ($status -eq 'unavailable' -and [string]$Item.code -eq 'CODEX_WRAPPER_ONLY') { return 'Codex：检测到命令包装，但未找到可直接调用的 codex.exe，请手动选择。' }
    return $Name + '：无法核实，请重新检测或手动选择。'
}

function Get-BundlePackage([string]$Root, [string]$Year, [string]$Build) {
    if (-not $Root) { return '' }
    $folder = switch ($Year) {
        '2024' { '2024' }
        '2025' {
            if ($Build -eq '25.0.2.419') { '2025-net8' }
        }
    }
    if (-not $folder) { return '' }
    $package = Join-Path (Join-Path $Root 'packages') $folder
    if ([IO.File]::Exists((Join-Path $package 'buildx-package.json')) -and
        [IO.File]::Exists((Join-Path $package 'buildx-confirmed-write.json'))) { return $package }
    return ''
}

function Get-InstallMode([string]$Action, [string]$Year, [bool]$Internal) {
    if ($Action -notin @('plan','apply')) { throw '未知安装动作。' }
    if ($Year -eq '2025') {
        if (-not $Internal) { throw 'Revit 2025 需要专用内部测试组件。' }
        return "--$Action-revit2025-internal-test"
    }
    if ($Internal) { return "--$Action-internal-test" }
    return "--$Action"
}

function Format-RevitTargets($Targets, [string]$Root = '') {
    foreach ($target in @($Targets)) {
        if ($null -eq $target -or -not $target.PSObject.Properties['version'] -or
            [string]$target.version -notin @('2024','2025') -or
            -not $target.PSObject.Properties['detected'] -or $target.detected -isnot [bool]) { continue }
        $label = 'Revit ' + $target.version
        if (-not $target.detected) {
            if ($target.PSObject.Properties['reason'] -and $target.reason -eq 'revit_ambiguous') {
                $label + ' · 发现多个安装路径，待核对'
            } else { $label + ' · 未核实安装' }
            continue
        }
        if ($target.PSObject.Properties['fileVersion'] -and [string]$target.fileVersion -match '^\d{2}(\.\d+){3}$') {
            $label += ' (' + $target.fileVersion + ')'
        }
        if ($Root) {
            $build = if ($target.PSObject.Properties['fileVersion']) { [string]$target.fileVersion } else { '' }
            if (Get-BundlePackage $Root $target.version $build) { $label + ' · 已检测，需检查安装计划' }
            else { $label + ' · 当前包缺少对应构建' }
            continue
        }
        if ($target.version -eq '2024') { $label + ' · 已检测，需检查安装计划'; continue }
        $label + ' · 已检测，等待 2025 专用插件'
    }
}

if ($SelfTest) {
    if ((ConvertTo-WindowsArgument 'C:\Program Files\node.exe') -ne '"C:\Program Files\node.exe"') { throw 'Argument quoting failed.' }
    if ((ConvertTo-WindowsArgument 'C:\folder\') -ne '"C:\folder\\"') { throw 'Trailing slash quoting failed.' }
    $rejected = $false; try { [void](ConvertTo-WindowsArgument ('bad' + [char]34)) } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid quote was accepted.' }
    if ((Format-RuntimeObservation ([pscustomobject]@{status='unavailable';code='CODEX_WRAPPER_ONLY';path=$null}) 'Codex') -notmatch '命令包装') { throw 'Wrapper state is inaccurate.' }
    if ((Format-RuntimeObservation ([pscustomobject]@{status='found';code=$null;path='C:\x\codex.exe'}) 'Codex') -notmatch '待验证') { throw 'Found state incorrectly claims readiness.' }
    if ((Get-InstallMode 'plan' '2024' $true) -ne '--plan-internal-test' -or
        (Get-InstallMode 'apply' '2025' $true) -ne '--apply-revit2025-internal-test') { throw 'Year-specific command routing failed.' }
    $testRoot = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'buildx-setup-test-' + [Guid]::NewGuid().ToString('N'))
    $testNormal = [IO.Path]::Combine($testRoot, 'normal'); $testAlias = [IO.Path]::Combine($testRoot, 'WindowsApps')
    $normalNode = [IO.Path]::Combine($testNormal, 'node.exe'); $aliasNode = [IO.Path]::Combine($testAlias, 'node.exe')
    $testTools = [IO.Path]::Combine($testNormal, 'tools'); $testPackage = [IO.Path]::Combine($testNormal, 'package')
    $parentManifest = [IO.Path]::Combine($testNormal, 'buildx-package.json'); $nestedManifest = [IO.Path]::Combine($testPackage, 'buildx-package.json')
    try {
        [void][IO.Directory]::CreateDirectory($testNormal); [void][IO.Directory]::CreateDirectory($testAlias)
        [IO.File]::WriteAllText($normalNode, 'fixture'); [IO.File]::WriteAllText($aliasNode, 'fixture')
        if (-not (Test-RealNode $normalNode) -or (Test-RealNode $aliasNode) -or (Test-RealNode 'node.exe')) { throw 'Node path verification failed.' }
        [void][IO.Directory]::CreateDirectory($testTools); [void][IO.Directory]::CreateDirectory($testPackage)
        if ((Find-AdjacentPackage $testTools) -ne '') { throw 'Missing package was guessed.' }
        [IO.File]::WriteAllText($parentManifest, '{}')
        if ((Find-AdjacentPackage $testTools) -ne $testNormal) { throw 'Package parent was not discovered.' }
        [IO.File]::WriteAllText($nestedManifest, '{}')
        if ((Find-AdjacentPackage $testTools) -ne '') { throw 'Ambiguous package was guessed.' }
        [IO.File]::Delete($parentManifest)
        if ((Find-AdjacentPackage $testTools) -ne $testPackage) { throw 'Sibling package was not discovered.' }
    } finally {
        if ([IO.File]::Exists($parentManifest)) { [IO.File]::Delete($parentManifest) }
        if ([IO.File]::Exists($nestedManifest)) { [IO.File]::Delete($nestedManifest) }
        if ([IO.Directory]::Exists($testTools)) { [IO.Directory]::Delete($testTools) }
        if ([IO.Directory]::Exists($testPackage)) { [IO.Directory]::Delete($testPackage) }
        if ([IO.File]::Exists($normalNode)) { [IO.File]::Delete($normalNode) }
        if ([IO.File]::Exists($aliasNode)) { [IO.File]::Delete($aliasNode) }
        if ([IO.Directory]::Exists($testNormal)) { [IO.Directory]::Delete($testNormal) }
        if ([IO.Directory]::Exists($testAlias)) { [IO.Directory]::Delete($testAlias) }
        if ([IO.Directory]::Exists($testRoot)) { [IO.Directory]::Delete($testRoot) }
    }
    Write-Output 'BuildX setup harness self-test passed.'
    return
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw '此向导仅支持 Windows。' }
if ([Threading.Thread]::CurrentThread.ApartmentState -ne [Threading.ApartmentState]::STA) { throw '请在 STA 模式运行此向导。' }
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

$script:InstallerFile = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'buildx-installer.mjs'))
$script:Worker = $null
$script:PlanFingerprint = $null
$script:StartedAt = $null
$script:OutputTask = $null
$script:ErrorTask = $null
$script:Action = $null
$script:Timer = $null
$script:Updating = $false
$script:InitialDetectionAttempted = $false
$script:AutoCodexPath = $null
$script:BundleRoot = if ($BundleRoot) { [IO.Path]::GetFullPath($BundleRoot) } else { '' }
$script:TargetYear = ''

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Title="BuildX 安装向导（开发候选）" Width="760" Height="760" MinWidth="660" MinHeight="600" WindowStartupLocation="CenterScreen">
  <Grid Margin="20"><Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
    <StackPanel Grid.Row="0" Margin="0,0,0,10">
      <TextBlock Text="BuildX 安装向导" FontSize="25" FontWeight="SemiBold"/>
      <TextBlock Text="本地开发候选：使用你已安装的 Codex，不会安装或升级其他软件。" TextWrapping="Wrap" Margin="0,5,0,0"/>
      <TextBlock x:Name="Scope" Text="当前候选尚未完成商业接入与全部功能验证；检测到缺项时不能安装。" TextWrapping="Wrap" Foreground="#8A5000" Margin="0,4,0,0"/>
    </StackPanel>
    <ScrollViewer Grid.Row="1" VerticalScrollBarVisibility="Auto"><StackPanel>
      <TextBlock Text="已有运行程序" FontWeight="Bold" FontSize="16" Margin="0,3,0,7"/>
      <TextBlock Text="Node 程序（用于运行安装检查）"/><DockPanel Margin="0,3,0,5"><Button x:Name="BrowseNode" DockPanel.Dock="Right" Content="选择…" Padding="9,3" Margin="6,0,0,0"/><TextBox x:Name="NodePath" Padding="5"/></DockPanel>
      <Button x:Name="Detect" Content="检测 / 重新检测已有程序" HorizontalAlignment="Left" Padding="12,5" Margin="0,0,0,4"/>
      <TextBlock x:Name="Detection" Text="先检测本机程序。发现程序不代表已登录或可用。" TextWrapping="Wrap" Margin="0,3,0,6"/>
      <TextBlock Text="Codex 程序"/><DockPanel Margin="0,3,0,5"><Button x:Name="BrowseCodex" DockPanel.Dock="Right" Content="选择…" Padding="9,3" Margin="6,0,0,0"/><TextBox x:Name="CodexPath" Padding="5"/></DockPanel>
      <Button x:Name="InstallHelp" Content="查看 Codex 官方安装说明" HorizontalAlignment="Left" Padding="8,3" Margin="0,0,0,4"/>
      <TextBlock Text="未找到时，请按官方说明安装，完成后点击上方“重新检测”；也可手动选择已有 codex.exe。" TextWrapping="Wrap" Margin="0,0,0,8"/>
      <TextBlock Text="Python 程序"/><DockPanel Margin="0,3,0,12"><Button x:Name="BrowsePython" DockPanel.Dock="Right" Content="选择…" Padding="9,3" Margin="6,0,0,0"/><TextBox x:Name="PythonPath" Padding="5"/></DockPanel>
      <TextBlock Text="安装位置" FontWeight="Bold" FontSize="16" Margin="0,0,0,7"/>
      <StackPanel x:Name="TargetRow" Visibility="Collapsed" Margin="0,0,0,8">
        <TextBlock Text="选择要安装的 Revit 版本。双版本分别检查与安装。"/>
        <ComboBox x:Name="TargetRevit" DisplayMemberPath="label" AutomationProperties.Name="Revit 安装目标"/>
      </StackPanel>
      <TextBlock Text="BuildX 候选组件目录"/><DockPanel Margin="0,3,0,7"><Button x:Name="BrowsePackage" DockPanel.Dock="Right" Content="选择…" Padding="9,3" Margin="6,0,0,0"/><TextBox x:Name="PackagePath" Padding="5"/></DockPanel>
      <TextBlock Text="新的 BuildX 安装目录"/><DockPanel Margin="0,3,0,7"><Button x:Name="BrowseInstall" DockPanel.Dock="Right" Content="选择父目录…" Padding="9,3" Margin="6,0,0,0"/><TextBox x:Name="InstallPath" Padding="5"/></DockPanel>
      <TextBlock Text="新的独立数据目录（聊天、资料引用、队列与回执；不会接管已有目录）" TextWrapping="Wrap"/><DockPanel Margin="0,3,0,7"><Button x:Name="BrowseData" DockPanel.Dock="Right" Content="选择父目录…" Padding="9,3" Margin="6,0,0,0"/><TextBox x:Name="DataPath" Padding="5"/></DockPanel>
      <TextBlock Text="当前用户的 Revit Addins 目录（必须已存在）"/><DockPanel Margin="0,3,0,9"><Button x:Name="BrowseAddins" DockPanel.Dock="Right" Content="选择…" Padding="9,3" Margin="6,0,0,0"/><TextBox x:Name="AddinsPath" Padding="5"/></DockPanel>
      <Button x:Name="Plan" Content="检查安装计划" HorizontalAlignment="Left" Padding="12,5" Margin="0,0,0,8"/>
      <TextBlock x:Name="Result" Text="检查会列出缺项和冲突，不会安装程序。" TextWrapping="Wrap"/>
    </StackPanel></ScrollViewer>
    <DockPanel Grid.Row="2" Margin="0,12,0,0"><Button x:Name="Install" DockPanel.Dock="Right" Content="安装 BuildX…" Padding="15,7" IsEnabled="False"/><TextBlock x:Name="Progress" Text="" TextWrapping="Wrap" VerticalAlignment="Center" Margin="0,0,10,0"/></DockPanel>
  </Grid>
</Window>
'@
$reader = New-Object System.Xml.XmlNodeReader $xaml
$script:Window = [Windows.Markup.XamlReader]::Load($reader)
foreach ($name in @('NodePath','CodexPath','PythonPath','PackagePath','InstallPath','DataPath','AddinsPath','BrowseNode','BrowseCodex','BrowsePython','BrowsePackage','BrowseInstall','BrowseData','BrowseAddins','Detect','InstallHelp','Plan','Install','Detection','Result','Progress','Scope','TargetRow','TargetRevit')) {
    Set-Variable -Scope Script -Name $name -Value $script:Window.FindName($name)
}
$script:NodePath.Text = Find-ExistingNode
$script:PackagePath.Text = Find-AdjacentPackage $PSScriptRoot
$script:InstallPath.Text = Join-Path $env:LOCALAPPDATA 'BuildX-Program'
$script:DataPath.Text = ''
$script:AddinsPath.Text = Join-Path $env:APPDATA 'Autodesk\Revit\Addins\2024'

function Test-InternalScope {
    $package = $script:PackagePath.Text.Trim()
    return $package.Length -gt 0 -and [IO.File]::Exists([IO.Path]::Combine($package, 'buildx-confirmed-write.json'))
}
function Update-ScopeLabel {
    $script:Scope.Text = if ($script:BundleRoot) { '私有确认写入候选 · Windows x64 · 每个 Revit 版本使用对应组件，模型写入需逐次确认。' }
        elseif (Test-InternalScope) { '私有确认写入候选 · 模型写入操作需逐次确认。' }
        else { '当前候选尚未完成商业接入与全部功能验证；检测到缺项时不能安装。' }
}
Update-ScopeLabel
if (Test-InternalScope) {
    $script:InstallPath.Text = Join-Path $env:LOCALAPPDATA 'BuildX-Revit2024-Program'
    $script:DataPath.Text = Join-Path $env:LOCALAPPDATA 'BuildX-Revit2024-Data'
}
if ($script:BundleRoot) {
    $script:TargetRow.Visibility = 'Visible'
    $script:PackagePath.IsReadOnly = $true
    $script:AddinsPath.IsReadOnly = $true
    $script:BrowsePackage.Visibility = 'Collapsed'
    $script:BrowseAddins.Visibility = 'Collapsed'
    $script:PackagePath.Text = ''
    $script:AddinsPath.Text = ''
}

function Get-Inputs {
    return @($script:PackagePath.Text.Trim(), $script:InstallPath.Text.Trim(), $script:AddinsPath.Text.Trim(),
        $script:NodePath.Text.Trim(), $script:PythonPath.Text.Trim(), $script:CodexPath.Text.Trim(), $script:DataPath.Text.Trim())
}
function Get-Fingerprint { return [string]::Join([char]0x1f, [string[]](@($script:TargetYear,(Test-InternalScope)) + (Get-Inputs))) }
function Clear-Plan {
    $script:PlanFingerprint = $null
    $script:Install.IsEnabled = $false
    if (-not $script:Updating) { $script:Result.Text = '输入已更改，请重新检查安装计划。' }
}
function Set-Busy([bool]$Busy) {
    foreach ($item in @($script:NodePath,$script:CodexPath,$script:PythonPath,$script:PackagePath,$script:InstallPath,$script:DataPath,$script:AddinsPath,$script:BrowseNode,$script:BrowseCodex,$script:BrowsePython,$script:BrowsePackage,$script:BrowseInstall,$script:BrowseData,$script:BrowseAddins,$script:Detect,$script:Plan,$script:InstallHelp,$script:TargetRevit)) { $item.IsEnabled = -not $Busy }
    $script:Install.IsEnabled = (-not $Busy -and $null -ne $script:PlanFingerprint -and $script:PlanFingerprint -eq (Get-Fingerprint))
}
function Update-BundleTargets($Targets) {
    if (-not $script:BundleRoot) { return }
    $previous = $script:TargetRevit.SelectedItem
    $oldInstall = $script:InstallPath.Text
    $oldData = $script:DataPath.Text
    $choices = @(
        foreach ($target in @($Targets)) {
            if ($null -eq $target -or -not $target.PSObject.Properties['detected'] -or $target.detected -ne $true -or
                -not $target.PSObject.Properties['version'] -or -not $target.PSObject.Properties['addinDirectory'] -or
                [string]::IsNullOrWhiteSpace([string]$target.addinDirectory)) { continue }
            $build = if ($target.PSObject.Properties['fileVersion']) { [string]$target.fileVersion } else { '' }
            $package = Get-BundlePackage $script:BundleRoot $target.version $build
            if ($package) { [pscustomobject]@{year=[string]$target.version; label=('Revit ' + $target.version + '  ' + $build).Trim(); package=$package; addins=[string]$target.addinDirectory} }
        }
    )
    $script:TargetRevit.ItemsSource = $choices
    if (-not $choices.Count) { return }
    $same = if ($previous) { $choices | Where-Object { $_.label -eq $previous.label -and $_.package -eq $previous.package -and $_.addins -eq $previous.addins } | Select-Object -First 1 } else { $null }
    $script:TargetRevit.SelectedItem = if ($same) { $same } else { $choices[0] }
    if ($same) { $script:InstallPath.Text = $oldInstall; $script:DataPath.Text = $oldData }
}

function Choose-Executable($Target,[string]$Expected) {
    $dialog = New-Object Microsoft.Win32.OpenFileDialog
    $dialog.Title = '选择已有的 ' + $Expected
    $dialog.Filter = $Expected + '|' + $Expected
    $dialog.CheckFileExists = $true
    if ($dialog.ShowDialog($script:Window) -eq $true) {
        $Target.Text = $dialog.FileName
        if ([object]::ReferenceEquals($Target, $script:CodexPath)) { $script:AutoCodexPath = $null }
    }
}
function Choose-Directory($Target,[bool]$InstallParent,[string]$Leaf='BuildX') {
    $dialog = New-Object Windows.Forms.FolderBrowserDialog
    try {
        $dialog.Description = if ($InstallParent) { '选择 BuildX 安装目录的父目录' } else { '选择已有目录' }
        $dialog.ShowNewFolderButton = $false
        if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) {
            $Target.Text = if ($InstallParent) { [IO.Path]::Combine($dialog.SelectedPath, $Leaf) } else { $dialog.SelectedPath }
        }
    } finally { $dialog.Dispose() }
}
function Start-Installer([string]$Action,[string[]]$Arguments) {
    if ($null -ne $script:Worker) { return }
    $node = $script:NodePath.Text.Trim()
    if (-not (Test-RealNode $node)) {
        $script:Progress.Text = '请明确选择可信的已有 node.exe；不能使用系统别名或链接。'; return
    }
    if (-not [IO.File]::Exists($script:InstallerFile)) { $script:Progress.Text = '缺少 BuildX 安装检查组件，无法继续。'; return }
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $parts = @($script:InstallerFile) + $Arguments
    $quoted = @(); foreach ($part in $parts) { $quoted += ConvertTo-WindowsArgument $part }
    $psi.Arguments = [string]::Join(' ', $quoted)
    $psi.WorkingDirectory = [IO.Path]::GetDirectoryName($script:InstallerFile)
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8; $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    $worker = New-Object Diagnostics.Process; $worker.StartInfo = $psi
    try {
        if (-not $worker.Start()) { throw '无法启动安装检查。' }
        $script:Worker = $worker; $script:OutputTask = $worker.StandardOutput.ReadToEndAsync(); $script:ErrorTask = $worker.StandardError.ReadToEndAsync()
        $script:Action = $Action; $script:StartedAt = [DateTime]::UtcNow
        $script:Progress.Text = '正在处理，请稍候…'; Set-Busy $true; $script:Timer.Start()
    } catch {
        $worker.Dispose(); $script:Worker = $null; $script:Progress.Text = '无法启动安装检查，请核实程序路径后重试。'; Set-Busy $false
    }
}
function Invoke-InitialDetection {
    if ($script:InitialDetectionAttempted) { return }
    $script:InitialDetectionAttempted = $true
    if (Test-RealNode $script:NodePath.Text.Trim()) { Clear-Plan; Start-Installer 'detect' @('--detect'); return }
    $script:Detection.Text = '未找到可核实的 node.exe，请手动选择已有程序，然后点击检测。'
}
function Update-DetectedCodex($Item) {
    # Refresh only an empty field or the value previously supplied by this
    # detector. Never silently replace an explicitly entered/selected path.
    $current = $script:CodexPath.Text.Trim()
    $wasAutomatic = $null -ne $script:AutoCodexPath -and
        [string]::Equals($current, $script:AutoCodexPath, [StringComparison]::OrdinalIgnoreCase)
    $manual = -not [string]::IsNullOrWhiteSpace($current) -and -not $wasAutomatic
    if (-not $manual) {
        $script:AutoCodexPath = $null
        if ($null -ne $Item -and $Item.status -eq 'found' -and -not [string]::IsNullOrWhiteSpace([string]$Item.path)) {
            $script:CodexPath.Text = [string]$Item.path
            $script:AutoCodexPath = [string]$Item.path
        } elseif ($wasAutomatic) {
            # A previously detected executable can disappear after an update,
            # or detection can become ambiguous. Do not keep a stale choice.
            $script:CodexPath.Text = ''
        }
    }
    return $manual
}
function Complete-Installer([string]$Action,[int]$ExitCode,[string]$Out,[string]$Err) {
    $raw = if ($ExitCode -eq 0) { $Out } else { $Err }
    try { $result = $raw | ConvertFrom-Json -ErrorAction Stop } catch { $script:Progress.Text = '检查返回内容无法核实，请重试。'; return }
    $okProperty = if ($null -ne $result) { $result.PSObject.Properties['ok'] } else { $null }
    if ($ExitCode -ne 0 -or $null -eq $result -or ($null -ne $okProperty -and $okProperty.Value -eq $false)) {
        $script:PlanFingerprint = $null
        $messageProperty = if ($null -ne $result) { $result.PSObject.Properties['message'] } else { $null }
        $message = if ($null -ne $messageProperty -and $messageProperty.Value) { [string]$messageProperty.Value } else { '检查失败，请核实输入后重试。' }
        if ($Action -eq 'apply' -and $null -ne $result) {
            $publishedProperty = $result.PSObject.Properties['manifestPublished']
            $rootProperty = $result.PSObject.Properties['retainedInstallRoot']
            $dataProperty = $result.PSObject.Properties['retainedDataRoot']
            if ($null -ne $publishedProperty -and $publishedProperty.Value -is [bool]) {
                $message += if ($publishedProperty.Value) { "`n插件入口已发布，请核对安装结果，勿重复安装。" } else { "`n插件入口未发布。" }
            } else { $message += "`n插件入口状态未知，请检查后再决定下一步。" }
            if ($null -ne $rootProperty -and -not [string]::IsNullOrWhiteSpace([string]$rootProperty.Value)) { $message += "`n安装目录已保留：" + [string]$rootProperty.Value }
            if ($null -ne $dataProperty -and -not [string]::IsNullOrWhiteSpace([string]$dataProperty.Value)) { $message += "`n数据目录位置已保留供核对：" + [string]$dataProperty.Value }
        }
        $script:Result.Text = $message; $script:Progress.Text = '未确认完成。'; return
    }
    if ($Action -eq 'detect') {
        if ($result.schemaVersion -ne 1 -or $null -eq $result.runtimes) { $script:Progress.Text = '检测结果无法核实，请重试。'; return }
        $script:Updating = $true
        try {
            foreach ($entry in @(@($result.runtimes.node,$script:NodePath),@($result.runtimes.python,$script:PythonPath))) {
                if ($entry[0].status -eq 'found' -and [string]::IsNullOrWhiteSpace($entry[1].Text)) { $entry[1].Text = [string]$entry[0].path }
            }
            $manualCodex = Update-DetectedCodex $result.runtimes.codex
        } finally { $script:Updating = $false }
        $script:Detection.Text = (Format-RuntimeObservation $result.runtimes.node 'Node') + "`n" + (Format-RuntimeObservation $result.runtimes.python 'Python') + "`n" + (Format-RuntimeObservation $result.runtimes.codex 'Codex')
        if ($result.PSObject.Properties['revitTargets']) {
            $targets = @(Format-RevitTargets $result.revitTargets $script:BundleRoot)
            if ($targets.Count) { $script:Detection.Text += "`n" + ($targets -join "`n") }
            Update-BundleTargets $result.revitTargets
        }
        if ($manualCodex) { $script:Detection.Text += "`n已保留手动填写的 Codex 路径，安装计划仍会检查它。" }
        $script:Progress.Text = '检测完成；需要在检查计划时核实版本。'; return
    }
    if ($Action -eq 'plan') {
        if ($result.readyToApply -eq $true) {
            $script:PlanFingerprint = Get-Fingerprint
            $script:Result.Text = '检查通过：将安装到 ' + $script:InstallPath.Text.Trim() + '，并在 Revit Addins 目录发布入口。请核对后选择安装。'
            $script:Progress.Text = '安装前需要确认。'
        } else {
            $script:PlanFingerprint = $null
            $issues = @()
            $blockers = if ($result.PSObject.Properties['installationScope'] -and $result.installationScope -eq 'cross-pc-test') { $result.internalBlockers } else { $result.blockers }
            foreach ($issue in $blockers) {
                if ($issue.reason -eq 'revit2025_host_runtime_evidence_unverified') {
                    $issues += '未能确认 Revit 2025 的 API 文件与本测试包匹配，请核对完整版本和安装状态。'
                } elseif ($issue.reason) { $issues += [string]$issue.reason }
            }
            $script:Result.Text = '暂不能安装：' + [string]$result.reason + $(if ($issues.Count) { "`n待解决：" + [string]::Join('、', [string[]]$issues) } else { '' })
            $script:Progress.Text = '未安装。'
        }
        return
    }
    if ($Action -eq 'apply') {
        $script:PlanFingerprint = $null
        if ($result.ok -eq $true) { $script:Result.Text = '已发布插件入口。关闭并重新启动 Revit 后才能验证加载；AI 登录状态需在工作空间检查。'; $script:Progress.Text = '安装操作完成。' }
        else { $script:Result.Text = '安装结果尚未确认，请检查安装目录和插件入口。'; $script:Progress.Text = '需要核对。' }
    }
}

$script:Timer = New-Object Windows.Threading.DispatcherTimer
$script:Timer.Interval = [TimeSpan]::FromMilliseconds(250)
$script:Timer.Add_Tick({
    if ($null -eq $script:Worker) { $script:Timer.Stop(); return }
    try {
        if (-not $script:Worker.HasExited -or -not $script:OutputTask.IsCompleted -or -not $script:ErrorTask.IsCompleted) {
            if (([DateTime]::UtcNow - $script:StartedAt).TotalSeconds -gt 60) { $script:Progress.Text = '仍在等待检查结果，请保持窗口打开；不会重复执行。' }
            return
        }
        $script:Timer.Stop(); $worker = $script:Worker; $script:Worker = $null
        $code = $worker.ExitCode; $out = $script:OutputTask.GetAwaiter().GetResult(); $err = $script:ErrorTask.GetAwaiter().GetResult(); $action = $script:Action
        $worker.Dispose(); Complete-Installer $action $code $out $err; Set-Busy $false
    } catch { $script:Timer.Stop(); $script:Worker = $null; $script:PlanFingerprint = $null; $script:Progress.Text = '操作结果无法确认，请检查后再决定下一步。'; Set-Busy $false }
})
foreach ($field in @($script:NodePath,$script:CodexPath,$script:PythonPath,$script:PackagePath,$script:InstallPath,$script:DataPath,$script:AddinsPath)) { $field.Add_TextChanged({ Clear-Plan }) }
$script:PackagePath.Add_TextChanged({ Update-ScopeLabel })
$script:TargetRevit.Add_SelectionChanged({
    if (-not $script:BundleRoot) { return }
    $target = $script:TargetRevit.SelectedItem
    if ($null -eq $target) {
        $script:TargetYear = ''; $script:PackagePath.Text = ''; $script:AddinsPath.Text = ''; Clear-Plan; return
    }
    $script:TargetYear = $target.year
    $script:PackagePath.Text = $target.package
    $script:AddinsPath.Text = $target.addins
    $script:InstallPath.Text = Join-Path $env:LOCALAPPDATA ('BuildX-Revit' + $target.year + '-Program')
    $script:DataPath.Text = Join-Path $env:LOCALAPPDATA ('BuildX-Revit' + $target.year + '-Data')
    Clear-Plan
})
$script:CodexPath.Add_TextChanged({ if (-not $script:Updating) { $script:AutoCodexPath = $null } })
$script:BrowseNode.Add_Click({ Choose-Executable $script:NodePath 'node.exe' })
$script:BrowseCodex.Add_Click({ Choose-Executable $script:CodexPath 'codex.exe' })
$script:BrowsePython.Add_Click({ Choose-Executable $script:PythonPath 'python.exe' })
$script:BrowsePackage.Add_Click({ Choose-Directory $script:PackagePath $false })
$script:BrowseInstall.Add_Click({ Choose-Directory $script:InstallPath $true })
$script:BrowseData.Add_Click({ Choose-Directory $script:DataPath $true 'BuildX-Data' })
$script:BrowseAddins.Add_Click({ Choose-Directory $script:AddinsPath $false })
$script:Detect.Add_Click({ Clear-Plan; Start-Installer 'detect' @('--detect') })
$script:InstallHelp.Add_Click({
    # Fixed official URL; the browser opens only on this user action.
    try { $start = New-Object Diagnostics.ProcessStartInfo; $start.FileName = 'https://developers.openai.com/codex/cli/'; $start.UseShellExecute = $true; [void][Diagnostics.Process]::Start($start) }
    catch { $script:Progress.Text = '无法打开安装说明，请手动访问 OpenAI 官方 Codex 页面。' }
})
$script:Plan.Add_Click({
    Clear-Plan; $values = Get-Inputs
    if ($script:BundleRoot -and (-not $script:TargetYear -or -not (Test-InternalScope))) { $script:Result.Text = '请先检测并选择有对应组件的 Revit 版本。'; return }
    if (@($values | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count) { $script:Result.Text = '请填写组件目录、安装位置与已有程序路径。'; return }
    $mode = Get-InstallMode 'plan' $script:TargetYear (Test-InternalScope)
    Start-Installer 'plan' (@($mode) + $values)
})
$script:Install.Add_Click({
    if ($null -eq $script:PlanFingerprint -or $script:PlanFingerprint -ne (Get-Fingerprint)) { Clear-Plan; return }
    $question = '将在以下目录安装 BuildX：' + "`n" + $script:InstallPath.Text.Trim() + "`n`n" + '独立数据目录：' + "`n" + $script:DataPath.Text.Trim() + "`n`n" + '并在 Revit Addins 目录发布插件入口。是否继续？'
    if ([Windows.MessageBox]::Show($script:Window,$question,'确认安装',[Windows.MessageBoxButton]::YesNo,[Windows.MessageBoxImage]::Question) -ne [Windows.MessageBoxResult]::Yes) { return }
    $mode = Get-InstallMode 'apply' $script:TargetYear (Test-InternalScope)
    Start-Installer 'apply' (@($mode) + (Get-Inputs))
})
$script:Window.Add_Closing({ param($sender,$eventArgs) if ($null -ne $script:Worker) { $eventArgs.Cancel = $true; $script:Progress.Text = '正在等待操作结果，请勿重复执行或关闭窗口。' } })
$script:Window.Add_ContentRendered({ Invoke-InitialDetection })
if ($BundleUiSelfTest) {
    if (-not $script:BundleRoot) { throw 'Bundle test needs a controlled fixture root.' }
    $detected = '{"schemaVersion":1,"runtimes":{"node":{"status":"missing"},"python":{"status":"missing"},"codex":{"status":"missing"}},"revitTargets":[{"version":"2024","detected":true,"fileVersion":"24.3.30.11","addinDirectory":"C:\\fixture\\Addins\\2024"},{"version":"2025","detected":true,"fileVersion":"25.0.2.419","addinDirectory":"C:\\fixture\\Addins\\2025"}]}'
    Complete-Installer 'detect' 0 $detected ''
    if ($script:TargetRevit.Items.Count -ne 2 -or $script:TargetYear -ne '2024' -or $script:AddinsPath.Text -ne 'C:\fixture\Addins\2024') { throw '2024 default and 2025 alternative were not detected.' }
    Complete-Installer 'plan' 0 '{"ok":true,"readyToApply":true,"blockers":[]}' ''
    Set-Busy $false
    if (-not $script:Install.IsEnabled) { throw 'Controlled plan is not enabled.' }
    $script:TargetRevit.SelectedIndex = 1
    if ($script:TargetYear -ne '2025' -or $script:AddinsPath.Text -ne 'C:\fixture\Addins\2025' -or
        $script:PackagePath.Text -notmatch '2025-net8$' -or $script:InstallPath.Text -notmatch '2025-Program$' -or
        $script:DataPath.Text -notmatch '2025-Data$' -or $script:Install.IsEnabled) { throw '2025 paths or plan invalidation failed.' }
    foreach ($otherBuild in @('25.3.0.46','25.5.0.57')) {
        Complete-Installer 'detect' 0 ($detected.Replace('25.0.2.419',$otherBuild)) ''
        if ($script:TargetRevit.Items.Count -ne 1 -or $script:TargetYear -ne '2024' -or
            $script:Detection.Text -notmatch ([regex]::Escape($otherBuild) + '.*缺少对应构建') -or $script:Install.IsEnabled) { throw 'A different 2025 build was incorrectly matched to the payload.' }
    }
    Write-Output 'BuildX WPF bundle target mapping self-test passed.'
    return
}
if ($UiSelfTest) {
    # Exercise the real XAML, event bindings and result mapper without showing a
    # window, launching a process, opening a URL, or touching any installation.
    $script:NodePath.Text = ''; $script:PythonPath.Text = ''; $script:CodexPath.Text = ''
    Invoke-InitialDetection
    if ($script:Worker -ne $null -or $script:Detection.Text -notmatch '手动选择') { throw 'Missing node should wait for the user.' }
    $detected = '{"schemaVersion":1,"runtimes":{"node":{"status":"found","path":"C:\\test\\node.exe","code":null},"python":{"status":"missing","path":null,"code":"PYTHON_NOT_FOUND"},"codex":{"status":"unavailable","path":null,"code":"CODEX_WRAPPER_ONLY"}},"revitTargets":[{"version":"2024","detected":true},{"version":"2025","detected":true}]}'
    Complete-Installer 'detect' 0 $detected ''
    if ($script:NodePath.Text -ne 'C:\test\node.exe' -or $script:Detection.Text -notmatch '命令包装' -or $script:Detection.Text -notmatch '待验证') { throw ('Detection mapping failed: ' + $script:NodePath.Text + ' / ' + $script:Detection.Text) }
    if ($script:Detection.Text -notmatch 'Revit 2024 · 已检测，需检查安装计划' -or
        $script:Detection.Text -notmatch 'Revit 2025 · 已检测，等待 2025 专用插件' -or
        $script:Install.IsEnabled) { throw 'Version detection incorrectly changed installation readiness.' }
    $found = '{"schemaVersion":1,"runtimes":{"node":{"status":"found","path":"C:\\test\\node.exe"},"python":{"status":"missing"},"codex":{"status":"found","path":"C:\\old\\codex.exe"}}}'
    $ambiguous = '{"schemaVersion":1,"runtimes":{"node":{"status":"found","path":"C:\\test\\node.exe"},"python":{"status":"missing"},"codex":{"status":"ambiguous","code":"CODEX_PATH_AMBIGUOUS"}}}'
    Complete-Installer 'detect' 0 $found ''
    if ($script:CodexPath.Text -ne 'C:\old\codex.exe') { throw 'Codex was not automatically populated.' }
    Complete-Installer 'detect' 0 $ambiguous ''
    if ($script:CodexPath.Text -ne '' -or $script:Detection.Text -notmatch '多个候选') { throw 'Ambiguous retry retained an automatically detected executable.' }
    $script:CodexPath.Text = 'C:\user\codex.exe'
    Complete-Installer 'detect' 0 $found ''
    if ($script:CodexPath.Text -ne 'C:\user\codex.exe' -or $script:Detection.Text -notmatch '保留手动') { throw 'Manual Codex selection was overwritten.' }
    $script:PackagePath.Text = 'C:\test\package'; $script:InstallPath.Text = 'C:\test\install'; $script:AddinsPath.Text = 'C:\test\addins'
    $script:DataPath.Text = 'C:\test\data'
    $script:PythonPath.Text = 'C:\test\python.exe'; $script:CodexPath.Text = 'C:\test\codex.exe'
    Complete-Installer 'plan' 0 '{"ok":true,"readyToApply":false,"reason":"缺项","blockers":[{"reason":"missing_test"}]}' ''
    Set-Busy $false
    if ($script:Install.IsEnabled -or $script:Result.Text -notmatch 'missing_test') { throw 'Blocked plan was not preserved.' }
    Complete-Installer 'plan' 0 '{"ok":true,"readyToApply":true,"blockers":[]}' ''
    Set-Busy $false
    if (-not $script:Install.IsEnabled) { throw 'Ready plan was not shown.' }
    $script:DataPath.Text = 'C:\test\changed-data'
    if ($script:Install.IsEnabled -or $null -ne $script:PlanFingerprint) { throw 'Changed input did not invalidate plan.' }
    Complete-Installer 'detect' 1 '' '{"ok":false,"code":"TEST","message":"test failure"}'
    if ($script:Result.Text -ne 'test failure') { throw 'Error mapping failed.' }
    Complete-Installer 'apply' 1 '' '{"ok":false,"message":"test failure","retainedInstallRoot":"C:\\test\\install","manifestPublished":true}'
    if ($script:Result.Text -notmatch '插件入口已发布' -or $script:Result.Text -notmatch '安装目录已保留') { throw 'Partial installation result was hidden.' }
    Write-Output 'BuildX WPF construction and result mapping self-test passed.'
    return
}
if ($DetectUiSelfTest) {
    # Exercise first-show detection, child process and asynchronous result mapping.
    # --detect is read-only: it neither reads authentication nor installs.
    if (-not [IO.File]::Exists($script:NodePath.Text)) { throw 'No existing node.exe on PATH for detection test.' }
    $expectedPackage = Find-AdjacentPackage $PSScriptRoot
    if ($expectedPackage -and $script:PackagePath.Text -ne $expectedPackage) { throw 'Adjacent package was not prefilled.' }
    $frame = New-Object Windows.Threading.DispatcherFrame
    $check = New-Object Windows.Threading.DispatcherTimer
    $check.Interval = [TimeSpan]::FromMilliseconds(100)
    $began = [DateTime]::UtcNow
    $check.Add_Tick({ if (($script:InitialDetectionAttempted -and $null -eq $script:Worker) -or ([DateTime]::UtcNow - $began).TotalSeconds -gt 20) { $check.Stop(); $frame.Continue = $false } })
    $script:Window.ShowActivated = $false; $script:Window.ShowInTaskbar = $false; $script:Window.Opacity = 0
    $script:Window.Show(); $check.Start(); [Windows.Threading.Dispatcher]::PushFrame($frame)
    if ($null -ne $script:Worker) { throw 'Detection did not finish within test bound; outcome unknown.' }
    if (-not $script:InitialDetectionAttempted -or $script:Progress.Text -notmatch '检测完成' -or $script:Detection.Text -notmatch 'Codex') { throw ('Initial detection did not produce a verified result: ' + $script:Progress.Text) }
    Invoke-InitialDetection
    if ($null -ne $script:Worker) { throw 'Initial detection repeated unexpectedly.' }
    $frame2 = New-Object Windows.Threading.DispatcherFrame
    $check2 = New-Object Windows.Threading.DispatcherTimer
    $check2.Interval = [TimeSpan]::FromMilliseconds(100)
    $began2 = [DateTime]::UtcNow
    $check2.Add_Tick({ if ($null -eq $script:Worker -or ([DateTime]::UtcNow - $began2).TotalSeconds -gt 20) { $check2.Stop(); $frame2.Continue = $false } })
    $script:Detect.RaiseEvent((New-Object Windows.RoutedEventArgs ([Windows.Controls.Button]::ClickEvent)))
    if ($null -eq $script:Worker) { throw 'Manual detection retry did not start.' }
    $check2.Start(); [Windows.Threading.Dispatcher]::PushFrame($frame2)
    if ($null -ne $script:Worker -or $script:Progress.Text -notmatch '检测完成') { throw 'Manual detection retry did not complete.' }
    $script:Window.Close()
    Write-Output 'BuildX WPF first-show and manual retry read-only process test passed.'
    return
}
[void]$script:Window.ShowDialog()
