using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PiikDesktop
{
    internal sealed class MainForm : Form, IBridgeHost
    {
        private readonly AppConfig _config;
        private readonly string _browserArguments;
        private WebView2 _webView;
        private Bridge _bridge;
        private MenuStrip _menu;
        private ToolStripMenuItem _reloadItem;
        private ToolStripMenuItem _devToolsItem;
        private string _serverOrigin = "";
        private bool _showingSetup;
        private FormWindowState _stateBeforeFullscreen = FormWindowState.Normal;
        private FormBorderStyle _borderBeforeFullscreen = FormBorderStyle.Sizable;
        private bool _menuVisibleBeforeFullscreen = true;

        public AppConfig Config { get { return _config; } }
        public string ServerUrl { get { return _config.ServerUrl; } }

        public MainForm(AppConfig config, string[] args)
        {
            _config = config;
            var debug = Array.Exists(args, argument => string.Equals(argument, "--debug", StringComparison.OrdinalIgnoreCase));
            _browserArguments = "--autoplay-policy=no-user-gesture-required";
            if (debug) _browserArguments += " --remote-debugging-port=9222 --remote-allow-origins=*";

            Text = "Piik-RTC";
            MinimumSize = new Size(980, 640);
            BackColor = Color.FromArgb(243, 245, 248);
            StartPosition = FormStartPosition.Manual;
            RestoreOrCenter();
            try
            {
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Piik.Icon.ico"))
                {
                    if (stream != null) Icon = new Icon(stream);
                }
            }
            catch { /* icon is optional */ }

            BuildMenu();
            _webView = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.FromArgb(243, 245, 248),
            };
            Controls.Add(_webView);
            Controls.SetChildIndex(_webView, 0);

            Load += async (_, __) => await InitializeAsync();
            FormClosing += (_, __) =>
            {
                try { _bridge?.StopAll(); } catch { }
                var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                _config.Width = bounds.Width;
                _config.Height = bounds.Height;
                _config.X = bounds.X;
                _config.Y = bounds.Y;
                _config.Save();
            };
        }

        private void RestoreOrCenter()
        {
            var width = Math.Max(980, _config.Width);
            var height = Math.Max(640, _config.Height);
            var bounds = new Rectangle(_config.X, _config.Y, width, height);
            if (_config.X == int.MinValue || _config.Y == int.MinValue || !IsVisibleOnAnyScreen(bounds))
            {
                var working = Screen.PrimaryScreen.WorkingArea;
                bounds = new Rectangle(
                    working.X + Math.Max(0, (working.Width - 1280) / 2),
                    working.Y + Math.Max(0, (working.Height - 860) / 2),
                    1280,
                    860);
            }
            Bounds = bounds;
        }

        private static bool IsVisibleOnAnyScreen(Rectangle bounds)
        {
            foreach (var screen in Screen.AllScreens)
            {
                var area = screen.WorkingArea;
                if (bounds.Left < area.Right && bounds.Right > area.Left && bounds.Top < area.Bottom && bounds.Bottom > area.Top) return true;
            }
            return false;
        }

        private void BuildMenu()
        {
            _menu = new MenuStrip { Dock = DockStyle.Top };
            var file = new ToolStripMenuItem("文件");
            file.DropDownItems.Add(new ToolStripMenuItem("服务器设置…", null, (_, __) => ShowSetup("")) { ShortcutKeys = Keys.Control | Keys.Shift | Keys.U });
            file.DropDownItems.Add(new ToolStripSeparator());
            file.DropDownItems.Add(new ToolStripMenuItem("退出", null, (_, __) => Close()));

            var view = new ToolStripMenuItem("查看");
            _reloadItem = new ToolStripMenuItem("重新加载", null, (_, __) => { if (_webView.CoreWebView2 != null) _webView.CoreWebView2.Reload(); }) { ShortcutKeys = Keys.Control | Keys.R };
            _devToolsItem = new ToolStripMenuItem("开发者工具", null, (_, __) => { if (_webView.CoreWebView2 != null) _webView.CoreWebView2.OpenDevToolsWindow(); }) { ShortcutKeys = Keys.F12 };
            view.DropDownItems.Add(_reloadItem);
            view.DropDownItems.Add(_devToolsItem);

            _menu.Items.Add(file);
            _menu.Items.Add(view);
            MainMenuStrip = _menu;
            Controls.Add(_menu);
        }

        private async System.Threading.Tasks.Task InitializeAsync()
        {
            try
            {
                var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PiikDesktop", "WebView2");
                Directory.CreateDirectory(userData);
                var options = new CoreWebView2EnvironmentOptions(_browserArguments);
                var environment = await CoreWebView2Environment.CreateAsync(null, userData, options);
                await _webView.EnsureCoreWebView2Async(environment);
                var core = _webView.CoreWebView2;
                core.Settings.AreDevToolsEnabled = true;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = true;
                core.Settings.IsSwipeNavigationEnabled = false;
                core.Settings.IsZoomControlEnabled = true;

                SetupVirtualHost(core);
                var shim = ResourceText("Piik.Shim.js");
                if (!string.IsNullOrEmpty(shim)) await core.AddScriptToExecuteOnDocumentCreatedAsync(shim);

                _bridge = new Bridge(this, core);
                core.WebMessageReceived += _bridge.HandleMessage;
                core.NavigationStarting += (_, eventArgs) => NavigationStarting(eventArgs);
                core.NavigationCompleted += (_, eventArgs) => NavigationCompleted(eventArgs);
                core.NewWindowRequested += (_, eventArgs) =>
                {
                    eventArgs.Handled = true;
                    OpenExternal(eventArgs.Uri);
                };
                core.PermissionRequested += (_, eventArgs) =>
                {
                    eventArgs.State = IsTrusted(eventArgs.Uri)
                        ? CoreWebView2PermissionState.Allow
                        : CoreWebView2PermissionState.Deny;
                };
                core.ContainsFullScreenElementChanged += (_, __) => ToggleFullscreen();
                core.DownloadStarting += DownloadStarting;
                core.DocumentTitleChanged += (_, __) =>
                {
                    Text = _showingSetup ? "Piik-RTC 桌面端" : (string.IsNullOrWhiteSpace(core.DocumentTitle) ? "Piik-RTC" : core.DocumentTitle);
                };
                core.ProcessFailed += (_, eventArgs) => Log.Write("webview process failed: " + eventArgs.ProcessFailedKind);

                if (string.IsNullOrWhiteSpace(_config.ServerUrl)) ShowSetup("");
                else NavigateServer(_config.ServerUrl);
            }
            catch (Exception exception)
            {
                Log.Write("webview init failed: " + exception);
                MessageBox.Show("无法启动 WebView2。请确认已安装 Microsoft Edge WebView2 运行时。\n\n" + exception.Message,
                    "Piik-RTC 桌面端", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        private static void SetupVirtualHost(CoreWebView2 core)
        {
            var folder = Path.Combine(Path.GetTempPath(), "PiikDesktop", "setup");
            Directory.CreateDirectory(folder);
            var setup = ResourceText("Piik.Setup.html");
            if (!string.IsNullOrEmpty(setup)) File.WriteAllText(Path.Combine(folder, "setup.html"), setup, new UTF8Encoding(true));
            core.SetVirtualHostNameToFolderMapping("piik.setup", folder, CoreWebView2HostResourceAccessKind.DenyCors);
        }

        private static string ResourceText(string name)
        {
            try
            {
                using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
                {
                    if (stream == null) return "";
                    using (var reader = new StreamReader(stream, Encoding.UTF8)) return reader.ReadToEnd();
                }
            }
            catch (Exception exception)
            {
                Log.Write("resource " + name + " failed: " + exception.Message);
                return "";
            }
        }

        public void ShowSetup(string error)
        {
            if (_webView == null || _webView.CoreWebView2 == null) return;
            try { _bridge?.StopAll(); } catch { }
            _showingSetup = true;
            Text = "Piik-RTC 桌面端";
            var version = Assembly.GetEntryAssembly() != null ? Assembly.GetEntryAssembly().GetName().Version.ToString(3) : "1.0.0";
            var url = "https://piik.setup/setup.html?url=" + Uri.EscapeDataString(_config.ServerUrl ?? "")
                + "&error=" + Uri.EscapeDataString(error ?? "")
                + "&version=" + Uri.EscapeDataString(version);
            _webView.CoreWebView2.Navigate(url);
        }

        public void NavigateServer(string url)
        {
            if (_webView == null || _webView.CoreWebView2 == null) return;
            try { _bridge?.StopAll(); } catch { }
            _showingSetup = false;
            try { _serverOrigin = new Uri(url).GetLeftPart(UriPartial.Authority); }
            catch { _serverOrigin = ""; }
            _webView.CoreWebView2.Navigate(url);
        }

        private bool IsTrusted(string url)
        {
            if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(_serverOrigin)) return false;
            return url.StartsWith(_serverOrigin + "/", StringComparison.OrdinalIgnoreCase)
                || string.Equals(url, _serverOrigin, StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsSetupAddress(string url)
        {
            return !string.IsNullOrEmpty(url) && url.StartsWith("https://piik.setup/", StringComparison.OrdinalIgnoreCase);
        }

        private void NavigationStarting(CoreWebView2NavigationStartingEventArgs eventArgs)
        {
            var uri = eventArgs.Uri ?? "";
            if (IsSetupAddress(uri))
            {
                _bridge?.StopAll();
                return;
            }
            if (IsTrusted(uri))
            {
                _bridge?.StopAll();
                return;
            }
            eventArgs.Cancel = true;
            OpenExternal(uri);
        }

        private void NavigationCompleted(CoreWebView2NavigationCompletedEventArgs eventArgs)
        {
            if (eventArgs.IsSuccess) return;
            if (_showingSetup)
            {
                Log.Write("setup page failed: " + eventArgs.WebErrorStatus);
                return;
            }
            ShowSetup("无法连接服务器：" + eventArgs.WebErrorStatus);
        }

        private static void OpenExternal(string uri)
        {
            if (string.IsNullOrWhiteSpace(uri)) return;
            if (!uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return;
            try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
        }

        private void ToggleFullscreen()
        {
            var fullscreen = _webView.CoreWebView2 != null && _webView.CoreWebView2.ContainsFullScreenElement;
            if (fullscreen)
            {
                _stateBeforeFullscreen = WindowState;
                _borderBeforeFullscreen = FormBorderStyle;
                _menuVisibleBeforeFullscreen = _menu.Visible;
                _menu.Visible = false;
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Normal;
                WindowState = FormWindowState.Maximized;
            }
            else
            {
                _menu.Visible = _menuVisibleBeforeFullscreen;
                FormBorderStyle = _borderBeforeFullscreen;
                WindowState = _stateBeforeFullscreen;
            }
        }

        private void DownloadStarting(object sender, CoreWebView2DownloadStartingEventArgs eventArgs)
        {
            using (var dialog = new SaveFileDialog())
            {
                dialog.FileName = Path.GetFileName(eventArgs.ResultFilePath);
                dialog.Filter = "所有文件 (*.*)|*.*";
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    eventArgs.ResultFilePath = dialog.FileName;
                    eventArgs.Handled = true;
                }
                else
                {
                    eventArgs.Cancel = true;
                    eventArgs.Handled = true;
                }
            }
        }
    }
}
