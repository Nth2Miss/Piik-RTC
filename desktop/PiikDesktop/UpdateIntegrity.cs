using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;

namespace PiikDesktop
{
    internal static class UpdateIntegrity
    {
        public static bool MatchesFile(string path, ISet<string> trustedDigests)
        {
            if (trustedDigests == null || trustedDigests.Count == 0) return false;
            try
            {
                using (var stream = File.OpenRead(path))
                using (var sha = SHA256.Create())
                {
                    var digest = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                    return trustedDigests.Contains(digest);
                }
            }
            catch { return false; }
        }
    }
}
