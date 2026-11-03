using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;

namespace PiikRTC
{
    internal sealed class AppConfig
    {
        public string ServerUrl = "";
        public bool ServerLocked;
        public bool RememberAuth = true;
        public int Width = 1280;
        public int Height = 860;
        public int X = int.MinValue;
        public int Y = int.MinValue;

        public static string DataDirectory
        {
            get
            {
                var local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PiikRTC");
                try { Directory.CreateDirectory(local); return local; } catch { return Path.GetTempPath(); }
            }
        }

        public static string ConfigPath
        {
            get { return Path.Combine(DataDirectory, "config.json"); }
        }

        public static string ServerLockPath
        {
            get { return Path.Combine(DataDirectory, "server.lock"); }
        }

        public static AppConfig Load(string[] args)
        {
            var config = new AppConfig();
            try
            {
                if (File.Exists(ConfigPath))
                {
                    var values = SimpleJson.ParseObject(File.ReadAllText(ConfigPath, Encoding.UTF8));
                    if (values.TryGetValue("serverUrl", out var server) && server is string text) config.ServerUrl = text;
                    if (values.TryGetValue("rememberAuth", out var remember)) config.RememberAuth = ToBool(remember, config.RememberAuth);
                    if (values.TryGetValue("width", out var width)) config.Width = ToInt(width, config.Width);
                    if (values.TryGetValue("height", out var height)) config.Height = ToInt(height, config.Height);
                    if (values.TryGetValue("x", out var x)) config.X = ToInt(x, config.X);
                    if (values.TryGetValue("y", out var y)) config.Y = ToInt(y, config.Y);
                }
            }
            catch (Exception exception) { Log.Write("config load failed: " + exception.Message); }

            var embedded = EmbeddedDefaultServer();
            var persistedLock = ReadServerLock();
            if (!string.IsNullOrWhiteSpace(embedded))
            {
                // A client distributed for one server must stay on that server:
                // ignore saved config, --server and PIIK_SERVER_URL.
                config.ServerUrl = embedded;
                config.ServerLocked = true;
            }
            else if (!string.IsNullOrWhiteSpace(persistedLock))
            {
                // The public build replaces the distributed exe on update; the
                // lock file keeps it bound to the same server.
                config.ServerUrl = persistedLock;
                config.ServerLocked = true;
            }
            else
            {
                foreach (var argument in args)
                {
                    if (argument.StartsWith("--server=", StringComparison.OrdinalIgnoreCase)) config.ServerUrl = argument.Substring("--server=".Length).Trim();
                }
                if (string.IsNullOrWhiteSpace(config.ServerUrl))
                {
                    var env = Environment.GetEnvironmentVariable("PIIK_SERVER_URL");
                    if (!string.IsNullOrWhiteSpace(env)) config.ServerUrl = env.Trim();
                }
            }
            if (!string.IsNullOrWhiteSpace(config.ServerUrl))
            {
                try
                {
                    // 旧配置里可能残留 user:pass@，WebView2 导航时会忽略凭据并导致来源校验失败。
                    var uri = new Uri(config.ServerUrl);
                    config.ServerUrl = uri.Scheme + Uri.SchemeDelimiter + uri.Authority;
                }
                catch { config.ServerUrl = ""; }
            }
            if (string.IsNullOrWhiteSpace(config.ServerUrl)) config.ServerLocked = false;
            else if (config.ServerLocked) WriteServerLock(config.ServerUrl);
            return config;
        }

        private static string ReadServerLock()
        {
            try
            {
                if (!File.Exists(ServerLockPath)) return "";
                var value = File.ReadAllText(ServerLockPath, Encoding.UTF8).Trim();
                if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return "";
                if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return "";
                return uri.Scheme + Uri.SchemeDelimiter + uri.Authority;
            }
            catch (Exception exception)
            {
                Log.Write("server lock load failed: " + exception.Message);
                return "";
            }
        }

        private static void WriteServerLock(string url)
        {
            try
            {
                if (File.Exists(ServerLockPath))
                {
                    var current = File.ReadAllText(ServerLockPath, Encoding.UTF8).Trim();
                    if (string.Equals(current, url, StringComparison.OrdinalIgnoreCase)) return;
                }
                File.WriteAllText(ServerLockPath, url + Environment.NewLine, new UTF8Encoding(false));
            }
            catch (Exception exception)
            {
                Log.Write("server lock save failed: " + exception.Message);
            }
        }

        /// <summary>
        /// A server URL baked into the executable at build time:
        /// dotnet build -p:PiikDefaultServerUrl=https://...
        /// When present it is authoritative and the client cannot be repointed.
        /// </summary>
        private static string EmbeddedDefaultServer()
        {
            try
            {
                var attribute = Assembly.GetExecutingAssembly()
                    .GetCustomAttributes<AssemblyMetadataAttribute>()
                    .FirstOrDefault(item => string.Equals(item.Key, "PiikDefaultServerUrl", StringComparison.Ordinal));
                return attribute?.Value?.Trim() ?? "";
            }
            catch (Exception exception)
            {
                Log.Write("embedded server read failed: " + exception.Message);
                return "";
            }
        }

        public void Save()
        {
            try
            {
                var builder = new StringBuilder();
                builder.Append("{\n  \"serverUrl\": ").Append(SimpleJson.Quote(ServerUrl)).Append(",\n");
                builder.Append("  \"rememberAuth\": ").Append(RememberAuth ? "true" : "false").Append(",\n");
                builder.Append("  \"width\": ").Append(Width.ToString(CultureInfo.InvariantCulture)).Append(",\n");
                builder.Append("  \"height\": ").Append(Height.ToString(CultureInfo.InvariantCulture)).Append(",\n");
                builder.Append("  \"x\": ").Append(X.ToString(CultureInfo.InvariantCulture)).Append(",\n");
                builder.Append("  \"y\": ").Append(Y.ToString(CultureInfo.InvariantCulture)).Append("\n}\n");
                File.WriteAllText(ConfigPath, builder.ToString(), new UTF8Encoding(false));
            }
            catch (Exception exception) { Log.Write("config save failed: " + exception.Message); }
        }

        private static int ToInt(object value, int fallback)
        {
            try { return Convert.ToInt32(value, CultureInfo.InvariantCulture); } catch { return fallback; }
        }

        private static bool ToBool(object value, bool fallback)
        {
            if (value is bool flag) return flag;
            try { return Convert.ToBoolean(value, CultureInfo.InvariantCulture); } catch { return fallback; }
        }
    }

    internal static class Log
    {
        private static readonly object Gate = new object();
        public static readonly string FilePath = Path.Combine(Path.GetTempPath(), "piik-desktop.log");

        public static void Write(string message)
        {
            try
            {
                lock (Gate) File.AppendAllText(FilePath, DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message + Environment.NewLine, Encoding.UTF8);
            }
            catch { /* logging must never break the app */ }
        }
    }
}
