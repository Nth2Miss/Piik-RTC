using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace PiikRTC
{
    internal sealed class NativeComponentStatus
    {
        public bool Supported;
        public bool Available;
        public bool Bundled;
        public bool UpdateAvailable;
        public string InstalledVersion = "";
        public string LatestVersion = "";
        public string Sdk = "";
        public string Directory = "";
        public long Size;
        public string Error = "";

        public Dictionary<string, object> ToJson()
        {
            return new Dictionary<string, object>
            {
                ["supported"] = Supported,
                ["available"] = Available,
                ["bundled"] = Bundled,
                ["updateAvailable"] = UpdateAvailable,
                ["installedVersion"] = InstalledVersion,
                ["latestVersion"] = LatestVersion,
                ["sdk"] = Sdk,
                ["directory"] = Directory,
                ["size"] = Size,
                ["error"] = Error,
            };
        }
    }

    internal sealed class NativeComponentProgress
    {
        public string Phase = "";
        public int Percent;
        public long Received;
        public long Total;

        public NativeComponentProgress(string phase, int percent, long received, long total)
        {
            Phase = phase;
            Percent = percent;
            Received = received;
            Total = total;
        }
    }

    /// <summary>
    /// Downloads the optional Volc native runtime from GitHub Releases. The
    /// executable itself stays small; users opt in when they create or join a
    /// Volc room.
    /// </summary>
    internal static class NativeComponent
    {
        private const string Owner = "Nth2Miss";
        private const string Repository = "Piik-RTC";
        private const string ManifestUrl = "https://github.com/" + Owner + "/" + Repository + "/releases/latest/download/version.json";
        private static readonly Regex SafeVersion = new Regex(@"\A[0-9A-Za-z][0-9A-Za-z._-]{0,63}\z", RegexOptions.Compiled);
        private static readonly Regex Sha256Pattern = new Regex(@"\A[a-fA-F0-9]{64}\z", RegexOptions.Compiled);
        private static readonly string[] RequiredFiles =
        {
            "PiikVolc.dll", "VolcEngineRTC.dll", "RTCFFmpeg.dll", "openh264-4.dll",
            "libEGL.dll", "libGLESv2.dll", "pthreadVC2.dll",
        };
        private static readonly string BundledDirectory = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "native-volc");
        private static readonly string InstallRoot = ResolveInstallRoot();
        private static readonly HttpClient Client = CreateClient();
        private static readonly object CacheGate = new object();
        private static NativeMetadata? _cachedMetadata;
        private static DateTime _cachedAt;
        private static readonly TimeSpan CacheDuration = TimeSpan.FromMinutes(5);
        private static int _installing;

        private sealed class NativeMetadata
        {
            public string Version = "";
            public string Sdk = "";
            public string File = "";
            public string Sha256 = "";
            public string Url = "";
            public long Size;
        }

        private static string ResolveInstallRoot()
        {
            // Test hook: keeps installer tests out of the real user profile.
            var custom = Environment.GetEnvironmentVariable("PIIK_NATIVE_INSTALL_ROOT");
            if (!string.IsNullOrWhiteSpace(custom))
            {
                try { return Path.GetFullPath(custom.Trim()); } catch { /* fall back to the normal location */ }
            }
            return Path.Combine(AppConfig.DataDirectory, "native-volc");
        }

        public static string? ResolveDirectory()
        {
            if (HasComponent(BundledDirectory)) return BundledDirectory;
            try
            {
                if (!Directory.Exists(InstallRoot)) return null;
                return Directory.GetDirectories(InstallRoot)
                    .Where(directory => !Path.GetFileName(directory).StartsWith(".native-", StringComparison.OrdinalIgnoreCase))
                    .Where(HasComponent)
                    .OrderByDescending(directory => ParseVersion(Path.GetFileName(directory)))
                    .FirstOrDefault();
            }
            catch (Exception exception)
            {
                Log.Write("native component resolve failed: " + exception.Message);
                return null;
            }
        }

        public static async Task<NativeComponentStatus> GetStatusAsync(bool force)
        {
            var status = new NativeComponentStatus();
            var directory = ResolveDirectory();
            status.Directory = directory ?? "";
            status.Available = directory != null;
            status.Bundled = directory != null && string.Equals(directory, BundledDirectory, StringComparison.OrdinalIgnoreCase);
            if (directory != null)
            {
                status.InstalledVersion = ReadVersion(directory);
                status.Sdk = ReadSdk(directory);
            }

            try
            {
                var metadata = await GetMetadataAsync(force);
                if (metadata != null)
                {
                    status.Supported = true;
                    status.LatestVersion = metadata.Version;
                    status.Size = metadata.Size;
                    if (!string.IsNullOrWhiteSpace(metadata.Sdk)) status.Sdk = metadata.Sdk;
                    status.UpdateAvailable = status.Available && !string.IsNullOrWhiteSpace(status.InstalledVersion)
                        && !string.Equals(status.InstalledVersion, metadata.Version, StringComparison.OrdinalIgnoreCase);
                }
            }
            catch (Exception exception)
            {
                status.Error = exception.Message;
                status.Supported = status.Available;
                Log.Write("native component manifest failed: " + exception.Message);
            }
            return status;
        }

        public static async Task<NativeComponentStatus> InstallAsync(IProgress<NativeComponentProgress>? progress, CancellationToken token)
        {
            if (Interlocked.Exchange(ref _installing, 1) != 0) throw new InvalidOperationException("原生组件正在安装。");
            try { return await InstallCoreAsync(progress, token); }
            finally { Interlocked.Exchange(ref _installing, 0); }
        }

        private static async Task<NativeComponentStatus> InstallCoreAsync(IProgress<NativeComponentProgress>? progress, CancellationToken token)
        {
            var metadata = await GetMetadataAsync(true);
            if (metadata == null) throw new InvalidOperationException("当前版本没有可下载的火山原生组件。");
            if (!SafeVersion.IsMatch(metadata.Version)) throw new InvalidOperationException("原生组件版本号无效。");

            var installed = ResolveDirectory();
            if (installed != null && string.Equals(ReadVersion(installed), metadata.Version, StringComparison.OrdinalIgnoreCase))
            {
                progress?.Report(new NativeComponentProgress("done", 100, metadata.Size, metadata.Size));
                return await GetStatusAsync(false);
            }

            Directory.CreateDirectory(InstallRoot);
            CleanupStaging();
            var target = Path.Combine(InstallRoot, metadata.Version);
            var zip = Path.Combine(Path.GetTempPath(), "PiikRTC", "native-component-" + Guid.NewGuid().ToString("N") + ".zip");
            var extract = Path.Combine(InstallRoot, ".native-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path.GetDirectoryName(zip) ?? Path.GetTempPath());
            var errors = new List<string>();
            try
            {
                var downloaded = false;
                var local = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, metadata.File);
                if (File.Exists(local))
                {
                    try
                    {
                        File.Copy(local, zip, true);
                        VerifyArchive(zip, metadata, progress);
                        downloaded = true;
                        Log.Write("native component local package used: " + local);
                    }
                    catch (Exception exception)
                    {
                        errors.Add("本地组件包 -> " + exception.Message);
                        try { if (File.Exists(zip)) File.Delete(zip); } catch { }
                    }
                }
                if (!downloaded) foreach (var url in DownloadUrls(metadata))
                {
                    token.ThrowIfCancellationRequested();
                    try
                    {
                        await DownloadAsync(url, zip, metadata, progress, token);
                        VerifyArchive(zip, metadata, progress);
                        downloaded = true;
                        break;
                    }
                    catch (OperationCanceledException) when (token.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception exception)
                    {
                        errors.Add(url + " -> " + exception.Message);
                        Log.Write("native component download failed: " + url + " -> " + exception.Message);
                        try { if (File.Exists(zip)) File.Delete(zip); } catch { }
                    }
                }
                if (!downloaded) throw new InvalidOperationException(errors.Count == 0 ? "没有可用的下载线路。" : string.Join("；", errors.Take(4)));

                progress?.Report(new NativeComponentProgress("extracting", 100, metadata.Size, metadata.Size));
                Directory.CreateDirectory(extract);
                ExtractZip(zip, extract);
                var source = HasComponent(extract) ? extract : Path.Combine(extract, "native-volc");
                if (!HasComponent(source)) throw new InvalidOperationException("原生组件包缺少必需文件。");

                if (Directory.Exists(target))
                {
                    try { Directory.Delete(target, true); }
                    catch (Exception exception)
                    {
                        throw new InvalidOperationException("旧版原生组件正在使用，请重启桌面端后重试。", exception);
                    }
                }
                Directory.Move(source, target);
                CleanupOldVersions(target);
                progress?.Report(new NativeComponentProgress("done", 100, metadata.Size, metadata.Size));
                Log.Write("native component installed: " + metadata.Version + " -> " + target);
                var result = await GetStatusAsync(false);
                if (!result.Available) throw new InvalidOperationException("安装完成后未找到原生组件。");
                return result;
            }
            finally
            {
                try { if (File.Exists(zip)) File.Delete(zip); } catch { }
                try { if (Directory.Exists(extract)) Directory.Delete(extract, true); } catch { }
            }
        }

        private static async Task<NativeMetadata?> GetMetadataAsync(bool force)
        {
            try
            {
                var local = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "version.json");
                if (File.Exists(local))
                {
                    var localMetadata = ParseMetadata(File.ReadAllText(local, Encoding.UTF8));
                    var appVersion = typeof(NativeComponent).Assembly.GetName().Version?.ToString(3) ?? "";
                    if (localMetadata != null && (string.IsNullOrWhiteSpace(appVersion)
                        || string.Equals(localMetadata.Version, appVersion, StringComparison.OrdinalIgnoreCase)))
                    {
                        lock (CacheGate) { _cachedMetadata = localMetadata; _cachedAt = DateTime.UtcNow; }
                        return localMetadata;
                    }
                    if (localMetadata != null) Log.Write("native component local manifest version mismatch: " + localMetadata.Version + " != " + appVersion);
                }
            }
            catch (Exception exception)
            {
                Log.Write("native component local manifest failed: " + exception.Message);
            }

            NativeMetadata? cached;
            lock (CacheGate)
            {
                cached = _cachedMetadata;
                if (!force && cached != null && DateTime.UtcNow - _cachedAt < CacheDuration) return cached;
            }

            var errors = new List<string>();
            foreach (var url in new[] { UpdateChecker.ProxyUrl(ManifestUrl), ManifestUrl })
            {
                try
                {
                    using (var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(8)))
                    using (var response = await Client.GetAsync(url, HttpCompletionOption.ResponseContentRead, cancellation.Token))
                    {
                        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("HTTP " + (int)response.StatusCode);
                        var metadata = ParseMetadata(await response.Content.ReadAsStringAsync());
                        if (metadata == null) throw new InvalidOperationException("版本清单中没有 native 段。");
                        lock (CacheGate) { _cachedMetadata = metadata; _cachedAt = DateTime.UtcNow; }
                        return metadata;
                    }
                }
                catch (Exception exception)
                {
                    errors.Add(url + " -> " + exception.Message);
                }
            }

            if (cached != null) return cached;
            throw new InvalidOperationException(errors.Count == 0 ? "无法读取原生组件清单。" : string.Join("；", errors.Take(2)));
        }

        private static NativeMetadata? ParseMetadata(string text)
        {
            var root = SimpleJson.ParseObject(text);
            if (!root.TryGetValue("native", out var value) || !(value is Dictionary<string, object> native)) return null;
            var version = Text(native, "version");
            var file = Path.GetFileName(Text(native, "file"));
            var sha = Text(native, "sha256");
            if (string.IsNullOrWhiteSpace(version) || string.IsNullOrWhiteSpace(file) || !Sha256Pattern.IsMatch(sha)) return null;
            var url = DirectAssetUrl(version, file);
            var declaredUrl = Text(native, "url");
            if (Uri.TryCreate(declaredUrl, UriKind.Absolute, out var parsed) && parsed.Scheme == Uri.UriSchemeHttps) url = declaredUrl;
            return new NativeMetadata
            {
                Version = version,
                Sdk = Text(native, "sdk"),
                File = file,
                Sha256 = sha,
                Url = url,
                Size = Number(native, "size"),
            };
        }

        private static List<string> DownloadUrls(NativeMetadata metadata)
        {
            var urls = new List<string>();
            AddUnique(urls, UpdateChecker.ProxyUrl(metadata.Url));
            AddUnique(urls, metadata.Url);
            return urls;
        }

        private static async Task DownloadAsync(string url, string path, NativeMetadata metadata, IProgress<NativeComponentProgress>? progress, CancellationToken token)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Get, url))
            using (var response = await Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token))
            {
                response.EnsureSuccessStatusCode();
                var total = metadata.Size > 0 ? metadata.Size : response.Content.Headers.ContentLength ?? 0;
                using (var input = await response.Content.ReadAsStreamAsync())
                using (var output = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 81920, true))
                {
                    var buffer = new byte[81920];
                    long received = 0;
                    var lastPercent = -1;
                    progress?.Report(new NativeComponentProgress("downloading", 0, 0, total));
                    int read;
                    while ((read = await input.ReadAsync(buffer, 0, buffer.Length, token)) > 0)
                    {
                        await output.WriteAsync(buffer, 0, read, token);
                        received += read;
                        var percent = total > 0 ? (int)Math.Min(99, received * 100 / total) : 0;
                        if (percent != lastPercent)
                        {
                            lastPercent = percent;
                            progress?.Report(new NativeComponentProgress("downloading", percent, received, total));
                        }
                    }
                }
            }
        }

        private static void VerifyArchive(string path, NativeMetadata metadata, IProgress<NativeComponentProgress>? progress)
        {
            var size = new FileInfo(path).Length;
            if (metadata.Size > 0 && size != metadata.Size) throw new InvalidOperationException("下载文件大小不一致。");
            progress?.Report(new NativeComponentProgress("verifying", 100, size, metadata.Size > 0 ? metadata.Size : size));
            if (!string.Equals(HashFile(path), metadata.Sha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("下载文件 SHA-256 校验失败。");
        }

        private static void ExtractZip(string zip, string destination)
        {
            var root = Path.GetFullPath(destination);
            using (var archive = ZipFile.OpenRead(zip))
            {
                foreach (var entry in archive.Entries)
                {
                    var target = Path.GetFullPath(Path.Combine(root, entry.FullName));
                    if (!target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                        && !string.Equals(target, root, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("原生组件包包含无效路径。");
                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(target) ?? root);
                    entry.ExtractToFile(target, true);
                }
            }
        }

        private static void CleanupStaging()
        {
            try
            {
                foreach (var directory in Directory.GetDirectories(InstallRoot))
                {
                    if (!Path.GetFileName(directory).StartsWith(".native-", StringComparison.OrdinalIgnoreCase)) continue;
                    try { Directory.Delete(directory, true); }
                    catch (Exception exception) { Log.Write("native component staging cleanup failed: " + exception.Message); }
                }
            }
            catch (Exception exception)
            {
                Log.Write("native component staging scan failed: " + exception.Message);
            }
        }

        private static void CleanupOldVersions(string keep)
        {
            try
            {
                foreach (var directory in Directory.GetDirectories(InstallRoot))
                {
                    if (string.Equals(directory, keep, StringComparison.OrdinalIgnoreCase)) continue;
                    try { Directory.Delete(directory, true); }
                    catch (Exception exception) { Log.Write("old native component not removed: " + exception.Message); }
                }
            }
            catch (Exception exception)
            {
                Log.Write("native component cleanup failed: " + exception.Message);
            }
        }

        private static bool HasComponent(string directory)
        {
            return !string.IsNullOrEmpty(directory) && RequiredFiles.All(name => File.Exists(Path.Combine(directory, name)));
        }

        private static string ReadVersion(string directory)
        {
            var value = ReadMetadataValue(directory, "version");
            if (!string.IsNullOrWhiteSpace(value)) return value;
            return string.Equals(directory, BundledDirectory, StringComparison.OrdinalIgnoreCase) ? "" : Path.GetFileName(directory);
        }

        private static string ReadSdk(string directory)
        {
            return ReadMetadataValue(directory, "sdk");
        }

        private static string ReadMetadataValue(string directory, string key)
        {
            try
            {
                var path = Path.Combine(directory, "version.json");
                if (!File.Exists(path)) return "";
                var root = SimpleJson.ParseObject(File.ReadAllText(path, Encoding.UTF8));
                return Text(root, key);
            }
            catch
            {
                return "";
            }
        }

        private static Version ParseVersion(string value)
        {
            Version version;
            return Version.TryParse(value, out version) ? version : new Version(0, 0);
        }

        private static string HashFile(string path)
        {
            using (var stream = File.OpenRead(path))
            using (var sha = SHA256.Create())
            {
                var hash = sha.ComputeHash(stream);
                var text = new StringBuilder(hash.Length * 2);
                foreach (var value in hash) text.Append(value.ToString("x2", CultureInfo.InvariantCulture));
                return text.ToString();
            }
        }

        private static string DirectAssetUrl(string version, string file)
        {
            var tag = version.StartsWith("v", StringComparison.OrdinalIgnoreCase) ? version : "v" + version;
            return "https://github.com/" + Owner + "/" + Repository + "/releases/download/" + Uri.EscapeDataString(tag) + "/" + Uri.EscapeDataString(file);
        }

        private static void AddUnique(List<string> values, string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return;
            if (!values.Any(item => string.Equals(item, value, StringComparison.OrdinalIgnoreCase))) values.Add(value);
        }

        private static string Text(Dictionary<string, object> map, string key)
        {
            if (map == null || !map.TryGetValue(key, out var value) || value == null) return "";
            return Convert.ToString(value, CultureInfo.InvariantCulture)?.Trim() ?? "";
        }

        private static long Number(Dictionary<string, object> map, string key)
        {
            if (map == null || !map.TryGetValue(key, out var value) || value == null) return 0;
            try { return Convert.ToInt64(value, CultureInfo.InvariantCulture); } catch { return 0; }
        }

        private static HttpClient CreateClient()
        {
            var handler = new HttpClientHandler
            {
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            };
            var client = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(10) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("Piik-RTC-Native/1.0");
            client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
            return client;
        }
    }
}
