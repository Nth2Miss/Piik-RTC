using System;
using System.Collections.Generic;
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
        private ContextMenuStrip _contextMenu;
        private string _serverOrigin = "";
        private bool _showingSetup;
        private bool _authRequired;
        private bool _authAttempted;
        private string _authError = "";
        private string _authUserName = "";
        private string _lastAuthUser = "";
        private string _pendingAuthUser;
        private string _pendingAuthPassword;
        private readonly HashSet<string> _autoAuthTried = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private readonly bool _debug;
        private FormWindowState _stateBeforeFullscreen = FormWindowState.Normal;
        private FormBorderStyle _borderBeforeFullscreen = FormBorderStyle.Sizable;

        public AppConfig Config { get { return _config; } }
        public string ServerUrl { get { return _config.ServerUrl; } }

        private string ServerOrigin
        {
            get
            {
                if (string.IsNullOrWhiteSpace(_config.ServerUrl)) return "";
                try { return new Uri(_config.ServerUrl).GetLeftPart(UriPartial.Authority); }
                catch { return ""; }
            }
        }

        public MainForm(AppConfig config, string[] args)
        {
            _config = config;
            _debug = Array.Exists(args, argument => string.Equals(argument, "--debug", StringComparison.OrdinalIgnoreCase));
            _browserArguments = "--autoplay-policy=no-user-gesture-required";
            if (_debug) _browserArguments += " --remote-debugging-port=9222 --remote-allow-origins=*";

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

            BuildContextMenu();
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

        private void BuildContextMenu()
        {
            _contextMenu = new ContextMenuStrip();
            _contextMenu.Items.Add(new ToolStripMenuItem("服务器设置…", null, (_, __) => ShowSetup("")));
            _contextMenu.Items.Add(new ToolStripMenuItem("清除保存的登录信息…", null, (_, __) => ForgetCredentials()));
            _contextMenu.Items.Add(new ToolStripMenuItem("重新加载", null, (_, __) =>
            {
                if (_webView?.CoreWebView2 != null) _webView.CoreWebView2.Reload();
            }));
            _contextMenu.Items.Add(new ToolStripMenuItem("开发者工具", null, (_, __) =>
            {
                if (_webView?.CoreWebView2 != null) _webView.CoreWebView2.OpenDevToolsWindow();
            }));
            _contextMenu.Items.Add(new ToolStripMenuItem("检查更新…", null, (_, __) => { _ = UpdateChecker.CheckAsync(this, true); }));
            _contextMenu.Items.Add(new ToolStripSeparator());
            _contextMenu.Items.Add(new ToolStripMenuItem("退出", null, (_, __) => Close()));
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
                core.Settings.AreDefaultContextMenusEnabled = true;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = true;
                core.Settings.IsSwipeNavigationEnabled = false;
                core.Settings.IsZoomControlEnabled = true;

                SetupVirtualHost(core);
                var shim = ResourceText("Piik.Shim.js");
                if (!string.IsNullOrEmpty(shim)) await core.AddScriptToExecuteOnDocumentCreatedAsync(shim);

                _bridge = new Bridge(this, core);
                core.WebMessageReceived += (_, eventArgs) =>
                {
                    var source = eventArgs.Source ?? "";
                    if (!IsTrusted(source) && !IsSetupAddress(source)) return;
                    try
                    {
                        var request = SimpleJson.ParseObject(eventArgs.WebMessageAsJson);
                        if (string.Equals(Bridge.GetString(request, "type"), "ui-dismiss", StringComparison.Ordinal))
                        {
                            _contextMenu?.Close();
                        }
                    }
                    catch { /* malformed messages are handled by the bridge */ }
                };
                core.WebMessageReceived += _bridge.HandleMessage;
                core.ContextMenuRequested += (_, eventArgs) =>
                {
                    eventArgs.Handled = true;
                    _contextMenu?.Show(_webView, eventArgs.Location);
                };
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
                core.BasicAuthenticationRequested += BasicAuthenticationRequested;
                core.ContainsFullScreenElementChanged += (_, __) => ToggleFullscreen();
                core.DownloadStarting += DownloadStarting;
                core.DocumentTitleChanged += (_, __) =>
                {
                    if (!_showingSetup)
                    {
                        // The server page rendered, so the credentials used for this
                        // navigation were accepted; allow saved credentials again later.
                        _authAttempted = false;
                        _autoAuthTried.Clear();
                    }
                    Text = _showingSetup ? "Piik-RTC 桌面端" : (string.IsNullOrWhiteSpace(core.DocumentTitle) ? "Piik-RTC" : core.DocumentTitle);
                };
                core.ProcessFailed += (_, eventArgs) => Log.Write("webview process failed: " + eventArgs.ProcessFailedKind);

                if (string.IsNullOrWhiteSpace(_config.ServerUrl)) ShowSetup("");
                else NavigateServer(_config.ServerUrl);
                if (!_debug && !IsDisposed) _ = UpdateChecker.CheckAsync(this, false);
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
            if (eventArgs.IsSuccess)
            {
                _authAttempted = false;
                _autoAuthTried.Clear();
                return;
            }
            if (_showingSetup)
            {
                Log.Write("setup page failed: " + eventArgs.WebErrorStatus);
                return;
            }
            if (_authRequired)
            {
                _authRequired = false;
                ShowAuth();
                return;
            }
            // 服务器要求 HTTP 认证时，WebView2 会先以该状态结束导航并等待登录结果，
            // 此时不能跳回设置页，否则会打断登录。
            if (eventArgs.WebErrorStatus == CoreWebView2WebErrorStatus.ValidAuthenticationCredentialsRequired)
            {
                Log.Write("server requires authentication");
                return;
            }
            if (eventArgs.WebErrorStatus == CoreWebView2WebErrorStatus.ValidProxyAuthenticationRequired)
            {
                ShowSetup("代理服务器要求登录，请检查系统代理设置后重试。");
                return;
            }
            Log.Write("navigation failed: " + eventArgs.WebErrorStatus);
            ShowSetup("无法连接服务器：" + eventArgs.WebErrorStatus);
        }

        private void BasicAuthenticationRequested(object sender, CoreWebView2BasicAuthenticationRequestedEventArgs eventArgs)
        {
            var origin = "";
            try { origin = new Uri(eventArgs.Uri).GetLeftPart(UriPartial.Authority); } catch { }
            if (origin.Length == 0)
            {
                eventArgs.Cancel = true;
                return;
            }

            if (!string.IsNullOrEmpty(_pendingAuthUser) && string.Equals(origin, ServerOrigin, StringComparison.OrdinalIgnoreCase))
            {
                eventArgs.Response.UserName = _pendingAuthUser;
                eventArgs.Response.Password = _pendingAuthPassword ?? "";
                _lastAuthUser = _pendingAuthUser;
                _pendingAuthUser = null;
                _pendingAuthPassword = null;
                _authAttempted = true;
                _autoAuthTried.Add(origin);
                Log.Write("auth: using submitted credentials for " + origin);
                return;
            }

            string savedUser, savedPassword;
            var saved = CredentialStore.TryGet(origin, out savedUser, out savedPassword);
            if (saved && !_autoAuthTried.Contains(origin))
            {
                _autoAuthTried.Add(origin);
                eventArgs.Response.UserName = savedUser;
                eventArgs.Response.Password = savedPassword;
                _lastAuthUser = savedUser;
                _authAttempted = true;
                Log.Write("auth: using saved credentials for " + origin);
                return;
            }

            // No usable credentials: cancel this navigation and show the in-app login page.
            eventArgs.Cancel = true;
            _authRequired = true;
            _authError = "";
            _authUserName = _lastAuthUser;
            if (saved)
            {
                // The saved password no longer works; drop it so future launches prompt directly.
                CredentialStore.Remove(origin);
                _authError = "保存的用户名或密码不正确，请重新输入。";
                _authUserName = savedUser;
            }
            else if (_authAttempted)
            {
                _authError = "用户名或密码不正确，请重新输入。";
            }
            _authAttempted = false;
            Log.Write("auth: prompting for " + origin);
        }

        private void ShowAuth()
        {
            if (_webView == null || _webView.CoreWebView2 == null) return;
            try { _bridge?.StopAll(); } catch { }
            _showingSetup = true;
            Text = "Piik-RTC 桌面端";
            var version = Assembly.GetEntryAssembly() != null ? Assembly.GetEntryAssembly().GetName().Version.ToString(3) : "1.0.0";
            var url = "https://piik.setup/setup.html?mode=auth"
                + "&host=" + Uri.EscapeDataString(ServerOrigin)
                + "&user=" + Uri.EscapeDataString(_authUserName ?? "")
                + "&remember=" + (_config.RememberAuth ? "1" : "0")
                + "&error=" + Uri.EscapeDataString(_authError ?? "")
                + "&version=" + Uri.EscapeDataString(version);
            _authError = "";
            _webView.CoreWebView2.Navigate(url);
        }

        public void SubmitAuth(string userName, string password, bool remember)
        {
            var origin = ServerOrigin;
            if (string.IsNullOrEmpty(origin) || string.IsNullOrWhiteSpace(_config.ServerUrl)) return;
            if (remember != _config.RememberAuth)
            {
                _config.RememberAuth = remember;
                _config.Save();
            }
            if (remember) CredentialStore.Save(origin, userName, password);
            else CredentialStore.Remove(origin);
            _pendingAuthUser = userName ?? "";
            _pendingAuthPassword = password ?? "";
            NavigateServer(_config.ServerUrl);
        }

        public void CancelAuth()
        {
            _pendingAuthUser = null;
            _pendingAuthPassword = null;
            ShowSetup("已取消服务器登录，请重新连接并输入用户名和密码。");
        }

        private void ForgetCredentials()
        {
            var origin = "";
            try { origin = new Uri(_config.ServerUrl).GetLeftPart(UriPartial.Authority); } catch { }
            if (origin.Length == 0) return;
            if (MessageBox.Show(this,
                    "将删除本机保存的服务器登录账号和密码，下次连接时需要重新输入。\n\n确定要清除吗？",
                    "Piik-RTC", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            CredentialStore.Remove(origin);
            _autoAuthTried.Remove(origin);
            MessageBox.Show(this, "已清除保存的登录信息。重新启动程序后，连接服务器时会重新要求登录。",
                "Piik-RTC", MessageBoxButtons.OK, MessageBoxIcon.Information);
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
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Normal;
                WindowState = FormWindowState.Maximized;
            }
            else
            {
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
