using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace PiikRTC
{
    internal struct DownloadProgress
    {
        public readonly int Percent;
        public readonly long BytesPerSecond;

        public DownloadProgress(int percent, long bytesPerSecond)
        {
            Percent = percent;
            BytesPerSecond = bytesPerSecond;
        }
    }

    internal sealed class ReleaseInfo
    {
        public Version Version { get; set; }
        public string Tag { get; set; }
        public List<string> AssetUrls { get; } = new List<string>();
        public HashSet<string> TrustedDigests { get; } = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    }

    internal sealed class UpdateStatus
    {
        public string State { get; set; }
        public string CurrentVersion { get; set; }
        public string LatestVersion { get; set; }
        public bool Downloaded { get; set; }
        public string Error { get; set; }
    }

    /// <summary>
    /// Checks GitHub Releases on startup and installs a newer portable executable.
    /// Downloads probe the gh-proxy mirrors, pick the fastest one and fall back to GitHub directly.
    /// </summary>
    internal static class UpdateChecker
    {
        private const string Owner = "Nth2Miss";
        private const string Repository = "Piik-RTC";
        private const string ApiUrl = "https://api.github.com/repos/" + Owner + "/" + Repository + "/releases/latest";
        private const string ReleasesLatestUrl = "https://github.com/" + Owner + "/" + Repository + "/releases/latest";
        private const string ReleasesAtomUrl = "https://github.com/" + Owner + "/" + Repository + "/releases.atom";
        private const string VersionManifestUrl = "https://github.com/" + Owner + "/" + Repository + "/releases/latest/download/version.json";

        private static readonly string[] ProxyBases =
        {
            "https://v4.gh-proxy.org/",
            "https://v6.gh-proxy.org/",
            "https://gh-proxy.com/",
            "https://ghproxy.net/",
        };

        private const int ProbeBytes = 256 * 1024;
        private const int SegmentCount = 4;
        private const long MultiSegmentThreshold = 1024L * 1024L;
        private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(6);
        private static readonly TimeSpan HeaderTimeout = TimeSpan.FromSeconds(20);
        private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan DownloadTimeout = TimeSpan.FromMinutes(15);

        private static readonly HttpClient Client = CreateClient(true);
        private static readonly HttpClient NoRedirectClient = CreateClient(false);
        private static readonly Regex TagPattern = new Regex(
            @"/releases/tag/(?<tag>v?\d+(?:\.\d+){1,3})",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly Regex VersionPattern = new Regex(
            @"(?<tag>v?\d+(?:\.\d+){1,3})",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);
        private static readonly SemaphoreSlim CheckGate = new SemaphoreSlim(1, 1);
        private static int _installing;
        private static volatile ReleaseInfo _pendingRelease;
        private static long _lastProgressTicks;

        public static async Task<UpdateStatus> CheckForUpdateAsync(bool manual)
        {
            var current = CurrentVersion();
            if (!manual && IsDisabled()) return new UpdateStatus { State = "disabled", CurrentVersion = current.ToString(3) };
            await CheckGate.WaitAsync();
            try
            {
                var release = await FindLatestAsync();
                if (release == null)
                {
                    Log.Write("update check: no release information");
                    return Failed(current, "检查更新失败，请检查网络后重试。");
                }

                Log.Write("update check: current=" + current + " latest=" + release.Version);
                if (release.Version.CompareTo(current) <= 0)
                {
                    return new UpdateStatus
                    {
                        State = "latest",
                        CurrentVersion = current.ToString(3),
                        LatestVersion = release.Version.ToString(3),
                    };
                }

                // A mirror may announce a version, but only GitHub's authenticated
                // API can authorize the bytes that will be executed.
                var verified = await QueryApiAsync("https://api.github.com/repos/" + Owner + "/" + Repository
                    + "/releases/tags/" + Uri.EscapeDataString(release.Tag), TimeSpan.FromSeconds(15), true);
                if (verified == null || verified.Version != release.Version || verified.TrustedDigests.Count == 0)
                    throw new InvalidOperationException("无法从 GitHub 官方接口验证更新文件，请稍后重试或手动下载。不会安装未经验证的镜像文件。");
                _pendingRelease = verified;
                var target = TargetPath(verified);
                return new UpdateStatus
                {
                    State = "available",
                    CurrentVersion = current.ToString(3),
                    LatestVersion = verified.Version.ToString(3),
                    Downloaded = File.Exists(target) && MatchesRelease(target, verified),
                };
            }
            catch (Exception exception)
            {
                Log.Write("update check failed: " + exception);
                return Failed(current, exception.Message);
            }
            finally
            {
                CheckGate.Release();
            }
        }

        public static bool StartInstall(IProgress<DownloadProgress> progress, Action<string> failed)
        {
            if (Interlocked.Exchange(ref _installing, 1) != 0) return false;
            var release = _pendingRelease;
            var context = SynchronizationContext.Current;
            Task.Run(async () =>
            {
                try
                {
                    if (release == null) throw new InvalidOperationException("请先检查更新。");
                    Log.Write("update install begin: version=" + release.Version + " target=" + TargetPath(release));
                    var path = await DownloadAsync(release, TargetPath(release), progress, CancellationToken.None);
                    progress?.Report(new DownloadProgress(100, 0));
                    void Restart()
                    {
                        Log.Write("update restart begin: target=" + path);
                        try { StartUpdateAndExit(path); }
                        catch (Exception exception)
                        {
                            Log.Write("update restart failed: " + exception);
                            failed?.Invoke(exception.Message);
                        }
                    }
                    if (context != null) context.Post(_ => Restart(), null); else Restart();
                }
                catch (Exception exception)
                {
                    Log.Write("update install failed: " + exception);
                    failed?.Invoke(exception.Message);
                }
                finally
                {
                    Interlocked.Exchange(ref _installing, 0);
                }
            });
            return true;
        }

        private static UpdateStatus Failed(Version current, string message)
        {
            return new UpdateStatus { State = "error", CurrentVersion = current.ToString(3), Error = message };
        }

        private static string TargetPath(ReleaseInfo release)
        {
            var directory = Path.GetDirectoryName(Application.ExecutablePath) ?? "";
            return Path.Combine(directory, "Piik-RTC-v" + release.Version.ToString(3) + ".exe");
        }

        private static HttpClient CreateClient(bool allowRedirect)
        {
            try
            {
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                // Segment downloads open several connections to the same mirror.
                ServicePointManager.DefaultConnectionLimit = Math.Max(ServicePointManager.DefaultConnectionLimit, 8);
            }
            catch { }
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

        private static async Task<ReleaseInfo> QueryApiAsync(string url, TimeSpan timeout, bool trusted = false)
        {
            using (var cancellation = new CancellationTokenSource(timeout))
            using (var request = new HttpRequestMessage(HttpMethod.Get, url))
            {
                request.Headers.Accept.ParseAdd("application/vnd.github+json");
                using (var response = await (trusted ? NoRedirectClient : Client).SendAsync(request, cancellation.Token))
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
                            if (string.IsNullOrWhiteSpace(download) || !name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) continue;
                            if (trusted)
                            {
                                var digest = GetString(asset, "digest");
                                var prefix = "https://github.com/" + Owner + "/" + Repository + "/releases/download/";
                                if (!download.StartsWith(prefix, StringComparison.Ordinal) || !Regex.IsMatch(digest, @"\Asha256:[a-fA-F0-9]{64}\z")) continue;
                                release.TrustedDigests.Add(digest.Substring(7).ToLowerInvariant());
                            }
                            AddUnique(release.AssetUrls, download);
                        }
                    }
                    if (!trusted) AddFallbackAssets(release);
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
            AddUnique(release.AssetUrls, baseUrl + "Piik-RTC-v" + release.Version.ToString(3) + ".exe");
            // Older releases used the Piik-v naming scheme and, before that, Piik.exe.
            AddUnique(release.AssetUrls, baseUrl + "Piik-v" + release.Version.ToString(3) + ".exe");
            AddUnique(release.AssetUrls, baseUrl + "Piik.exe");
        }

        private static void AddUnique(List<string> values, string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return;
            if (!values.Any(item => string.Equals(item, value, StringComparison.OrdinalIgnoreCase))) values.Add(value);
        }

        internal static string ProxyUrl(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return url;
            if (IsMirrorUrl(url)) return url;
            return ProxyBases[0] + url;
        }

        private static bool IsMirrorUrl(string url)
        {
            if (url == null) return false;
            return ProxyBases.Any(item => url.StartsWith(item, StringComparison.OrdinalIgnoreCase));
        }

        private static List<string> DownloadUrls(ReleaseInfo release)
        {
            var urls = new List<string>();
            foreach (var asset in release.AssetUrls)
            {
                foreach (var proxy in ProxyBases) AddUnique(urls, proxy + asset);
            }
            foreach (var asset in release.AssetUrls) AddUnique(urls, asset);
            return urls;
        }

        private sealed class DownloadRoute
        {
            public string Url;
            public bool SupportsRanges;
            public long Length;
            public double Speed;
        }

        private static async Task<string> DownloadAsync(ReleaseInfo release, string target, IProgress<DownloadProgress> progress, CancellationToken token)
        {
            if (File.Exists(target) && MatchesRelease(target, release))
            {
                progress?.Report(new DownloadProgress(100, 0));
                return target;
            }

            var directory = Path.GetDirectoryName(target);
            if (string.IsNullOrWhiteSpace(directory)) throw new InvalidOperationException("无法确定更新文件目录。");
            Directory.CreateDirectory(directory);

            var temporary = target + "." + Guid.NewGuid().ToString("N") + ".download";
            var errors = new List<string>();
            Interlocked.Exchange(ref _lastProgressTicks, 0);
            try
            {
                var urls = DownloadUrls(release);
                var routes = await RankRoutesAsync(urls, token);
                var attempted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                foreach (var route in routes)
                {
                    token.ThrowIfCancellationRequested();
                    attempted.Add(route.Url);
                    var result = await TryDownloadAsync(route.Url, route, temporary, target, release, progress, errors, token);
                    if (result != null) return result;
                }

                // A probe can fail while a plain request still works, so try the rest once.
                foreach (var url in urls)
                {
                    if (attempted.Contains(url)) continue;
                    token.ThrowIfCancellationRequested();
                    var result = await TryDownloadAsync(url, null, temporary, target, release, progress, errors, token);
                    if (result != null) return result;
                }
            }
            finally
            {
                try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
            }

            throw new InvalidOperationException(errors.Count == 0 ? "没有可用的下载线路。" : string.Join("；", errors.Take(4)));
        }

        private static async Task<string> TryDownloadAsync(string url, DownloadRoute route, string temporary, string target, ReleaseInfo release, IProgress<DownloadProgress> progress, List<string> errors, CancellationToken token)
        {
            progress?.Report(new DownloadProgress(-1, 0));
            try
            {
                if (route != null && route.SupportsRanges && route.Length >= MultiSegmentThreshold)
                    await DownloadRangedAsync(route, temporary, progress, token);
                else
                    await DownloadSingleAsync(url, temporary, progress, token);

                if (!MatchesRelease(temporary, release))
                {
                    errors.Add(url + " -> 程序版本或 SHA-256 校验不匹配");
                    return null;
                }

                if (File.Exists(target)) File.Delete(target);
                File.Move(temporary, target);
                progress?.Report(new DownloadProgress(100, 0));
                Log.Write("update downloaded: " + target + " from " + url);
                return target;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException)
            {
                Log.Write("update route failed: " + url + " -> timeout");
                errors.Add(url + " -> 超时");
                return null;
            }
            catch (Exception exception)
            {
                Log.Write("update route failed: " + url + " -> " + exception.Message);
                errors.Add(url + " -> " + exception.Message);
                return null;
            }
            finally
            {
                try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
            }
        }

        private static async Task<List<DownloadRoute>> RankRoutesAsync(List<string> urls, CancellationToken token)
        {
            var routes = await ProbeAllAsync(urls.Where(IsMirrorUrl).ToList(), token);
            if (routes.Count == 0)
                routes = await ProbeAllAsync(urls.Where(url => !IsMirrorUrl(url)).ToList(), token);
            return routes.OrderByDescending(route => route.Speed).ToList();
        }

        private static async Task<List<DownloadRoute>> ProbeAllAsync(List<string> urls, CancellationToken token)
        {
            var probes = new List<Task<DownloadRoute>>();
            foreach (var url in urls) probes.Add(ProbeAsync(url, token));
            var results = await Task.WhenAll(probes);
            return results.Where(route => route != null).ToList();
        }

        private static async Task<DownloadRoute> ProbeAsync(string url, CancellationToken token)
        {
            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                timeout.CancelAfter(ProbeTimeout);
                try
                {
                    using (var request = new HttpRequestMessage(HttpMethod.Get, url))
                    {
                        request.Headers.Range = new RangeHeaderValue(0, ProbeBytes - 1);
                        using (var response = await Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token))
                        {
                            if (!response.IsSuccessStatusCode)
                            {
                                Log.Write("update probe " + url + ": HTTP " + (int)response.StatusCode);
                                return null;
                            }

                            var route = new DownloadRoute
                            {
                                Url = url,
                                SupportsRanges = response.StatusCode == HttpStatusCode.PartialContent,
                                Length = ResponseLength(response),
                            };
                            var started = Stopwatch.StartNew();
                            long received = 0;
                            using (var input = await response.Content.ReadAsStreamAsync())
                            {
                                var buffer = new byte[32768];
                                while (received < ProbeBytes)
                                {
                                    var count = (int)Math.Min(buffer.Length, ProbeBytes - received);
                                    var read = await input.ReadAsync(buffer, 0, count, timeout.Token);
                                    if (read <= 0) break;
                                    received += read;
                                }
                            }
                            started.Stop();
                            if (received <= 0) return null;
                            route.Speed = received / Math.Max(started.Elapsed.TotalSeconds, 0.001);
                            Log.Write("update probe " + url + ": " + Math.Round(route.Speed / 1024) + " KB/s, range=" + route.SupportsRanges + ", length=" + route.Length);
                            return route;
                        }
                    }
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception exception)
                {
                    Log.Write("update probe " + url + " failed: " + exception.Message);
                    return null;
                }
            }
        }

        private static long ResponseLength(HttpResponseMessage response)
        {
            var range = response.Content.Headers.ContentRange;
            if (range != null && range.HasLength && range.Length.HasValue) return range.Length.Value;
            return response.Content.Headers.ContentLength ?? -1;
        }

        private static async Task DownloadSingleAsync(string url, string path, IProgress<DownloadProgress> progress, CancellationToken token)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Get, url))
            using (var response = await SendAsync(request, token))
            {
                if (!response.IsSuccessStatusCode) throw new InvalidOperationException("HTTP " + (int)response.StatusCode);
                var total = response.Content.Headers.ContentLength ?? -1;
                var started = Stopwatch.StartNew();
                long received = 0;
                using (var input = await response.Content.ReadAsStreamAsync())
                using (var output = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true))
                {
                    var buffer = new byte[81920];
                    while (true)
                    {
                        var read = await ReadAsync(input, buffer, 0, buffer.Length, token);
                        if (read <= 0) break;
                        await output.WriteAsync(buffer, 0, read, token);
                        received += read;
                        ReportProgress(progress, received, total, started, false);
                    }
                }
                if (total > 0 && received != total) throw new IOException("下载不完整。");
            }
        }

        private static async Task DownloadRangedAsync(DownloadRoute route, string path, IProgress<DownloadProgress> progress, CancellationToken token)
        {
            var length = route.Length;
            var segments = (int)Math.Min(SegmentCount, Math.Max(1, length / (512 * 1024)));
            var part = (long)Math.Ceiling(length / (double)segments);
            var received = new long[segments];
            var started = Stopwatch.StartNew();

            using (var output = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 81920, true))
            {
                output.SetLength(length);
            }

            using (var cancellation = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                cancellation.CancelAfter(DownloadTimeout);
                var tasks = new Task[segments];
                try
                {
                    for (var i = 0; i < segments; i++)
                    {
                        var from = i * part;
                        var to = Math.Min(length - 1, from + part - 1);
                        var index = i;
                        tasks[i] = DownloadSegmentAsync(route.Url, path, from, to, index, received, length, progress, started, cancellation.Token);
                    }
                    await Task.WhenAll(tasks);
                }
                catch
                {
                    try { cancellation.Cancel(); } catch { }
                    try { await Task.WhenAll(tasks); } catch { }
                    throw;
                }
            }

            if (new FileInfo(path).Length != length) throw new IOException("下载文件大小不匹配。");
            ReportProgress(progress, length, length, started, true);
        }

        private static async Task DownloadSegmentAsync(string url, string path, long from, long to, int index, long[] received, long total, IProgress<DownloadProgress> progress, Stopwatch started, CancellationToken token)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Get, url))
            {
                request.Headers.Range = new RangeHeaderValue(from, to);
                using (var response = await SendAsync(request, token))
                {
                    if (response.StatusCode != HttpStatusCode.PartialContent) throw new InvalidOperationException("线路不支持分段下载。");
                    using (var input = await response.Content.ReadAsStreamAsync())
                    using (var output = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite, 81920, true))
                    {
                        output.Seek(from, SeekOrigin.Begin);
                        var buffer = new byte[81920];
                        var position = from;
                        while (position <= to)
                        {
                            var count = (int)Math.Min(buffer.Length, to - position + 1);
                            var read = await ReadAsync(input, buffer, 0, count, token);
                            if (read <= 0) throw new IOException("连接提前中断。");
                            await output.WriteAsync(buffer, 0, read, token);
                            position += read;
                            received[index] = position - from;
                            ReportProgress(progress, Sum(received), total, started, false);
                        }
                    }
                }
            }
        }

        private static async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            using (var headers = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                headers.CancelAfter(HeaderTimeout);
                try
                {
                    return await Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, headers.Token);
                }
                catch (OperationCanceledException) when (!token.IsCancellationRequested)
                {
                    throw new IOException("连接超时。");
                }
            }
        }

        private static async Task<int> ReadAsync(Stream input, byte[] buffer, int offset, int count, CancellationToken token)
        {
            using (var idle = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                idle.CancelAfter(ReadTimeout);
                try
                {
                    return await input.ReadAsync(buffer, offset, count, idle.Token);
                }
                catch (OperationCanceledException) when (!token.IsCancellationRequested)
                {
                    throw new IOException("下载超时。");
                }
            }
        }

        private static long Sum(long[] values)
        {
            long total = 0;
            for (var i = 0; i < values.Length; i++) total += values[i];
            return total;
        }

        private static void ReportProgress(IProgress<DownloadProgress> progress, long received, long total, Stopwatch started, bool force)
        {
            if (progress == null) return;
            var now = DateTime.UtcNow.Ticks;
            var last = Interlocked.Read(ref _lastProgressTicks);
            if (!force && now - last < TimeSpan.FromMilliseconds(150).Ticks) return;
            if (Interlocked.CompareExchange(ref _lastProgressTicks, now, last) != last) return;
            var seconds = Math.Max(started.Elapsed.TotalSeconds, 0.001);
            var percent = total > 0 ? (int)Math.Min(100, received * 100 / total) : -1;
            progress.Report(new DownloadProgress(percent, (long)(received / seconds)));
        }

        private static bool MatchesRelease(string path, ReleaseInfo release)
        {
            try
            {
                if (!UpdateIntegrity.MatchesFile(path, release.TrustedDigests)) return false;
                var actual = AssemblyName.GetAssemblyName(path).Version;
                return Normalize(actual).CompareTo(Normalize(release.Version)) == 0;
            }
            catch
            {
                return false;
            }
        }

        private static void StartUpdateAndExit(string target)
        {
            var current = Application.ExecutablePath;
            if (SamePath(current, target))
                throw new InvalidOperationException("更新文件已下载，但目标文件名与当前程序相同，请手动替换。");

            var pid = Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
            // 直接让新版本接管，避免依赖可能被安全策略拦截的 PowerShell。
            // 新版本会等待本进程退出后再获取单实例锁，并删除旧 exe。
            if (TryStartNewVersion(target, current, pid))
            {
                Log.Write("update handoff: application exit");
                Application.Exit();
                return;
            }
            Log.Write("update handoff: direct start failed, falling back to PowerShell");
            // 更新拉起失败时这段脚本是唯一的现场，每个分支都必须写日志：
            // 脚本是否执行、等待旧进程多久、Start-Process 的异常、新进程 3 秒后的状态、旧 exe 是否删除。
            var script = @"
$ErrorActionPreference = 'Continue'
$log = '" + EscapePowerShell(Log.FilePath) + @"'
$target = '" + EscapePowerShell(target) + @"'
$current = '" + EscapePowerShell(current) + @"'
$oldPid = " + pid + @"
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-UpdLog([string]$text) {
  $line = (Get-Date -Format 'HH:mm:ss.fff') + ' [updater:' + $PID + '] ' + $text
  for ($i = 0; $i -lt 40; $i++) {
    try { [System.IO.File]::AppendAllText($log, $line + [Environment]::NewLine, $utf8); return } catch { Start-Sleep -Milliseconds 25 }
  }
}
try {
  Write-UpdLog ('script start: ps=' + $PSVersionTable.PSVersion + ' user=' + [Environment]::UserName + ' cwd=' + (Get-Location).Path)
  Write-UpdLog ('old pid=' + $oldPid + ' target=' + $target + ' current=' + $current)
  Write-UpdLog ('target exists=' + (Test-Path -LiteralPath $target) + ' current exists=' + (Test-Path -LiteralPath $current))
  Start-Sleep -Milliseconds 700
  $wait = [System.Diagnostics.Stopwatch]::StartNew()
  $old = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
  while ($old -ne $null) {
    if ($wait.ElapsedMilliseconds -gt 120000) { Write-UpdLog ('old process wait timeout: ' + [int]($wait.ElapsedMilliseconds) + 'ms'); break }
    Start-Sleep -Milliseconds 300
    $old = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
  }
  $wait.Stop()
  Write-UpdLog ('old process wait: ' + [int]($wait.ElapsedMilliseconds) + 'ms, still running=' + ($null -ne $old))
  $new = $null
  try {
    Write-UpdLog 'start target'
    $new = Start-Process -FilePath $target -PassThru -ErrorAction Stop
    Write-UpdLog ('started target: pid=' + $new.Id + ' name=' + $new.ProcessName)
  } catch {
    Write-UpdLog ('start target failed: ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message + ' hresult=' + $_.Exception.HResult)
    Write-UpdLog ('start target stack: ' + $_.Exception.StackTrace)
  }
  if ($new -eq $null) {
    try { $old = Start-Process -FilePath $current -PassThru -ErrorAction Stop; Write-UpdLog ('fallback started old exe: pid=' + $old.Id) } catch { Write-UpdLog ('fallback start failed: ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message) }
  } else {
    Start-Sleep -Seconds 3
    $new.Refresh()
    $alive = -not $new.HasExited
    if ($alive) {
      try { Write-UpdLog ('target after 3s: alive=True pid=' + $new.Id + ' title=' + $new.MainWindowTitle + ' handle=' + $new.MainWindowHandle + ' responding=' + $new.Responding) } catch { Write-UpdLog ('target after 3s: alive=True pid=' + $new.Id + ' info failed: ' + $_.Exception.Message) }
      try {
        Remove-Item -LiteralPath $current -Force -ErrorAction Stop
        Write-UpdLog ('removed old exe: ' + $current + ' stillExists=' + (Test-Path -LiteralPath $current))
      } catch {
        Write-UpdLog ('remove old exe failed: ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message)
      }
      Start-Sleep -Seconds 2
      try { $new.Refresh(); Write-UpdLog ('target after 5s: alive=' + (-not $new.HasExited) + ' title=' + $new.MainWindowTitle + ' handle=' + $new.MainWindowHandle) } catch { Write-UpdLog ('target after 5s check failed: ' + $_.Exception.Message) }
    } else {
      Write-UpdLog ('target exited within 3s: code=' + $new.ExitCode)
      try { $old = Start-Process -FilePath $current -PassThru -ErrorAction Stop; Write-UpdLog ('fallback started old exe: pid=' + $old.Id) } catch { Write-UpdLog ('fallback start failed: ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message) }
    }
  }
  Write-UpdLog 'script end'
} catch {
  Write-UpdLog ('script error: ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message + ' hresult=' + $_.Exception.HResult)
  Write-UpdLog ('script error stack: ' + $_.Exception.StackTrace)
  try { if (Test-Path -LiteralPath $current) { Start-Process -FilePath $current -ErrorAction Stop; Write-UpdLog 'catch fallback started old exe' } } catch { Write-UpdLog ('catch fallback failed: ' + $_.Exception.Message) }
}
";
            var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
            var powershell = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                @"WindowsPowerShell\v1.0\powershell.exe");
            if (!File.Exists(powershell)) powershell = "powershell.exe";

            foreach (var line in script.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None))
                Log.Write("update script| " + line);
            Log.Write("update restart: current=" + current + " target=" + target + " pid=" + pid
                + " powershell=" + powershell + " powershellExists=" + File.Exists(powershell)
                + " targetExists=" + File.Exists(target)
                + " targetLength=" + (File.Exists(target) ? new FileInfo(target).Length : 0));

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
                var process = Process.Start(start);
                var powershellPid = "unknown";
                try { if (process != null) powershellPid = process.Id.ToString(CultureInfo.InvariantCulture); } catch (Exception exception) { powershellPid = "unavailable: " + exception.Message; }
                Log.Write("update restart scheduled: target=" + target + " pid=" + pid + " powershell=" + powershell + " powershellPid=" + powershellPid);
                Log.Write("update restart: application exit");
                Application.Exit();
            }
            catch (Exception exception)
            {
                Log.Write("update restart failed: " + exception);
                throw new InvalidOperationException("无法启动更新程序：" + exception.Message, exception);
            }
        }

        private static bool TryStartNewVersion(string target, string current, string oldPid)
        {
            var arguments = "--restart-after=" + oldPid + " --delete-old=\"" + current + "\"";
            var workingDirectory = Path.GetDirectoryName(target) ?? Environment.CurrentDirectory;
            int breakawayPid;
            if (TryCreateBreakaway(target, arguments, workingDirectory, out breakawayPid))
            {
                try
                {
                    using (var process = Process.GetProcessById(breakawayPid))
                    {
                        if (process.WaitForExit(1500))
                        {
                            Log.Write("update handoff breakaway exited: pid=" + breakawayPid);
                            return false;
                        }
                    }
                    Log.Write("update handoff started (breakaway): target=" + target + " pid=" + breakawayPid);
                    return true;
                }
                catch (ArgumentException)
                {
                    Log.Write("update handoff breakaway process missing: pid=" + breakawayPid);
                    return false;
                }
                catch (Exception exception)
                {
                    Log.Write("update handoff breakaway check failed: " + exception.Message);
                    return false;
                }
            }

            try
            {
                var start = new ProcessStartInfo
                {
                    FileName = target,
                    Arguments = arguments,
                    WorkingDirectory = workingDirectory,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                var process = Process.Start(start);
                if (process == null)
                {
                    Log.Write("update handoff start returned null");
                    return false;
                }
                if (process.WaitForExit(1500))
                {
                    Log.Write("update handoff exited: pid=" + process.Id + " code=" + process.ExitCode);
                    return false;
                }
                Log.Write("update handoff started: target=" + target + " pid=" + process.Id);
                return true;
            }
            catch (Exception exception)
            {
                Log.Write("update handoff start failed: " + exception);
                return false;
            }
        }

        private static bool TryCreateBreakaway(string target, string arguments, string workingDirectory, out int pid)
        {
            pid = 0;
            try
            {
                var startup = new StartupInfo();
                startup.cb = Marshal.SizeOf(typeof(StartupInfo));
                var command = new StringBuilder("\"" + target + "\" " + arguments, 4096);
                ProcessInformation process;
                // 某些企业环境把应用放在 kill-on-close 的 Job 里，普通子进程会随主进程
                // 一起被杀掉；能 breakaway 时优先脱离 Job。
                if (!CreateProcess(target, command, IntPtr.Zero, IntPtr.Zero, false,
                    CreateBreakawayFromJob, IntPtr.Zero, workingDirectory, ref startup, out process))
                {
                    Log.Write("update handoff breakaway unavailable: " + Marshal.GetLastWin32Error());
                    return false;
                }
                pid = process.dwProcessId;
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
                return true;
            }
            catch (Exception exception)
            {
                Log.Write("update handoff breakaway failed: " + exception.Message);
                return false;
            }
        }

        private const uint CreateBreakawayFromJob = 0x01000000;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcess(string applicationName, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
            IntPtr environment, string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

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
