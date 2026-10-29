using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace PiikDesktop
{
    /// <summary>Remembers HTTP auth credentials per server origin, encrypted with the current Windows account.</summary>
    internal static class CredentialStore
    {
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("PiikDesktop.Auth.v1");
        private static readonly object Gate = new object();

        private static string FilePath
        {
            get { return Path.Combine(Path.GetDirectoryName(AppConfig.ConfigPath), "credentials.json"); }
        }

        public static bool TryGet(string origin, out string userName, out string password)
        {
            userName = "";
            password = "";
            if (string.IsNullOrEmpty(origin)) return false;
            lock (Gate)
            {
                try
                {
                    var entry = ReadEntries();
                    if (!entry.TryGetValue(origin, out var value)) return false;
                    var fields = value as Dictionary<string, object>;
                    if (fields == null) return false;
                    userName = fields.TryGetValue("user", out var user) ? Convert.ToString(user) ?? "" : "";
                    var secret = fields.TryGetValue("secret", out var encrypted) ? Convert.ToString(encrypted) ?? "" : "";
                    if (secret.Length == 0) return false;
                    var bytes = ProtectedData.Unprotect(Convert.FromBase64String(secret), Entropy, DataProtectionScope.CurrentUser);
                    password = Encoding.UTF8.GetString(bytes);
                    return true;
                }
                catch (Exception exception)
                {
                    Log.Write("credential read failed: " + exception.Message);
                    return false;
                }
            }
        }

        public static void Save(string origin, string userName, string password)
        {
            if (string.IsNullOrEmpty(origin)) return;
            lock (Gate)
            {
                try
                {
                    var entries = ReadEntries();
                    var secret = Convert.ToBase64String(ProtectedData.Protect(
                        Encoding.UTF8.GetBytes(password ?? ""), Entropy, DataProtectionScope.CurrentUser));
                    entries[origin] = new Dictionary<string, object>
                    {
                        ["user"] = userName ?? "",
                        ["secret"] = secret,
                    };
                    WriteEntries(entries);
                }
                catch (Exception exception) { Log.Write("credential save failed: " + exception.Message); }
            }
        }

        public static void Remove(string origin)
        {
            if (string.IsNullOrEmpty(origin)) return;
            lock (Gate)
            {
                try
                {
                    var entries = ReadEntries();
                    if (!entries.Remove(origin)) return;
                    WriteEntries(entries);
                }
                catch (Exception exception) { Log.Write("credential clear failed: " + exception.Message); }
            }
        }

        private static Dictionary<string, object> ReadEntries()
        {
            var entries = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            try
            {
                if (!File.Exists(FilePath)) return entries;
                var root = SimpleJson.ParseObject(File.ReadAllText(FilePath, Encoding.UTF8));
                if (root.TryGetValue("entries", out var value) && value is Dictionary<string, object> stored)
                {
                    foreach (var pair in stored) entries[pair.Key] = pair.Value;
                }
            }
            catch (Exception exception) { Log.Write("credential file parse failed: " + exception.Message); }
            return entries;
        }

        private static void WriteEntries(Dictionary<string, object> entries)
        {
            var root = new Dictionary<string, object>
            {
                ["version"] = 1,
                ["entries"] = entries,
            };
            File.WriteAllText(FilePath, SimpleJson.Stringify(root) + Environment.NewLine, new UTF8Encoding(false));
        }
    }
}
