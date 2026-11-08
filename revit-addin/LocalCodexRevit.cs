using System;
using System.IO;
using System.Diagnostics;
using System.Net.Http;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Runtime.Versioning;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Win32;
using Grid = System.Windows.Controls.Grid;
using Color = System.Windows.Media.Color;
using WpfVisibility = System.Windows.Visibility;

[assembly: AssemblyTitle("BuildX")]
#if NET8_0_OR_GREATER
[assembly: AssemblyDescription("BuildX workspace for Revit 2025")]
#else
[assembly: AssemblyDescription("BuildX workspace for Revit 2024")]
#endif
[assembly: AssemblyVersion("0.8.8.0")]
[assembly: AssemblyFileVersion("0.8.8.0")]
#if !NET8_0_OR_GREATER
[assembly: TargetFramework(".NETFramework,Version=v4.8")]
#endif

namespace RevitLocalCodex
{
    public sealed class App : IExternalApplication
    {
        internal static string PanelAddress { get { return LocalService.PanelAddress; } }
        internal static readonly DockablePaneId PaneId = new DockablePaneId(
            new Guid("f3df6cf1-bb52-459d-aee4-788716f3ea59"));
        internal static CodexPane Pane;
        private WorkbenchHost workbench;
        internal static WorkbenchHost CurrentWorkbench;
        private UIControlledApplication startupApplication;
        private static PushButton autoStartButton;
        private static bool? autoStartEnabled;

        public Result OnStartup(UIControlledApplication application)
        {
            try
            {
                // Resolve the installation before creating the queue owner. A
                // broken or missing configuration must not create a second
                // workbench in a guessed directory.
                LocalService.ValidateInstallation();
                Pane = new CodexPane();
                workbench = new WorkbenchHost(application, Pane.Dispatcher);
                CurrentWorkbench = workbench;
                application.RegisterDockablePane(PaneId, "BuildX", Pane);

                const string tabName = "BuildX";
                application.CreateRibbonTab(tabName);
                RibbonPanel ribbonPanel = application.CreateRibbonPanel(tabName, "BuildX");
                PushButtonData button = new PushButtonData(
                    "RevitLocalCodex.OpenPanel", "BuildX", Assembly.GetExecutingAssembly().Location,
                    typeof(OpenPanelCommand).FullName);
                button.ToolTip = "打开 BuildX，自动检查并启动本地服务。";
                button.LongDescription = "本地服务未运行时自动启动；已运行时直接连接。与助手对话，或直接使用命令处理当前 Revit 项目。";
                button.AvailabilityClassName = typeof(OpenPanelAvailability).FullName;
                button.Image = LoadLogo(16);
                button.LargeImage = LoadLogo(32);
                ribbonPanel.AddItem(button);
                // Keep the schematic editor implementation, but do not expose
                // its unfinished workflow in the product ribbon.
                PushButtonData help = new PushButtonData("RevitLocalCodex.Help", "Help", Assembly.GetExecutingAssembly().Location, typeof(HelpCommand).FullName);
                help.ToolTip = "BuildX 使用帮助";
                PushButtonData about = new PushButtonData("RevitLocalCodex.About", "About", Assembly.GetExecutingAssembly().Location, typeof(AboutCommand).FullName);
                about.ToolTip = "关于 BuildX";
                ribbonPanel.AddStackedItems(help, about);
                PushButtonData autoStart = new PushButtonData("RevitLocalCodex.AutoStart", "自动启动", Assembly.GetExecutingAssembly().Location, typeof(ToggleAutoStartCommand).FullName);
                autoStart.ToolTip = "设置 Revit 启动时是否自动打开 BuildX。";
                autoStart.LongDescription = "关闭后，下次打开 Revit 不自动打开 BuildX；手动打开仍可启动服务。已运行的服务不会被关闭。";
                autoStart.AvailabilityClassName = typeof(OpenPanelAvailability).FullName;
                autoStartButton = (PushButton)ribbonPanel.AddItem(autoStart);
                RefreshAutoStartState();
                startupApplication = application;
                startupApplication.Idling += OnInitialIdling;
                return Result.Succeeded;
            }
            catch (Exception exception)
            {
                if (Pane != null) Pane.Dispose();
                if (workbench != null) workbench.Dispose();
                Pane = null;
                CurrentWorkbench = null;
                RemoveStartupHandler();
                TaskDialog.Show("BuildX", exception is BuildXInstallationException
                    ? "BuildX 安装配置不可用，请运行安装检查或重新安装。"
                    : "工作空间注册失败。错误码：" + ErrorCode(exception));
                return Result.Failed;
            }
        }

        private void OnInitialIdling(object sender, IdlingEventArgs args)
        {
            UIApplication uiapp = sender as UIApplication;
            if (uiapp == null) return;
            // One attempt after the Revit UI is ready. Closing the pane later
            // remains the user's choice; idle callbacks must not reopen it.
            RemoveStartupHandler();
            if (autoStartEnabled != true) return;
            try
            {
                uiapp.GetDockablePane(PaneId).Show();
                if (Pane != null) Pane.RequestOpen();
            }
            catch (Exception error) { Trace.TraceError("BuildX automatic open failed: " + ErrorCode(error)); }
        }

        private void RemoveStartupHandler()
        {
            if (startupApplication == null) return;
            startupApplication.Idling -= OnInitialIdling;
            startupApplication = null;
        }

        private static BitmapImage LoadLogo(int size)
        {
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("RevitLocalCodex.BimXLogo"))
            {
                BitmapImage image = new BitmapImage();
                image.BeginInit();
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.DecodePixelWidth = size;
                image.StreamSource = stream;
                image.EndInit();
                image.Freeze();
                return image;
            }
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            RemoveStartupHandler();
            OpenSchematicEditorCommand.CloseForHostShutdown();
            if (workbench != null) workbench.Dispose();
            if (Pane != null) Pane.Dispose();
            Pane = null;
            CurrentWorkbench = null;
            autoStartButton = null;
            LocalService.ReleaseHandle();
            return Result.Succeeded;
        }

        internal static string ErrorCode(Exception exception)
        {
            return "0x" + exception.HResult.ToString("X8");
        }

        internal static bool AutoStartEnabled { get { return autoStartEnabled == true; } }

        internal static bool RefreshAutoStartState()
        {
            try { autoStartEnabled = AutoStartPreference.Read(); }
            catch (Exception error)
            {
                autoStartEnabled = null;
                Trace.TraceError("BuildX auto-start preference unavailable: " + ErrorCode(error));
            }
            if (autoStartButton != null)
                autoStartButton.ItemText = "自动启动：" + (autoStartEnabled.HasValue ? (autoStartEnabled.Value ? "开" : "关") : "未知");
            return autoStartEnabled.HasValue;
        }

        internal static void ToggleAutoStart()
        {
            if (!RefreshAutoStartState())
            {
                TaskDialog.Show("BuildX", "无法读取自动启动设置，请检查当前用户设置权限。手动打开 BuildX 仍可使用。");
                return;
            }
            try
            {
                bool next = !autoStartEnabled.Value;
                AutoStartPreference.Write(next);
                if (!RefreshAutoStartState() || autoStartEnabled != next)
                    throw new InvalidOperationException("Auto-start preference could not be verified.");
            }
            catch (Exception error)
            {
                RefreshAutoStartState();
                TaskDialog.Show("BuildX", "无法确认自动启动设置已保存。错误码：" + ErrorCode(error));
            }
        }
    }

    // BEGIN AUTO START PREFERENCE
    internal static class AutoStartPreference
    {
        private const string KeyPath = @"Software\BuildX\Revit";
        private const string ValueName = "AutoStart";

        internal static bool? Read()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(KeyPath, false))
            {
                if (key == null) return false;
                object value = key.GetValue(ValueName, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                if (value == null) return false;
                if (!(value is int) || ((int)value != 0 && (int)value != 1)) return null;
                return (int)value == 1;
            }
        }

        internal static void Write(bool enabled)
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(KeyPath))
            {
                if (key == null) throw new InvalidOperationException("Cannot open auto-start preference.");
                key.SetValue(ValueName, enabled ? 1 : 0, RegistryValueKind.DWord);
            }
        }
    }
    // END AUTO START PREFERENCE

    [Transaction(TransactionMode.ReadOnly)]
    public sealed class ToggleAutoStartCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            App.ToggleAutoStart();
            return Result.Succeeded;
        }
    }

    [Transaction(TransactionMode.ReadOnly)]
    public sealed class OpenPanelCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            try
            {
                commandData.Application.GetDockablePane(App.PaneId).Show();
                if (App.Pane != null) App.Pane.RequestOpen();
                return Result.Succeeded;
            }
            catch (Exception exception)
            {
                message = "无法打开 BuildX。错误码：" + App.ErrorCode(exception);
                return Result.Failed;
            }
        }
    }

    [Transaction(TransactionMode.ReadOnly)]
    public sealed class HelpCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            TaskDialog.Show("BuildX 帮助", "点击 BuildX 打开工作空间。\n\n对话：输入需求后按 Enter 发送，Shift+Enter 换行。\n命令：选择工具，填写参数后应用。\n账号：点击工作空间右上角头像查看。\n\n命令结果待核对时，请先核对原请求，勿重复执行。");
            return Result.Succeeded;
        }
    }

    [Transaction(TransactionMode.ReadOnly)]
    public sealed class AboutCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
        {
            TaskDialog.Show("关于 BuildX", "BuildX · Revit 工作空间\n版本 0.6.4\n\n对话、命令与本机 Revit 执行器共用当前项目上下文。工具的可用范围以工作空间中的实时状态为准。");
            return Result.Succeeded;
        }
    }

    public sealed class OpenPanelAvailability : IExternalCommandAvailability
    {
        public bool IsCommandAvailable(UIApplication applicationData, CategorySet selectedCategories)
        {
            return true;
        }
    }

    public sealed class CodexPane : Page, IDockablePaneProvider, IDisposable
    {
        private readonly Grid browserHost;
        private readonly TextBlock status;
        private readonly Button retry;
        private readonly Border loadingSurface;
        private WebView2 browser;
        private CoreWebView2Environment environment;
        private bool requested;
        private bool startWhenLoaded;
        private bool reloadWhenLoaded;
        private bool hasNavigated;
        private bool initializing;
        private bool pendingOpen;
        private bool pendingReload;
        private bool disposed;

        public CodexPane()
        {
            Background = new SolidColorBrush(Color.FromRgb(248, 249, 245));
            Grid layout = new Grid();
            browserHost = new Grid();
            layout.Children.Add(browserHost);
            StackPanel startup = new StackPanel { Margin = new Thickness(28), VerticalAlignment = VerticalAlignment.Center };
            startup.Children.Add(new TextBlock { Text = "BuildX", FontSize = 28, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(Color.FromRgb(32, 67, 54)) });
            startup.Children.Add(new TextBlock { Text = "你的 Revit 工作空间", FontSize = 13, Margin = new Thickness(0, 8, 0, 22), Foreground = new SolidColorBrush(Color.FromRgb(103, 116, 105)) });
            retry = new Button { Content = "启动并重新连接", Padding = new Thickness(14, 7, 14, 7), Margin = new Thickness(0, 18, 0, 0), HorizontalAlignment = HorizontalAlignment.Left, Visibility = WpfVisibility.Collapsed };
            retry.Click += delegate { RequestOpen(true); };
            status = new TextBlock
            {
                Text = "正在准备工作空间…",
                VerticalAlignment = VerticalAlignment.Center,
                TextWrapping = TextWrapping.Wrap,
                FontSize = 12,
                Foreground = new SolidColorBrush(Color.FromRgb(64, 69, 78))
            };
            startup.Children.Add(status);
            startup.Children.Add(retry);
            loadingSurface = new Border { Background = Background, Child = startup };
            layout.Children.Add(loadingSurface);
            Content = layout;
            Loaded += delegate
            {
                // First visibility is itself the UI-ready initialization
                // boundary; a ribbon request need not have happened yet.
                // Revit can restore the pane even when auto-start is off. Do
                // not start a background probe that could swallow a manual
                // open request while initialization is in progress.
                if (!requested && !startWhenLoaded && !App.AutoStartEnabled)
                {
                    ShowStartup("点击功能区 BuildX，或“启动并重新连接”，打开工作空间。", true);
                    return;
                }
                bool allowServiceStart = startWhenLoaded || (!requested && App.AutoStartEnabled);
                requested = true;
                bool forceReload = reloadWhenLoaded;
                startWhenLoaded = false;
                reloadWhenLoaded = false;
                InitializeOrNavigate(allowServiceStart, forceReload);
            };
        }

        public void SetupDockablePane(DockablePaneProviderData data)
        {
            data.FrameworkElement = this;
            data.InitialState = new DockablePaneState { DockPosition = DockPosition.Right };
        }

        public void RequestOpen()
        {
            RequestOpen(false);
        }

        private void RequestOpen(bool forceReload)
        {
            if (disposed) return;
            requested = true;
            if (initializing)
            {
                // Keep one explicit request while an earlier probe finishes.
                // Do not start a second service or replay a model operation.
                pendingOpen = true;
                pendingReload = pendingReload || forceReload;
                return;
            }
            if (IsLoaded) InitializeOrNavigate(true, forceReload);
            else
            {
                startWhenLoaded = true;
                reloadWhenLoaded = reloadWhenLoaded || forceReload;
            }
        }

        private async void InitializeOrNavigate(bool allowServiceStart, bool forceReload)
        {
            if (disposed || initializing) return;
            initializing = true;
            retry.IsEnabled = false;
            ShowStartup("正在连接工作空间…", false);
            try
            {
                bool serviceWasAbsent = false;
                string serviceError = await LocalService.EnsureAvailableAsync(allowServiceStart, delegate { serviceWasAbsent = true; });
                if (disposed) return;
                if (serviceError != null)
                {
                    ShowStartup(serviceError, true);
                    return;
                }
                // A healthy existing service must not reload the active page,
                // which could disrupt an ongoing conversation. If this check
                // saw an explicit refusal, the service was restarted or another
                // instance came up: navigate anew after identity verification.
                if (hasNavigated && !forceReload && !serviceWasAbsent)
                {
                    loadingSurface.Visibility = WpfVisibility.Collapsed;
                    return;
                }
                if (browser == null)
                {
                    browser = new WebView2();
                    browserHost.Children.Add(browser);
                }
                if (browser.CoreWebView2 == null)
                {
                    if (environment == null)
                    {
                        string userDataFolder = LocalService.WebViewUserDataFolder;
                        environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder, null);
                    }
                    if (disposed) return;
                    await browser.EnsureCoreWebView2Async(environment);
                    if (disposed) return;
                    ConfigureBrowser();
                }
                browser.CoreWebView2.Navigate(App.PanelAddress);
                hasNavigated = true;
            }
            catch (Exception exception)
            {
                if (!disposed)
                {
                    ShowStartup("工作空间浏览器初始化失败。错误码：" + App.ErrorCode(exception), true);
                }
            }
            finally
            {
                initializing = false;
                if (!disposed)
                {
                    retry.IsEnabled = true;
                    if (pendingOpen)
                    {
                        bool nextReload = pendingReload;
                        pendingOpen = false;
                        pendingReload = false;
                        InitializeOrNavigate(true, nextReload);
                    }
                }
            }
        }

        private void ShowStartup(string message, bool canRetry)
        {
            status.Text = message;
            retry.Visibility = canRetry ? WpfVisibility.Visible : WpfVisibility.Collapsed;
            loadingSurface.Visibility = WpfVisibility.Visible;
        }

        private void ConfigureBrowser()
        {
            CoreWebView2 core = browser.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsWebMessageEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args)
            {
                bool allowed = LocalService.AllowsPanelNavigation(args.Uri);
                if (!allowed)
                {
                    args.Cancel = true;
                    ShowStartup("工作空间仅连接已核实的本机 BuildX 服务。", true);
                }
            };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args)
            {
                args.Handled = true;
                ShowStartup("请在当前 BuildX 工作空间继续操作。", true);
            };
            core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs args)
            {
                if (args.IsSuccess) loadingSurface.Visibility = WpfVisibility.Collapsed;
                else
                {
                    hasNavigated = false;
                    ShowStartup("工作空间暂未连接，请重新连接。", true);
                }
            };
            core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs args)
            {
                args.State = CoreWebView2PermissionState.Deny;
            };
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            if (browser != null)
            {
                browser.Dispose();
                browserHost.Children.Clear();
                browser = null;
            }
        }
    }

    // BEGIN SERVICE STARTUP DIAGNOSTIC
    // Each reader belongs to exactly one launched process. It drains all stderr
    // without retaining arbitrary output, and exposes only a fixed, non-secret
    // code after that process has exited and the stream has reached EOF.
    internal sealed class ServiceStartupProcess : IDisposable
    {
        private const int LineLimit = 1024;
        private readonly Process process;
        private readonly Task<bool> diagnostic;

        [DataContract]
        private sealed class StartupRecord
        {
            [DataMember(Name = "service")]
            public string Service { get; set; }
            [DataMember(Name = "error_code")]
            public string ErrorCode { get; set; }
        }

        private ServiceStartupProcess(Process process)
        {
            this.process = process;
            diagnostic = DrainAsync(process.StandardError);
        }

        internal static ServiceStartupProcess Start(ProcessStartInfo start)
        {
            start.RedirectStandardError = true;
            Process child = Process.Start(start);
            if (child == null) throw new InvalidOperationException("Service process did not start.");
            try { return new ServiceStartupProcess(child); }
            catch { child.Dispose(); throw; }
        }

        internal bool HasExited { get { return process.HasExited; } }

        internal async Task<bool> HasChatStoreLockFailureAsync()
        {
            if (!process.HasExited || process.ExitCode == 0) return false;
            // A descendant might inherit the pipe; never wait indefinitely for
            // EOF. Incomplete diagnostics remain an unknown startup failure.
            if (await Task.WhenAny(diagnostic, Task.Delay(1000)) != diagnostic) return false;
            return await diagnostic;
        }

        private static bool IsLockRecord(string line)
        {
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(line);
                using (MemoryStream stream = new MemoryStream(bytes))
                {
                    DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(StartupRecord));
                    StartupRecord record = serializer.ReadObject(stream) as StartupRecord;
                    return record != null && record.Service == "revit-local-codex" && record.ErrorCode == "CHAT_STORE_LOCKED";
                }
            }
            catch (Exception) { return false; }
        }

        private static async Task<bool> DrainAsync(StreamReader reader)
        {
            char[] buffer = new char[512];
            StringBuilder line = new StringBuilder(LineLimit);
            bool tooLong = false;
            bool matched = false;
            try
            {
                int count;
                while ((count = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0)
                {
                    for (int i = 0; i < count; i++)
                    {
                        char c = buffer[i];
                        if (c == '\n')
                        {
                            if (!tooLong && IsLockRecord(line.ToString())) matched = true;
                            line.Length = 0;
                            tooLong = false;
                        }
                        else if (!tooLong)
                        {
                            if (line.Length == LineLimit) { line.Length = 0; tooLong = true; }
                            else if (c != '\r') line.Append(c);
                        }
                    }
                }
                if (!tooLong && line.Length != 0 && IsLockRecord(line.ToString())) matched = true;
                return matched;
            }
            catch (IOException) { return false; }
            catch (ObjectDisposedException) { return false; }
        }

        public void Dispose() { process.Dispose(); }
    }
    // END SERVICE STARTUP DIAGNOSTIC

    // BEGIN BUILDX INSTALLATION
    internal sealed class BuildXInstallationException : Exception
    {
        internal BuildXInstallationException() : base("BuildX installation configuration is unavailable.") { }
    }

    internal sealed class BuildXInstallation
    {
        internal readonly string Root;
        internal readonly string DataRoot;
        internal readonly string InstallationId;
        internal readonly string NodeExecutable;
        internal readonly string PythonExecutable;
        internal readonly string CodexExecutable;
        internal readonly int SchemaVersion;
        internal const int DefaultPanelPort = 41873;
        internal readonly int PanelPort;
        // Compatibility for the schema-1 identity reader; no production
        // configuration can enable the former development-mode exception.
        internal readonly bool DevelopmentMode = false;
        internal string WorkbenchRoot { get { return Path.Combine(DataRoot, "workbench"); } }
        internal string PanelAddress { get { return "http://127.0.0.1:" + PanelPort.ToString(System.Globalization.CultureInfo.InvariantCulture) + "/"; } }
        internal bool AllowsPanelNavigation(string address)
        {
            Uri target;
            return Uri.TryCreate(address, UriKind.Absolute, out target)
                && target.Scheme == Uri.UriSchemeHttp
                && target.Host == "127.0.0.1"
                && target.Port == PanelPort
                && String.IsNullOrEmpty(target.UserInfo);
        }
        internal string WebViewUserDataFolder { get { return SchemaVersion == 1
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevitLocalCodex", "WebView2")
            : Path.Combine(DataRoot, "WebView2"); } }

        [DataContract]
        private sealed class Configuration
        {
            [DataMember(Name = "schemaVersion")] public int SchemaVersion { get; set; }
            [DataMember(Name = "installationId")] public string InstallationId { get; set; }
            [DataMember(Name = "nodeExecutable")] public string NodeExecutable { get; set; }
            [DataMember(Name = "pythonExecutable")] public string PythonExecutable { get; set; }
            [DataMember(Name = "codexExecutable")] public string CodexExecutable { get; set; }
            [DataMember(Name = "dataRoot")] public string DataRoot { get; set; }
            [DataMember(Name = "panelPort")] public object PanelPort { get; set; }
        }

        [DataContract]
        private sealed class DataOwnership
        {
            [DataMember(Name = "schemaVersion", IsRequired = true)] public int SchemaVersion { get; set; }
            [DataMember(Name = "installationId", IsRequired = true)] public string InstallationId { get; set; }
        }

        private BuildXInstallation(string root, string dataRoot, string id, string node, string python, string codex, int schemaVersion, int panelPort)
        {
            Root = root; DataRoot = dataRoot; InstallationId = id; NodeExecutable = node;
            PythonExecutable = python; CodexExecutable = codex; SchemaVersion = schemaVersion; PanelPort = panelPort;
        }

        private static int ResolvePanelPort(int schemaVersion, byte[] configurationBytes)
        {
            string text = new System.Text.UTF8Encoding(false, true).GetString(configurationBytes).TrimStart('\uFEFF');
            var fields = new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(text)
                as System.Collections.Generic.Dictionary<string, object>;
            if (fields == null) throw new BuildXInstallationException();
            object raw;
            if (!fields.TryGetValue("panelPort", out raw)) return DefaultPanelPort;
            if (schemaVersion != 2 || !(raw is int || raw is long || raw is decimal || raw is double)) throw new BuildXInstallationException();
            // Match JSON-number integer semantics: 41874, 41874.0 and 41874e0
            // represent the same integer; strings, null and fractions do not.
            double value = Convert.ToDouble(raw, System.Globalization.CultureInfo.InvariantCulture);
            if (Double.IsNaN(value) || Double.IsInfinity(value) || value < 1024 || value > 65535 || Math.Truncate(value) != value)
                throw new BuildXInstallationException();
            return (int)value;
        }

        private static bool ValidExecutable(string value, string name)
        {
            if (String.IsNullOrEmpty(value) || value.Length > 1024 || value.Length < 4 ||
                !((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) ||
                value[1] != ':' || value[2] != '\\' || !String.Equals(Path.GetFileName(value), name, StringComparison.OrdinalIgnoreCase)) return false;
            return String.Equals(Path.GetFullPath(value), value, StringComparison.OrdinalIgnoreCase);
        }

        private static bool ValidInstallationId(string value)
        {
            Guid id;
            return value != null && Guid.TryParseExact(value, "D", out id) &&
                String.Equals(value, id.ToString("D"), StringComparison.Ordinal) &&
                value[14] == '4' && "89ab".IndexOf(value[19]) >= 0;
        }

        private static bool ValidDataRoot(string value, string programRoot)
        {
            if (String.IsNullOrEmpty(value) || value.Length > 1024 || value.Length < 4 ||
                !((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) ||
                value[1] != ':' || value[2] != '\\' || value[value.Length - 1] == '\\' ||
                !String.Equals(Path.GetFullPath(value), value, StringComparison.OrdinalIgnoreCase)) return false;
            foreach (string segment in value.Substring(3).Split('\\'))
            {
                if (segment.Length == 0 || segment == "." || segment == ".." || segment.EndsWith(".", StringComparison.Ordinal) ||
                    segment.EndsWith(" ", StringComparison.Ordinal) || segment.IndexOfAny(new[] { '<', '>', ':', '"', '/', '|', '?', '*', '\0' }) >= 0) return false;
            }
            string program = programRoot.TrimEnd('\\');
            if (String.Equals(value, program, StringComparison.OrdinalIgnoreCase) ||
                value.StartsWith(program + "\\", StringComparison.OrdinalIgnoreCase) ||
                program.StartsWith(value + "\\", StringComparison.OrdinalIgnoreCase)) return false;
            // Lexical separation alone cannot establish that a configured
            // directory does not redirect into the program or another tree.
            string current = value;
            while (current != null)
            {
                try
                {
                    FileAttributes attributes = File.GetAttributes(current);
                    if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0) return false;
                }
                catch (FileNotFoundException) { }
                catch (DirectoryNotFoundException) { }
                current = Path.GetDirectoryName(current);
            }
            return true;
        }

        private static void RequireDataOwnership(string dataRoot, string installationId)
        {
            string file = Path.Combine(dataRoot, "buildx-data-owner.json");
            FileAttributes attributes = File.GetAttributes(file);
            if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) throw new BuildXInstallationException();
            byte[] bytes;
            using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (stream.Length < 1 || stream.Length > 4096) throw new BuildXInstallationException();
                bytes = new byte[(int)stream.Length];
                int offset = 0;
                while (offset < bytes.Length)
                {
                    int read = stream.Read(bytes, offset, bytes.Length - offset);
                    if (read == 0) throw new BuildXInstallationException();
                    offset += read;
                }
                if (stream.ReadByte() != -1 || stream.Length != bytes.Length) throw new BuildXInstallationException();
                attributes = File.GetAttributes(file);
                if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) throw new BuildXInstallationException();
            }
            DataOwnership ownership;
            using (MemoryStream stream = new MemoryStream(bytes))
                ownership = new DataContractJsonSerializer(typeof(DataOwnership)).ReadObject(stream) as DataOwnership;
            // The data-contract reader rejects missing/duplicate named members;
            // also reject unknown members instead of silently accepting a
            // marker whose format belongs to a different owner/version.
            string text = new System.Text.UTF8Encoding(false, true).GetString(bytes).TrimStart('\uFEFF');
            var fields = new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(text)
                as System.Collections.Generic.Dictionary<string, object>;
            if (fields == null || fields.Count != 2 || !fields.ContainsKey("schemaVersion") || !fields.ContainsKey("installationId") ||
                ownership == null || ownership.SchemaVersion != 1 || !String.Equals(ownership.InstallationId, installationId, StringComparison.Ordinal))
                throw new BuildXInstallationException();
        }

        internal static BuildXInstallation FromAssemblyLocation(string assemblyLocation)
        {
            try
            {
                string assembly = Path.GetFullPath(assemblyLocation);
                string binaryDir = Path.GetDirectoryName(assembly);
                string addinDir = Path.GetDirectoryName(binaryDir);
                string root = Path.GetDirectoryName(addinDir);
                if (!String.Equals(Path.GetFileName(assembly), "LocalCodexRevit.dll", StringComparison.OrdinalIgnoreCase) ||
                    !String.Equals(Path.GetFileName(addinDir), "revit-addin", StringComparison.OrdinalIgnoreCase) ||
                    String.IsNullOrEmpty(root) || !File.Exists(Path.Combine(root, "server.mjs"))) throw new BuildXInstallationException();

                string file = Path.Combine(root, "buildx-installation.json");
                FileAttributes configurationAttributes = File.GetAttributes(file);
                if ((configurationAttributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) throw new BuildXInstallationException();
                Configuration configuration;
                byte[] configurationBytes;
                using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    if (stream.Length == 0 || stream.Length > 4096) throw new BuildXInstallationException();
                    using (var buffer = new MemoryStream()) { stream.CopyTo(buffer); configurationBytes = buffer.ToArray(); }
                }
                if (configurationBytes.Length == 0 || configurationBytes.Length > 4096) throw new BuildXInstallationException();
                using (var buffer = new MemoryStream(configurationBytes))
                    configuration = new DataContractJsonSerializer(typeof(Configuration)).ReadObject(buffer) as Configuration;
                if (configuration == null || (configuration.SchemaVersion != 1 && configuration.SchemaVersion != 2) || !ValidInstallationId(configuration.InstallationId) ||
                    !ValidExecutable(configuration.NodeExecutable, "node.exe") || !ValidExecutable(configuration.PythonExecutable, "python.exe") ||
                    !ValidExecutable(configuration.CodexExecutable, "codex.exe")) throw new BuildXInstallationException();
                if (configuration.SchemaVersion == 1 && configuration.DataRoot != null ||
                    configuration.SchemaVersion == 2 && !ValidDataRoot(configuration.DataRoot, root)) throw new BuildXInstallationException();
                if (configuration.SchemaVersion == 2) RequireDataOwnership(configuration.DataRoot, configuration.InstallationId);
                int panelPort = ResolvePanelPort(configuration.SchemaVersion, configurationBytes);
                // A schema-1 configuration retains its original state paths.
                // Upgrading the format never silently relocates old receipts.
                return new BuildXInstallation(root, configuration.SchemaVersion == 1 ? root : configuration.DataRoot,
                    configuration.InstallationId, configuration.NodeExecutable, configuration.PythonExecutable,
                    configuration.CodexExecutable, configuration.SchemaVersion, panelPort);
            }
            catch (BuildXInstallationException) { throw; }
            catch (Exception) { throw new BuildXInstallationException(); }
        }

        internal bool MatchesService(string service, string id)
        {
            return service == "revit-local-codex" && InstallationId != null && String.Equals(InstallationId, id, StringComparison.Ordinal);
        }
    }
    // END BUILDX INSTALLATION

    internal static class LocalService
    {
        private static BuildXInstallation installation;
        private static BuildXInstallation Installation
        {
            get
            {
                if (installation == null) installation = BuildXInstallation.FromAssemblyLocation(typeof(App).Assembly.Location);
                return installation;
            }
        }
        internal static void ValidateInstallation() { BuildXInstallation value = Installation; }
        internal static string ServiceDirectory { get { return Installation.Root; } }
        internal static string DataDirectory { get { return Installation.DataRoot; } }
        internal static string WorkbenchDirectory { get { return Installation.WorkbenchRoot; } }
        internal static string WebViewUserDataFolder { get { return Installation.WebViewUserDataFolder; } }
        internal static string PanelAddress { get { return Installation.PanelAddress; } }
        internal static bool AllowsPanelNavigation(string address) { return Installation.AllowsPanelNavigation(address); }
        private static ServiceStartupProcess launchedProcess;

        [DataContract]
        private sealed class ServiceIdentity
        {
            [DataMember(Name = "service", IsRequired = true)]
            public string Service { get; set; }
            [DataMember(Name = "installationId", IsRequired = true)]
            public string InstallationId { get; set; }
        }

        private enum ProbeResult
        {
            ExpectedService,
            ConnectionRefused,
            TimedOut,
            UnexpectedService,
            TransportFailure
        }

        private static async Task<ProbeResult> ProbeAsync()
        {
            using (HttpClientHandler handler = new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
            using (HttpClient client = new HttpClient(handler))
            {
                // On Windows/.NET Framework, a refused loopback connection can take
                // more than two seconds to report its SocketError. Do not mistake
                // cancellation before that response for an unidentified listener.
                client.Timeout = TimeSpan.FromSeconds(5);
                client.MaxResponseContentBufferSize = 8192;
                try
                {
                    // Identity is independent of the changing account/tool UI
                    // snapshot, whose size must not prevent startup/recovery.
                    using (HttpResponseMessage response = await client.GetAsync(App.PanelAddress + "api/service-identity"))
                    {
                        if (!response.IsSuccessStatusCode) return ProbeResult.UnexpectedService;
                        using (Stream body = await response.Content.ReadAsStreamAsync())
                        {
                            DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(ServiceIdentity));
                            ServiceIdentity identity = serializer.ReadObject(body) as ServiceIdentity;
                            return identity != null && Installation.MatchesService(identity.Service, identity.InstallationId)
                                ? ProbeResult.ExpectedService : ProbeResult.UnexpectedService;
                        }
                    }
                }
                catch (HttpRequestException exception)
                {
                    for (Exception cause = exception; cause != null; cause = cause.InnerException)
                    {
                        SocketException socket = cause as SocketException;
                        if (socket != null && socket.SocketErrorCode == SocketError.ConnectionRefused)
                            return ProbeResult.ConnectionRefused;
                    }
                    return ProbeResult.TransportFailure;
                }
                catch (TaskCanceledException) { return ProbeResult.TimedOut; }
                catch (SerializationException) { return ProbeResult.UnexpectedService; }
            }
        }

        private static string ProbeFailureMessage(ProbeResult result)
        {
            if (result == ProbeResult.TimedOut)
                return "本地服务检查超时（5 秒），尚不能确认端口状态，请稍后点击“重试”。";
            if (result == ProbeResult.UnexpectedService)
                return "端口 " + Installation.PanelPort.ToString(System.Globalization.CultureInfo.InvariantCulture) + " 已响应，但未通过本地 Codex 服务身份检查，请检查服务后重试。";
            return "无法确认端口 " + Installation.PanelPort.ToString(System.Globalization.CultureInfo.InvariantCulture) + " 的连接状态，请检查本地服务后重试。";
        }

        internal static async Task<string> EnsureAvailableAsync(bool allowStart, Action onServiceAbsent)
        {
            ProbeResult probe = await ProbeAsync();
            if (probe == ProbeResult.ExpectedService) return null;
            // Start only after an explicit refusal. A timeout or transport error
            // cannot establish that the port is free or the service is absent.
            if (probe != ProbeResult.ConnectionRefused) return ProbeFailureMessage(probe);
            if (onServiceAbsent != null) onServiceAbsent();
            if (!allowStart) return "本地服务尚未运行，请点击“重试”。";

            string script = Path.Combine(ServiceDirectory, "server.mjs");
            BuildXInstallation config = Installation;
            if (!File.Exists(config.NodeExecutable) || !File.Exists(script) ||
                !File.Exists(config.PythonExecutable) || !File.Exists(config.CodexExecutable))
                return "BuildX 所需的运行环境未找到，请运行安装检查。";
            try
            {
                if (launchedProcess != null && launchedProcess.HasExited)
                {
                    launchedProcess.Dispose();
                    launchedProcess = null;
                }
                if (launchedProcess == null)
                {
                    ProcessStartInfo start = new ProcessStartInfo
                    {
                        FileName = config.NodeExecutable,
                        Arguments = "\"" + script + "\"",
                        WorkingDirectory = ServiceDirectory,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    start.EnvironmentVariables["BUILDX_PYTHON_EXE"] = config.PythonExecutable;
                    start.EnvironmentVariables["BUILDX_CODEX_EXE"] = config.CodexExecutable;
                    start.EnvironmentVariables["BUILDX_DATA_ROOT"] = config.DataRoot;
                    launchedProcess = ServiceStartupProcess.Start(start);
                }
                for (int attempt = 0; attempt < 8; attempt++)
                {
                    await Task.Delay(150);
                    probe = await ProbeAsync();
                    if (probe == ProbeResult.ExpectedService) return null;
                    if (launchedProcess.HasExited)
                    {
                        if (await launchedProcess.HasChatStoreLockFailureAsync())
                            return "对话保存目录被其他实例占用，尚未接管；请检查原服务或恢复锁。";
                        return "本地服务启动未完成，请检查服务状态后重试。";
                    }
                    if (probe != ProbeResult.ConnectionRefused) return ProbeFailureMessage(probe);
                }
                return "本地服务尚未就绪，请稍后点击“重试”。";
            }
            catch (Exception exception)
            {
                return "本地服务启动失败。错误码：" + App.ErrorCode(exception);
            }
        }

        internal static void ReleaseHandle()
        {
            if (launchedProcess == null) return;
            launchedProcess.Dispose();
            launchedProcess = null;
        }
    }
}
