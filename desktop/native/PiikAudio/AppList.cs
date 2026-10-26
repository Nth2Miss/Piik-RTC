using System.Diagnostics;
using System.Text;

namespace PiikAudio;

internal sealed record WindowInfo(long Hwnd, int Pid, string Title, string Name, string Exe, bool Voice);

internal sealed record AppInfo(int Pid, string Name, string Exe, string Title, bool Voice, int Windows);

internal static class AppList
{
    private const int GwlExStyle = -20;
    private const long WsExToolWindow = 0x00000080;
    private const int DwmwaCloaked = 14;

    private static readonly HashSet<string> VoiceNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "oopz", "kook", "kookvoice", "discord", "discordcanary", "discordptb", "discorddevelopment",
        "qq", "qqnt", "wechat", "weixin", "wechatappex", "wxwork", "yy",
        "ts3client_win64", "ts3client", "teamspeak", "mumble", "skype",
        "zoom", "voov", "wemeetapp", "feishu", "lark", "dingtalk",
        "telegram", "telegramdesktop", "slack", "whatsapp", "line",
        "teams", "ms-teams", "msteams",
    };

    private static readonly Dictionary<int, (string Name, string Exe)> ProcessCache = new();

    public static bool IsVoiceName(string name)
    {
        return VoiceNames.Contains(name);
    }

    public static (string Name, string Exe) Describe(int pid)
    {
        lock (ProcessCache)
        {
            if (ProcessCache.TryGetValue(pid, out var cached)) return cached;
        }
        string name = "";
        string exe = "";
        try
        {
            using var process = Process.GetProcessById(pid);
            name = process.ProcessName;
            try { exe = process.MainModule?.FileName ?? ""; } catch { /* protected process */ }
        }
        catch { /* process exited */ }
        var result = (name, exe);
        lock (ProcessCache) ProcessCache[pid] = result;
        return result;
    }

    public static List<WindowInfo> Windows()
    {
        var windows = new List<WindowInfo>();
        var seen = new HashSet<long>();
        NativeMethods.EnumWindows((hwnd, _) =>
        {
            try
            {
                CollectWindow(windows, seen, hwnd);
            }
            catch { /* a single window must not break enumeration */ }
            return true;
        }, IntPtr.Zero);
        windows.Sort((a, b) => string.Compare(a.Title, b.Title, StringComparison.CurrentCultureIgnoreCase));
        return windows;
    }

    private static void CollectWindow(List<WindowInfo> windows, HashSet<long> seen, IntPtr hwnd)
    {
        if (!NativeMethods.IsWindowVisible(hwnd)) return;
        var length = NativeMethods.GetWindowTextLength(hwnd);
        if (length <= 0) return;
        var title = new StringBuilder(length + 1);
        if (NativeMethods.GetWindowText(hwnd, title, title.Capacity) <= 0) return;
        var text = title.ToString().Trim();
        if (text.Length == 0) return;

        var exStyle = NativeMethods.GetWindowLongPtr(hwnd, GwlExStyle).ToInt64();
        if ((exStyle & WsExToolWindow) != 0) return;
        if (NativeMethods.DwmGetWindowAttribute(hwnd, DwmwaCloaked, out var cloaked, sizeof(int)) == 0 && cloaked != 0) return;

        NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
        if (pid == 0 || pid == Environment.ProcessId) return;
        long handle = hwnd.ToInt64();
        if (!seen.Add(handle)) return;
        var (name, exe) = Describe((int)pid);
        windows.Add(new WindowInfo(handle, (int)pid, text, name, exe, IsVoiceName(name)));
    }

    public static List<AppInfo> Apps(List<WindowInfo> windows)
    {
        var apps = new Dictionary<int, AppInfo>();
        foreach (var window in windows)
        {
            if (window.Pid == Environment.ProcessId) continue;
            if (apps.TryGetValue(window.Pid, out var existing))
            {
                apps[window.Pid] = existing with { Windows = existing.Windows + 1, Title = existing.Title.Length == 0 ? window.Title : existing.Title };
            }
            else
            {
                apps[window.Pid] = new AppInfo(window.Pid, window.Name, window.Exe, window.Title, window.Voice, 1);
            }
        }

        // Voice clients often hide their window in the tray; those still need to be filterable.
        foreach (var process in Process.GetProcesses())
        {
            try
            {
                if (process.Id == Environment.ProcessId) continue;
                var name = process.ProcessName;
                if (!IsVoiceName(name) || apps.ContainsKey(process.Id)) continue;
                var (_, exe) = Describe(process.Id);
                apps[process.Id] = new AppInfo(process.Id, name, exe, "", true, 0);
            }
            catch { /* process exited or protected */ }
            finally { process.Dispose(); }
        }

        var result = apps.Values.ToList();
        result.Sort((a, b) =>
        {
            if (a.Voice != b.Voice) return a.Voice ? -1 : 1;
            var order = string.Compare(a.Name, b.Name, StringComparison.CurrentCultureIgnoreCase);
            return order != 0 ? order : a.Pid.CompareTo(b.Pid);
        });
        return result;
    }
}
