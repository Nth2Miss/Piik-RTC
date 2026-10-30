using System;
using System.Collections.Generic;
using System.IO;
using PiikDesktop;

var path = Path.Combine(Path.GetTempPath(), "piik-update-test-" + Guid.NewGuid().ToString("N"));
try
{
    File.WriteAllText(path, "abc");
    var trusted = new HashSet<string> { "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
    if (!UpdateIntegrity.MatchesFile(path, trusted)) throw new Exception("Valid digest rejected");
    if (UpdateIntegrity.MatchesFile(path, new HashSet<string>())) throw new Exception("Missing digest accepted");
    if (UpdateIntegrity.MatchesFile(path, new HashSet<string> { new string('0', 64) })) throw new Exception("Wrong digest accepted");
    File.AppendAllText(path, "tampered");
    if (UpdateIntegrity.MatchesFile(path, trusted)) throw new Exception("Tampered update accepted");
    File.Delete(path);
    if (UpdateIntegrity.MatchesFile(path, trusted)) throw new Exception("Missing update accepted");
    Console.WriteLine("Update integrity: 5 checks passed.");
}
finally { if (File.Exists(path)) File.Delete(path); }
