using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace PiikRTC
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
        public bool Minimized;
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
                ["minimized"] = Minimized,
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
        private static readonly Dictionary<IntPtr, (string Data, DateTime At)> MinimizedThumbnailCache = new Dictionary<IntPtr, (string, DateTime)>();
        private static readonly object MinimizedThumbnailGate = new object();

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
            var watch = Stopwatch.StartNew();
            var result = new SourceListResult();
            result.Capabilities.Add("available", true);
            result.Capabilities.Add("processLoopback", ProcessLoopbackSupported);
            result.Capabilities.Add("osBuild", OsBuild);
            result.Capabilities.Add("arch", Environment.Is64BitProcess ? "x64" : "x86");
            result.Capabilities.Add("message", ProcessLoopbackSupported ? "" : "需要 Windows 10 2004（19041）或更高版本");

            var windows = EnumerateWindows();
            Log.Write("enumerate windows: " + windows.Count + " in " + watch.ElapsedMilliseconds + "ms");
            foreach (var window in windows)
            {
                // Keep minimized windows: the host restores them without
                // activation before WGC capture.
                if (!Win32.IsWindowVisible(window.Hwnd)) continue;
                var minimized = Win32.IsIconic(window.Hwnd);
                string thumbnail = "";
                var windowWatch = Stopwatch.StartNew();
                try
                {
                    if (minimized) thumbnail = MinimizedWindowThumbnail(window.Hwnd);
                    else
                    {
                        lock (MinimizedThumbnailGate) MinimizedThumbnailCache.Remove(window.Hwnd);
                        thumbnail = WindowThumbnail(window.Hwnd);
                    }
                }
                catch (Exception exception) { Log.Write("window thumbnail failed: " + exception.Message); }
                if (windowWatch.ElapsedMilliseconds > 400) Log.Write("window thumbnail slow: " + windowWatch.ElapsedMilliseconds + "ms " + window.Title);
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
                    Minimized = minimized,
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
                    if (!Win32.IsWindowVisible(hwnd)) return true;
                    // Resolve the owner first: GetWindowText blocks when the window
                    // belongs to our own hung helper (the SDK's capture windows).
                    Win32.GetWindowThreadProcessId(hwnd, out var pid);
                    if (pid == 0 || pid == currentPid) return true;
                    var length = Win32.GetWindowTextLength(hwnd);
                    if (length <= 0) return true;
                    var builder = new StringBuilder(length + 1);
                    if (Win32.GetWindowText(hwnd, builder, builder.Capacity) <= 0) return true;
                    var title = builder.ToString().Trim();
                    if (title.Length == 0) return true;
                    var style = Win32.GetWindowLongPtr(hwnd, Win32.GwlExStyle).ToInt64();
                    if ((style & Win32.WsExToolWindow) != 0) return true;
                    if (Win32.DwmGetWindowAttribute(hwnd, Win32.DwmwaCloaked, out var cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
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
            var watch = Stopwatch.StartNew();
            string name = "";
            try
            {
                using (var process = Process.GetProcessById(pid)) name = process.ProcessName;
            }
            catch { }
            // MainModule can block on game/anti-cheat processes. Only the icon
            // needs the path, so never let it delay the source list.
            var exe = name.Length > 0 ? ModulePath(pid) : "";
            var result = (name, exe);
            lock (ProcessCache) ProcessCache[pid] = result;
            if (watch.ElapsedMilliseconds > 50) Log.Write("describe slow: " + watch.ElapsedMilliseconds + "ms pid=" + pid + " " + name);
            return result;
        }

        private static string ModulePath(int pid)
        {
            string path = "";
            var thread = new Thread(() =>
            {
                try
                {
                    using (var process = Process.GetProcessById(pid))
                        path = process.MainModule != null ? process.MainModule.FileName : "";
                }
                catch { }
            }) { IsBackground = true };
            thread.Start();
            if (!thread.Join(250)) { Log.Write("module path timeout: pid=" + pid); return ""; }
            return path;
        }

        private static bool Responsive(IntPtr hwnd)
        {
            if (Win32.IsHungAppWindow(hwnd)) return false;
            return Win32.SendMessageTimeout(hwnd, Win32.WmNull, IntPtr.Zero, IntPtr.Zero, Win32.SmtoAbortIfHung, 80, out _) != IntPtr.Zero;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WindowPlacement
        {
            public int Length;
            public int Flags;
            public int ShowCmd;
            public Point MinPosition;
            public Point MaxPosition;
            public Win32.Rect NormalPosition;
        }

        [DllImport("user32.dll")]
        private static extern bool GetWindowPlacement(IntPtr hwnd, ref WindowPlacement placement);

        [DllImport("ole32.dll")]
        private static extern int CoInitializeEx(IntPtr reserved, uint coInit);

        [DllImport("ole32.dll")]
        private static extern void CoUninitialize();

        private static string MinimizedWindowThumbnail(IntPtr hwnd)
        {
            lock (MinimizedThumbnailGate)
            {
                if (MinimizedThumbnailCache.TryGetValue(hwnd, out var cached) && (DateTime.UtcNow - cached.At).TotalSeconds < 40)
                    return cached.Data;
            }
            if (!Win32.IsWindowVisible(hwnd) || !Responsive(hwnd)) return "";
            var data = "";
            try { data = ThumbnailViaDwmHost(hwnd); }
            catch (Exception exception) { Log.Write("dwm thumbnail failed: " + exception.Message); }
            lock (MinimizedThumbnailGate) MinimizedThumbnailCache[hwnd] = (data, DateTime.UtcNow);
            return data;
        }

        private static string ThumbnailViaDwmHost(IntPtr source)
        {
            var previous = Win32.GetForegroundWindow();
            if (previous == IntPtr.Zero) return "";
            var hostWidth = 720;
            var hostHeight = 406;
            var x = 40;
            var y = 40;
            if (previous != IntPtr.Zero && Win32.GetWindowRect(previous, out var foreground) && foreground.Right > foreground.Left && foreground.Bottom > foreground.Top)
            {
                hostWidth = Math.Max(320, Math.Min(720, foreground.Width - 80));
                hostHeight = Math.Max(180, Math.Min(406, foreground.Height - 80));
                x = foreground.Left + 40;
                y = foreground.Top + 40;
            }
            // The host stays behind the picker window; the source window is never
            // restored or activated. DWM composes the thumbnail into the host and
            // WGC captures the host frame.
            var host = Win32.CreateWindowEx(Win32.WsExNoActivate, "STATIC", "", Win32.WsPopup | Win32.SsBlackRect,
                x, y, hostWidth, hostHeight, IntPtr.Zero, IntPtr.Zero, Win32.GetModuleHandle(null), IntPtr.Zero);
            if (host == IntPtr.Zero) return "";
            IntPtr thumbnail = IntPtr.Zero;
            try
            {
                Win32.ShowWindow(host, Win32.SwShowNoActivate);
                if (previous != IntPtr.Zero)
                    Win32.SetWindowPos(host, previous, x, y, hostWidth, hostHeight, Win32.SwpNoactivate | Win32.SwpShowWindow);
                if (Win32.DwmRegisterThumbnail(host, source, out thumbnail) != 0) return "";
                var properties = new Win32.ThumbnailProperties
                {
                    Flags = Win32.DwmTnRectDestination | Win32.DwmTnOpacity | Win32.DwmTnVisible | Win32.DwmTnSourceClientAreaOnly,
                    Destination = new Win32.Rect { Left = 0, Top = 0, Right = hostWidth, Bottom = hostHeight },
                    Opacity = 255,
                    Visible = true,
                    SourceClientAreaOnly = false,
                };
                if (Win32.DwmUpdateThumbnailProperties(thumbnail, ref properties) != 0) return "";
                Win32.DwmFlush();
                Thread.Sleep(80);
                return CaptureHostJpeg(host, hostWidth, hostHeight);
            }
            finally
            {
                if (thumbnail != IntPtr.Zero) Win32.DwmUnregisterThumbnail(thumbnail);
                Win32.DestroyWindow(host);
            }
        }

        private static string CaptureHostJpeg(IntPtr hwnd, int width, int height)
        {
            var com = CoInitializeEx(IntPtr.Zero, 0);
            try
            {
                var source = new DesktopSource { Id = "thumbnail", Kind = "window", Name = "thumbnail", Hwnd = hwnd.ToInt64() };
                RawVideoFrame captured = null;
                using (var ready = new ManualResetEventSlim(false))
                {
                    var capture = new WgcCapture(source, width, height, 10,
                        frame =>
                        {
                            if (captured == null)
                            {
                                captured = new RawVideoFrame
                                {
                                    Data = (byte[])frame.Data.Clone(),
                                    Length = frame.Length,
                                    Width = frame.Width,
                                    Height = frame.Height,
                                    Stride = frame.Stride,
                                };
                            }
                            frame.Release?.Invoke();
                            ready.Set();
                        },
                        info => ready.Set());
                    try
                    {
                        capture.Start();
                        if (!ready.Wait(1500) || captured == null) return "";
                    }
                    catch { return ""; }
                    finally { try { capture.Stop(); } catch { } }
                }
                using (var bitmap = new Bitmap(captured.Width, captured.Height, PixelFormat.Format32bppArgb))
                {
                    var bits = bitmap.LockBits(new Rectangle(0, 0, captured.Width, captured.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                    try
                    {
                        for (var row = 0; row < captured.Height; row++)
                            Marshal.Copy(captured.Data, row * captured.Stride, IntPtr.Add(bits.Scan0, row * bits.Stride), captured.Width * 4);
                    }
                    finally { bitmap.UnlockBits(bits); }
                    if (!HasContent(bitmap)) return "";
                    return LetterboxJpeg(bitmap);
                }
            }
            finally
            {
                if (com >= 0) CoUninitialize();
            }
        }

        private static string WindowThumbnail(IntPtr hwnd)
        {
            var iconic = Win32.IsIconic(hwnd);
            Rectangle rect;
            if (iconic)
            {
                var placement = new WindowPlacement { Length = Marshal.SizeOf(typeof(WindowPlacement)) };
                if (!GetWindowPlacement(hwnd, ref placement)) return "";
                var normal = placement.NormalPosition;
                rect = Rectangle.FromLTRB(normal.Left, normal.Top, normal.Right, normal.Bottom);
            }
            else
            {
                Win32.GetWindowRect(hwnd, out var raw);
                rect = Rectangle.FromLTRB(raw.Left, raw.Top, raw.Right, raw.Bottom);
            }
            var width = rect.Width;
            var height = rect.Height;
            if (width <= 1 || height <= 1) return "";
            // PrintWindow blocks until the target window answers WM_PRINT. Skip
            // hung windows so one window cannot stall the list. Minimized windows
            // are still tried: many apps answer WM_PRINT with their last frame.
            if (!Responsive(hwnd)) return "";
            using (var source = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                var captured = false;
                using (var graphics = Graphics.FromImage(source))
                {
                    var deviceContext = graphics.GetHdc();
                    try { captured = Win32.PrintWindow(hwnd, deviceContext, Win32.PwRenderFullContent); }
                    finally { graphics.ReleaseHdc(deviceContext); }
                }
                if (!captured && !iconic && rect.Left > -30000 && rect.Top > -30000)
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
                if (!captured || !HasContent(source)) return "";
                return LetterboxJpeg(source);
            }
        }

        private static bool HasContent(Bitmap bitmap)
        {
            var stepX = Math.Max(1, bitmap.Width / 24);
            var stepY = Math.Max(1, bitmap.Height / 24);
            for (var y = 0; y < bitmap.Height; y += stepY)
            {
                for (var x = 0; x < bitmap.Width; x += stepX)
                {
                    var pixel = bitmap.GetPixel(x, y);
                    if (pixel.A > 16 && (pixel.R > 8 || pixel.G > 8 || pixel.B > 8)) return true;
                }
            }
            return false;
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
