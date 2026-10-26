using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;

namespace PiikDesktop
{
    internal sealed class DesktopSource
    {
        public string Id = "";
        public string Kind = "window";
        public string Name = "";
        public string Thumbnail = "";
        public string Icon = "";
        public string DisplayId = "";
        public long Hwnd;
        public int Pid;
        public string AppName = "";
        public bool Voice;
        public int ScreenIndex = -1;

        public Dictionary<string, object> ToJson()
        {
            return new Dictionary<string, object>
            {
                ["id"] = Id,
                ["kind"] = Kind,
                ["name"] = Name,
                ["thumbnail"] = Thumbnail,
                ["icon"] = string.IsNullOrEmpty(Icon) ? null : Icon,
                ["displayId"] = string.IsNullOrEmpty(DisplayId) ? null : DisplayId,
                ["hwnd"] = Hwnd == 0 ? (object)null : Hwnd,
                ["pid"] = Pid <= 0 ? (object)null : Pid,
                ["appName"] = string.IsNullOrEmpty(AppName) ? null : AppName,
                ["voice"] = Voice,
            };
        }
    }

    internal sealed class DesktopAppInfo
    {
        public int Pid;
        public string Name = "";
        public string Exe = "";
        public string Title = "";
        public bool Voice;
        public int Windows;

        public Dictionary<string, object> ToJson()
        {
            return new Dictionary<string, object>
            {
                ["pid"] = Pid,
                ["name"] = Name,
                ["exe"] = Exe,
                ["title"] = Title,
                ["voice"] = Voice,
                ["windows"] = Windows,
            };
        }
    }

    internal sealed class SourceListResult
    {
        public readonly List<DesktopSource> Sources = new List<DesktopSource>();
        public readonly List<DesktopAppInfo> Apps = new List<DesktopAppInfo>();
        public readonly Dictionary<string, object> Capabilities = new Dictionary<string, object>();

        public Dictionary<string, object> ToJson()
        {
            return new Dictionary<string, object>
            {
                ["sources"] = Sources.Select(source => (object)source.ToJson()).ToList(),
                ["apps"] = Apps.Select(app => (object)app.ToJson()).ToList(),
                ["capabilities"] = Capabilities,
            };
        }
    }

    internal static class SourceList
    {
        private const int ThumbnailWidth = 360;
        private const int ThumbnailHeight = 203;
        private static readonly Dictionary<int, (string Name, string Exe)> ProcessCache = new Dictionary<int, (string, string)>();
        private static readonly Dictionary<string, string> IconCache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        private static readonly HashSet<string> VoiceNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "oopz", "kook", "kookvoice", "discord", "discordcanary", "discordptb", "discorddevelopment",
            "qq", "qqnt", "wechat", "weixin", "wechatappex", "wxwork", "yy",
            "ts3client_win64", "ts3client", "teamspeak", "mumble", "skype",
            "zoom", "voov", "wemeetapp", "feishu", "lark", "dingtalk",
            "telegram", "telegramdesktop", "slack", "whatsapp", "line",
            "teams", "ms-teams", "msteams",
        };

        public static bool IsVoiceName(string name)
        {
            return !string.IsNullOrEmpty(name) && VoiceNames.Contains(name);
        }

        public static int OsBuild
        {
            get
            {
                try { return Environment.OSVersion.Version.Build; } catch { return 0; }
            }
        }

        public static bool ProcessLoopbackSupported
        {
            get { return OsBuild >= 19041; }
        }

        public static Dictionary<string, object> Capabilities()
        {
            return new Dictionary<string, object>
            {
                ["available"] = true,
                ["processLoopback"] = ProcessLoopbackSupported,
                ["osBuild"] = OsBuild,
                ["arch"] = Environment.Is64BitProcess ? "x64" : "x86",
                ["message"] = ProcessLoopbackSupported ? "" : "需要 Windows 10 2004（19041）或更高版本",
            };
        }

        public static SourceListResult List()
        {
            var result = new SourceListResult();
            result.Capabilities.Add("available", true);
            result.Capabilities.Add("processLoopback", ProcessLoopbackSupported);
            result.Capabilities.Add("osBuild", OsBuild);
            result.Capabilities.Add("arch", Environment.Is64BitProcess ? "x64" : "x86");
            result.Capabilities.Add("message", ProcessLoopbackSupported ? "" : "需要 Windows 10 2004（19041）或更高版本");

            var windows = EnumerateWindows();
            foreach (var window in windows)
            {
                string thumbnail = "";
                try { thumbnail = WindowThumbnail(window.Hwnd); } catch (Exception exception) { Log.Write("window thumbnail failed: " + exception.Message); }
                result.Sources.Add(new DesktopSource
                {
                    Id = "window:" + window.Hwnd.ToInt64(),
                    Kind = "window",
                    Name = window.Title,
                    Thumbnail = thumbnail,
                    Icon = IconFor(window.Exe),
                    Hwnd = window.Hwnd.ToInt64(),
                    Pid = window.Pid,
                    AppName = window.Name,
                    Voice = window.Voice,
                });
            }

            var screens = Screen.AllScreens;
            for (var index = 0; index < screens.Length; index++)
            {
                var screen = screens[index];
                string thumbnail = "";
                try { thumbnail = ScreenThumbnail(screen.Bounds); } catch (Exception exception) { Log.Write("screen thumbnail failed: " + exception.Message); }
                result.Sources.Add(new DesktopSource
                {
                    Id = "screen:" + index,
                    Kind = "screen",
                    Name = "屏幕 " + (index + 1),
                    Thumbnail = thumbnail,
                    Icon = "",
                    DisplayId = screen.DeviceName,
                    ScreenIndex = index,
                });
            }

            var apps = new Dictionary<int, DesktopAppInfo>();
            foreach (var window in windows)
            {
                if (apps.TryGetValue(window.Pid, out var existing))
                {
                    existing.Windows++;
                    if (existing.Title.Length == 0) existing.Title = window.Title;
                }
                else
                {
                    apps[window.Pid] = new DesktopAppInfo
                    {
                        Pid = window.Pid,
                        Name = window.Name,
                        Exe = window.Exe,
                        Title = window.Title,
                        Voice = window.Voice,
                        Windows = 1,
                    };
                }
            }

            var currentPid = Process.GetCurrentProcess().Id;
            foreach (var process in Process.GetProcesses())
            {
                try
                {
                    if (process.Id == currentPid) continue;
                    var name = process.ProcessName;
                    if (!IsVoiceName(name) || apps.ContainsKey(process.Id)) continue;
                    var (_, exe) = Describe(process.Id);
                    apps[process.Id] = new DesktopAppInfo { Pid = process.Id, Name = name, Exe = exe, Voice = true };
                }
                catch { /* protected or exited */ }
                finally { process.Dispose(); }
            }

            result.Apps.AddRange(apps.Values
                .Where(app => app.Pid != currentPid)
                .OrderByDescending(app => app.Voice)
                .ThenBy(app => app.Name, StringComparer.CurrentCultureIgnoreCase)
                .ThenBy(app => app.Pid));

            return result;
        }

        private sealed class WindowEntry
        {
            public IntPtr Hwnd;
            public int Pid;
            public string Title = "";
            public string Name = "";
            public string Exe = "";
            public bool Voice;
        }

        private static List<WindowEntry> EnumerateWindows()
        {
            var result = new List<WindowEntry>();
            var currentPid = Process.GetCurrentProcess().Id;
            Win32.EnumWindows((hwnd, _) =>
            {
                try
                {
                    if (!Win32.IsWindowVisible(hwnd) || Win32.IsIconic(hwnd)) return true;
                    var length = Win32.GetWindowTextLength(hwnd);
                    if (length <= 0) return true;
                    var builder = new StringBuilder(length + 1);
                    if (Win32.GetWindowText(hwnd, builder, builder.Capacity) <= 0) return true;
                    var title = builder.ToString().Trim();
                    if (title.Length == 0) return true;
                    var style = Win32.GetWindowLongPtr(hwnd, Win32.GwlExStyle).ToInt64();
                    if ((style & Win32.WsExToolWindow) != 0) return true;
                    if (Win32.DwmGetWindowAttribute(hwnd, Win32.DwmwaCloaked, out var cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
                    Win32.GetWindowThreadProcessId(hwnd, out var pid);
                    if (pid == 0 || pid == currentPid) return true;
                    var (name, exe) = Describe((int)pid);
                    result.Add(new WindowEntry
                    {
                        Hwnd = hwnd,
                        Pid = (int)pid,
                        Title = title,
                        Name = name,
                        Exe = exe,
                        Voice = IsVoiceName(name),
                    });
                }
                catch { /* one window must not break the list */ }
                return true;
            }, IntPtr.Zero);
            result.Sort((left, right) => string.Compare(left.Title, right.Title, StringComparison.CurrentCultureIgnoreCase));
            return result;
        }

        private static (string Name, string Exe) Describe(int pid)
        {
            lock (ProcessCache)
            {
                if (ProcessCache.TryGetValue(pid, out var cached)) return cached;
            }
            string name = "";
            string exe = "";
            try
            {
                using (var process = Process.GetProcessById(pid))
                {
                    name = process.ProcessName;
                    try { exe = process.MainModule != null ? process.MainModule.FileName : ""; } catch { }
                }
            }
            catch { }
            var result = (name, exe);
            lock (ProcessCache) ProcessCache[pid] = result;
            return result;
        }

        private static string WindowThumbnail(IntPtr hwnd)
        {
            Win32.GetWindowRect(hwnd, out var rect);
            var width = rect.Width;
            var height = rect.Height;
            if (width <= 1 || height <= 1) return "";
            using (var source = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                var captured = false;
                using (var graphics = Graphics.FromImage(source))
                {
                    var deviceContext = graphics.GetHdc();
                    try { captured = Win32.PrintWindow(hwnd, deviceContext, Win32.PwRenderFullContent); }
                    finally { graphics.ReleaseHdc(deviceContext); }
                }
                if (!captured)
                {
                    try
                    {
                        using (var graphics = Graphics.FromImage(source))
                        {
                            graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
                        }
                        captured = true;
                    }
                    catch { }
                }
                if (!captured) return "";
                return LetterboxJpeg(source);
            }
        }

        private static string ScreenThumbnail(Rectangle bounds)
        {
            if (bounds.Width <= 1 || bounds.Height <= 1) return "";
            using (var source = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb))
            {
                using (var graphics = Graphics.FromImage(source))
                {
                    graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
                }
                return LetterboxJpeg(source);
            }
        }

        private static string LetterboxJpeg(Bitmap source)
        {
            const int width = ThumbnailWidth;
            const int height = ThumbnailHeight;
            using (var target = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            using (var graphics = Graphics.FromImage(target))
            using (var stream = new MemoryStream())
            {
                graphics.Clear(Color.FromArgb(12, 19, 32));
                graphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.SmoothingMode = SmoothingMode.HighQuality;
                var scale = Math.Min((double)width / source.Width, (double)height / source.Height);
                var drawWidth = Math.Max(1, (int)Math.Round(source.Width * scale));
                var drawHeight = Math.Max(1, (int)Math.Round(source.Height * scale));
                graphics.DrawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
                var codec = ImageCodecInfo.GetImageEncoders().FirstOrDefault(item => item.MimeType == "image/jpeg");
                using (var parameters = new EncoderParameters(1))
                {
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 68L);
                    if (codec != null) target.Save(stream, codec, parameters);
                    else target.Save(stream, ImageFormat.Jpeg);
                }
                return "data:image/jpeg;base64," + Convert.ToBase64String(stream.ToArray());
            }
        }

        private static string IconFor(string executable)
        {
            if (string.IsNullOrEmpty(executable)) return "";
            lock (IconCache)
            {
                if (IconCache.TryGetValue(executable, out var cached)) return cached;
            }
            string data = "";
            try
            {
                using (var icon = Icon.ExtractAssociatedIcon(executable))
                {
                    if (icon != null)
                    {
                        using (var bitmap = icon.ToBitmap())
                        using (var stream = new MemoryStream())
                        {
                            bitmap.Save(stream, ImageFormat.Png);
                            data = "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
                        }
                    }
                }
            }
            catch { }
            lock (IconCache) IconCache[executable] = data;
            return data;
        }

        public static Bitmap EncodeTarget(Bitmap source, int width, int height)
        {
            var target = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using (var graphics = Graphics.FromImage(target))
            {
                graphics.Clear(Color.Black);
                graphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.SmoothingMode = SmoothingMode.HighQuality;
                graphics.DrawImage(source, 0, 0, width, height);
            }
            return target;
        }
    }
}
