using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace PiikDesktop
{
    internal sealed class ReleaseInfo
    {
        public Version Version { get; set; }
        public string Tag { get; set; }
        public List<string> AssetUrls { get; } = new List<string>();
    }

    /// <summary>
    /// Checks GitHub Releases on startup and installs a newer portable executable.
    /// Git operations prefer https://v4.gh-proxy.org/ and fall back to GitHub directly.
    /// </summary>
    internal static class UpdateChecker
    {
        private const string Owner = "Nth2Miss";
        private const string Repository = "Piik-RTC";
        private const string ProxyBase = "https://v4.gh-proxy.org/";
        private const string ApiUrl = "https://api.github.com/repos/" + Owner + "/" + Repository + "/releases/latest";
        private const string ReleasesLatestUrl = "https://github.com/" + Owner + "/" + Repository + "/releases/latest";
        private const string ReleasesAtomUrl = "https://github.com/" + Owner + "/" + Repository + "/releases.atom";
        private const string VersionManifestUrl = "https://github.com/" + Owner + "/" + Repository + "/releases/latest/download/version.json";

        private static readonly HttpClient Client = CreateClient(true);
        private static readonly HttpClient NoRedirectClient = CreateClient(false);
        private static readonly Regex TagPattern = new Regex(
            @"/releases/tag/(?<tag>v?\d+(?:\.\d+){1,3})",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex VersionPattern = new Regex(
            @"(?<tag>v?\d+(?:\.\d+){1,3})",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static int _running;

        public static async Task CheckAsync(IWin32Window owner, bool manual)
        {
            if (!manual && IsDisabled()) return;
            if (Interlocked.Exchange(ref _running, 1) != 0)
            {
                if (manual) MessageBox.Show(owner, "正在检查更新，请稍候。", "Piik-RTC 更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            try
            {
                var current = CurrentVersion();
                var release = await FindLatestAsync();
                if (release == null)
                {
                    Log.Write("update check: no release information");
                    if (manual) MessageBox.Show(owner, "检查更新失败，请检查网络后重试。", "Piik-RTC 更新", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                Log.Write("update check: current=" + current + " latest=" + release.Version);
                if (release.Version.CompareTo(current) <= 0)
                {
                    if (manual) MessageBox.Show(owner, "当前已是最新版本 v" + current.ToString(3) + "。", "Piik-RTC 更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                var executable = Application.ExecutablePath;
                var directory = Path.GetDirectoryName(executable) ?? "";
                var target = Path.Combine(directory, "Piik-v" + release.Version.ToString(3) + ".exe");
                if (!SamePath(target, executable) && File.Exists(target) && MatchesVersion(target, release.Version))
                {
                    if (ConfirmRestart(owner, release)) StartUpdateAndExit(target);
                    return;
                }

                var answer = MessageBox.Show(
                    owner,
                    "发现新版本 v" + release.Version.ToString(3) + "\n当前版本 v" + current.ToString(3) + "\n\n是否立即下载并更新？更新完成后应用会自动重启。",
                    "Piik-RTC 更新",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Information);
                if (answer != DialogResult.Yes) return;

                string downloaded;
                using (var form = new UpdateProgressForm(release.Version, (progress, token) => DownloadAsync(release, target, progress, token)))
                {
                    var result = form.ShowDialog(owner);
                    if (result != DialogResult.OK)
                    {
                        if (form.Error != null)
                        {
                            Log.Write("update download failed: " + form.Error);
                            MessageBox.Show(
                                owner,
                                "更新下载失败：\n" + form.Error.Message + "\n\n请稍后重试，或到 GitHub Releases 手动下载。",
                                "Piik-RTC 更新",
                                MessageBoxButtons.OK,
                                MessageBoxIcon.Error);
                        }
                        return;
                    }
                    downloaded = form.DownloadedPath;
                }

                if (ConfirmRestart(owner, release)) StartUpdateAndExit(downloaded);
            }
            catch (Exception exception)
            {
                Log.Write("update check failed: " + exception);
                if (manual) MessageBox.Show(owner, "检查更新失败：" + exception.Message, "Piik-RTC 更新", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                Interlocked.Exchange(ref _running, 0);
            }
        }

        private static HttpClient CreateClient(bool allowRedirect)
        {
            try { ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12; } catch { }
            var handler = new HttpClientHandler
            {
                AllowAutoRedirect = allowRedirect,
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            };
            var client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("Piik-RTC-Updater/1.0");
            return client;
        }

        private static bool IsDisabled()
        {
            var value = Environment.GetEnvironmentVariable("PIIK_DISABLE_UPDATE");
            return string.Equals(value, "1", StringComparison.OrdinalIgnoreCase)
                || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);
        }

        private static Version CurrentVersion()
        {
            var assembly = Assembly.GetEntryAssembly() ?? Assembly.GetExecutingAssembly();
            return Normalize(assembly.GetName().Version);
        }

        private static Version Normalize(Version value)
        {
            if (value == null) return new Version(0, 0, 0);
            return new Version(value.Major, Math.Max(0, value.Minor), Math.Max(0, value.Build));
        }

        private static Version ParseVersion(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return null;
            var match = VersionPattern.Match(text.Trim());
            if (!match.Success) return null;
            var raw = match.Groups["tag"].Value.TrimStart('v', 'V');
            Version version;
            if (!Version.TryParse(raw, out version)) return null;
            return Normalize(version);
        }

        private static async Task<ReleaseInfo> FindLatestAsync()
        {
            var errors = new List<string>();

            // version.json is a release asset, so the accelerator can serve it.
            try
            {
                var release = await QueryManifestAsync(ProxyUrl(VersionManifestUrl), TimeSpan.FromSeconds(8));
                if (release != null) return release;
            }
            catch (Exception exception) { errors.Add("proxy manifest: " + exception.Message); }

            try
            {
                var release = await QueryManifestAsync(VersionManifestUrl, TimeSpan.FromSeconds(8));
                if (release != null) return release;
            }
            catch (Exception exception) { errors.Add("manifest: " + exception.Message); }

            // The accelerator only serves resource downloads, but trying it first
            // keeps API-compatible proxies working without changing the order.
            try
            {
                var release = await QueryApiAsync(ProxyUrl(ApiUrl), TimeSpan.FromSeconds(4));
                if (release != null) return release;
            }
            catch (Exception exception) { errors.Add("proxy api: " + exception.Message); }

            try
            {
                var release = await QueryLatestRedirectAsync();
                if (release != null) return release;
            }
            catch (Exception exception) { errors.Add("releases: " + exception.Message); }

            try
            {
                var release = await QueryAtomAsync();
                if (release != null) return release;
            }
            catch (Exception exception) { errors.Add("atom: " + exception.Message); }

            Log.Write("update lookup failed: " + string.Join(" | ", errors));
            return null;
        }

        private static async Task<ReleaseInfo> QueryManifestAsync(string url, TimeSpan timeout)
        {
            using (var cancellation = new CancellationTokenSource(timeout))
            using (var response = await Client.GetAsync(url, cancellation.Token))
            {
                if (!response.IsSuccessStatusCode)
                {
                    Log.Write("update manifest " + url + ": HTTP " + (int)response.StatusCode);
                    return null;
                }
                var text = await response.Content.ReadAsStringAsync();
                var root = SimpleJson.ParseObject(text);
                var release = FromTag(GetString(root, "version"));
                if (release == null) return null;

                var exe = Path.GetFileName(GetString(root, "exe").Trim());
                if (!string.IsNullOrWhiteSpace(exe) && exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                {
                    var asset = "https://github.com/" + Owner + "/" + Repository + "/releases/download/"
                        + Uri.EscapeDataString(release.Tag) + "/" + Uri.EscapeDataString(exe);
                    if (!release.AssetUrls.Any(item => string.Equals(item, asset, StringComparison.OrdinalIgnoreCase)))
                        release.AssetUrls.Insert(0, asset);
                }
                return release;
            }
        }

        private static async Task<ReleaseInfo> QueryApiAsync(string url, TimeSpan timeout)
        {
            using (var cancellation = new CancellationTokenSource(timeout))
            using (var request = new HttpRequestMessage(HttpMethod.Get, url))
            {
                request.Headers.Accept.ParseAdd("application/vnd.github+json");
                using (var response = await Client.SendAsync(request, cancellation.Token))
                {
                    if (!response.IsSuccessStatusCode)
                    {
                        Log.Write("update api " + url + ": HTTP " + (int)response.StatusCode);
                        return null;
                    }
                    var text = await response.Content.ReadAsStringAsync();
                    var root = SimpleJson.ParseObject(text);
                    var tag = GetString(root, "tag_name");
                    var version = ParseVersion(tag);
                    if (version == null) return null;

                    var release = new ReleaseInfo { Tag = NormalizeTag(tag), Version = version };
                    if (root.TryGetValue("assets", out var assetsValue) && assetsValue is List<object> assets)
                    {
                        foreach (var assetValue in assets)
                        {
                            var asset = assetValue as Dictionary<string, object>;
                            if (asset == null) continue;
                            var name = GetString(asset, "name");
                            var download = GetString(asset, "browser_download_url");
                            if (!string.IsNullOrWhiteSpace(download) && name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                                AddUnique(release.AssetUrls, download);
                        }
                    }
                    AddFallbackAssets(release);
                    return release;
                }
            }
        }

        private static async Task<ReleaseInfo> QueryLatestRedirectAsync()
        {
            using (var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(10)))
            using (var response = await NoRedirectClient.GetAsync(ReleasesLatestUrl, HttpCompletionOption.ResponseHeadersRead, cancellation.Token))
            {
                var location = response.Headers.Location;
                if (location != null)
                {
                    var release = FromTag(ExtractTag(location.OriginalString));
                    if (release != null) return release;
                }

                if (response.IsSuccessStatusCode)
                {
                    var html = await response.Content.ReadAsStringAsync();
                    var release = FromTag(ExtractTag(html));
                    if (release != null) return release;
                }
                Log.Write("update releases page: HTTP " + (int)response.StatusCode);
                return null;
            }
        }

        private static async Task<ReleaseInfo> QueryAtomAsync()
        {
            using (var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(10)))
            using (var response = await Client.GetAsync(ReleasesAtomUrl, cancellation.Token))
            {
                if (!response.IsSuccessStatusCode)
                {
                    Log.Write("update atom: HTTP " + (int)response.StatusCode);
                    return null;
                }
                var xml = await response.Content.ReadAsStringAsync();
                var entry = Regex.Match(xml, @"<entry>.*?</entry>", RegexOptions.Singleline);
                if (!entry.Success) return null;
                var title = Regex.Match(entry.Value, @"<title[^>]*>(?<title>.*?)</title>", RegexOptions.Singleline);
                var release = FromTag(ExtractTag(title.Success ? title.Groups["title"].Value : entry.Value));
                if (release != null) return release;
                return null;
            }
        }

        private static ReleaseInfo FromTag(string tag)
        {
            var version = ParseVersion(tag);
            if (version == null) return null;
            var release = new ReleaseInfo { Tag = NormalizeTag(tag), Version = version };
            AddFallbackAssets(release);
            return release;
        }

        private static string NormalizeTag(string tag)
        {
            var text = (tag ?? "").Trim();
            if (text.Length == 0) return "v0.0.0";
            return text[0] == 'v' || text[0] == 'V' ? "v" + text.Substring(1) : "v" + text;
        }

        private static string ExtractTag(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return "";
            string decoded;
            try { decoded = Uri.UnescapeDataString(text); }
            catch { decoded = text; }
            var match = TagPattern.Match(decoded);
            if (!match.Success) match = VersionPattern.Match(decoded);
            return match.Success ? match.Groups["tag"].Value : "";
        }

        private static void AddFallbackAssets(ReleaseInfo release)
        {
            if (release == null || release.Version == null) return;
            var tag = string.IsNullOrWhiteSpace(release.Tag) ? "v" + release.Version.ToString(3) : release.Tag;
            var baseUrl = "https://github.com/" + Owner + "/" + Repository + "/releases/download/" + Uri.EscapeDataString(tag) + "/";
            AddUnique(release.AssetUrls, baseUrl + "Piik-v" + release.Version.ToString(3) + ".exe");
            // Releases before the versioned naming scheme used Piik.exe.
            AddUnique(release.AssetUrls, baseUrl + "Piik.exe");
        }

        private static void AddUnique(List<string> values, string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return;
            if (!values.Any(item => string.Equals(item, value, StringComparison.OrdinalIgnoreCase))) values.Add(value);
        }

        private static string ProxyUrl(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return url;
            if (url.StartsWith(ProxyBase, StringComparison.OrdinalIgnoreCase)) return url;
            return ProxyBase + url;
        }

        private static bool IsProxyUrl(string url)
        {
            return url != null && url.StartsWith(ProxyBase, StringComparison.OrdinalIgnoreCase);
        }

        private static IEnumerable<string> DownloadUrls(ReleaseInfo release)
        {
            var urls = new List<string>();
            foreach (var asset in release.AssetUrls) AddUnique(urls, ProxyUrl(asset));
            foreach (var asset in release.AssetUrls) AddUnique(urls, asset);
            return urls;
        }

        private static async Task<string> DownloadAsync(ReleaseInfo release, string target, IProgress<int> progress, CancellationToken token)
        {
            if (File.Exists(target) && MatchesVersion(target, release.Version))
            {
                progress?.Report(100);
                return target;
            }

            var directory = Path.GetDirectoryName(target);
            if (string.IsNullOrWhiteSpace(directory)) throw new InvalidOperationException("无法确定更新文件目录。");
            Directory.CreateDirectory(directory);

            var temporary = target + "." + Guid.NewGuid().ToString("N") + ".download";
            var errors = new List<string>();
            try
            {
                foreach (var url in DownloadUrls(release))
                {
                    token.ThrowIfCancellationRequested();
                    progress?.Report(-1);
                    try
                    {
                        using (var cancellation = CancellationTokenSource.CreateLinkedTokenSource(token))
                        {
                            cancellation.CancelAfter(IsProxyUrl(url) ? TimeSpan.FromSeconds(45) : TimeSpan.FromSeconds(120));
                            using (var response = await Client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellation.Token))
                            {
                                if (!response.IsSuccessStatusCode)
                                {
                                    errors.Add(url + " -> HTTP " + (int)response.StatusCode);
                                    continue;
                                }

                                var total = response.Content.Headers.ContentLength ?? -1;
                                using (var input = await response.Content.ReadAsStreamAsync())
                                using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true))
                                {
                                    var buffer = new byte[81920];
                                    long received = 0;
                                    int read;
                                    while ((read = await input.ReadAsync(buffer, 0, buffer.Length, cancellation.Token)) > 0)
                                    {
                                        await output.WriteAsync(buffer, 0, read, cancellation.Token);
                                        received += read;
                                        if (total > 0) progress?.Report((int)Math.Min(100, received * 100 / total));
                                    }
                                }
                            }
                        }

                        if (MatchesVersion(temporary, release.Version))
                        {
                            if (File.Exists(target)) File.Delete(target);
                            File.Move(temporary, target);
                            progress?.Report(100);
                            Log.Write("update downloaded: " + target + " from " + url);
                            return target;
                        }
                        errors.Add(url + " -> 程序版本不匹配");
                    }
                    catch (OperationCanceledException) when (!token.IsCancellationRequested)
                    {
                        errors.Add(url + " -> 超时");
                    }
                    catch (Exception exception)
                    {
                        errors.Add(url + " -> " + exception.Message);
                    }
                    finally
                    {
                        try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
                    }
                }
            }
            finally
            {
                try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
            }

            throw new InvalidOperationException(string.Join("；", errors.Take(4)));
        }

        private static bool MatchesVersion(string path, Version expected)
        {
            try
            {
                var actual = AssemblyName.GetAssemblyName(path).Version;
                return Normalize(actual).CompareTo(Normalize(expected)) >= 0;
            }
            catch
            {
                return false;
            }
        }

        private static bool ConfirmRestart(IWin32Window owner, ReleaseInfo release)
        {
            return MessageBox.Show(
                owner,
                "新版本 v" + release.Version.ToString(3) + " 已下载。\n\n是否立即重启完成更新？",
                "Piik-RTC 更新",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question) == DialogResult.Yes;
        }

        private static void StartUpdateAndExit(string target)
        {
            var current = Application.ExecutablePath;
            if (SamePath(current, target))
            {
                MessageBox.Show("更新文件已下载，但目标文件名与当前程序相同，请手动替换。", "Piik-RTC 更新", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            var pid = Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
            var script = @"
Start-Sleep -Milliseconds 700
while (Get-Process -Id " + pid + @" -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 300 }
try {
  $new = Start-Process -FilePath '" + EscapePowerShell(target) + @"' -PassThru
  Start-Sleep -Seconds 3
  if (-not $new.HasExited) {
    Remove-Item -LiteralPath '" + EscapePowerShell(current) + @"' -Force -ErrorAction SilentlyContinue
  } else {
    Start-Process -FilePath '" + EscapePowerShell(current) + @"'
  }
} catch {
  if (Test-Path -LiteralPath '" + EscapePowerShell(current) + @"') { Start-Process -FilePath '" + EscapePowerShell(current) + @"' }
}
";
            var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
            var powershell = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                @"WindowsPowerShell\v1.0\powershell.exe");
            if (!File.Exists(powershell)) powershell = "powershell.exe";

            try
            {
                var start = new ProcessStartInfo
                {
                    FileName = powershell,
                    Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand " + encoded,
                    WorkingDirectory = Path.GetDirectoryName(current) ?? Environment.CurrentDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                Process.Start(start);
                Log.Write("update restart scheduled: " + target);
                Application.Exit();
            }
            catch (Exception exception)
            {
                Log.Write("update restart failed: " + exception);
                MessageBox.Show("无法启动更新程序：" + exception.Message, "Piik-RTC 更新", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static string EscapePowerShell(string value)
        {
            return (value ?? "").Replace("'", "''");
        }

        private static bool SamePath(string left, string right)
        {
            try
            {
                return string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
            }
        }

        private static string GetString(Dictionary<string, object> map, string key)
        {
            if (map == null || !map.TryGetValue(key, out var value) || value == null) return "";
            return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
        }
    }
}
