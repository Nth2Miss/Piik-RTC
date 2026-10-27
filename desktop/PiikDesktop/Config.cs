using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;

namespace PiikDesktop
{
    internal sealed class AppConfig
    {
        public string ServerUrl = "";
        public int Width = 1280;
        public int Height = 860;
        public int X = int.MinValue;
        public int Y = int.MinValue;

        private static string ConfigDirectory
        {
            get
            {
                var local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PiikDesktop");
                try { Directory.CreateDirectory(local); return local; } catch { return Path.GetTempPath(); }
            }
        }

        public static string ConfigPath
        {
            get { return Path.Combine(ConfigDirectory, "config.json"); }
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
                    if (values.TryGetValue("width", out var width)) config.Width = ToInt(width, config.Width);
                    if (values.TryGetValue("height", out var height)) config.Height = ToInt(height, config.Height);
                    if (values.TryGetValue("x", out var x)) config.X = ToInt(x, config.X);
                    if (values.TryGetValue("y", out var y)) config.Y = ToInt(y, config.Y);
                }
            }
            catch (Exception exception) { Log.Write("config load failed: " + exception.Message); }

            foreach (var argument in args)
            {
                if (argument.StartsWith("--server=", StringComparison.OrdinalIgnoreCase)) config.ServerUrl = argument.Substring("--server=".Length).Trim();
            }
            if (string.IsNullOrWhiteSpace(config.ServerUrl))
            {
                var env = Environment.GetEnvironmentVariable("PIIK_SERVER_URL");
                if (!string.IsNullOrWhiteSpace(env)) config.ServerUrl = env.Trim();
            }
            if (string.IsNullOrWhiteSpace(config.ServerUrl)) config.ServerUrl = EmbeddedDefaultServer();
            if (!string.IsNullOrWhiteSpace(config.ServerUrl))
            {
                try { config.ServerUrl = new Uri(config.ServerUrl).GetLeftPart(UriPartial.Authority); }
                catch { config.ServerUrl = ""; }
            }
            return config;
        }

        /// <summary>
        /// A server URL baked into the executable at build time:
        /// dotnet build -p:PiikDefaultServerUrl=https://...
        /// Saved config and --server / PIIK_SERVER_URL still take precedence.
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
