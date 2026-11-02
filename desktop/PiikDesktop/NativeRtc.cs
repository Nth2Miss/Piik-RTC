using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace PiikDesktop
{
    internal sealed class NativeRtc
    {
        private readonly IntPtr _parent;
        private static IntPtr _library;
        private bool _joined;
        private static readonly string DirectoryPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "native-volc");
        public static bool Available => File.Exists(Path.Combine(DirectoryPath, "PiikVolc.dll"));
        public NativeRtc(IntPtr parent) { _parent = parent; }

        private static void Load()
        {
            if (_library != IntPtr.Zero) return;
            if (!Available) throw new InvalidOperationException("未安装火山原生测试组件，请运行 npm run desktop:native:build。");
            _library = LoadLibraryEx(Path.Combine(DirectoryPath, "PiikVolc.dll"), IntPtr.Zero, 8);
            if (_library == IntPtr.Zero) throw new InvalidOperationException("火山原生组件加载失败，Windows 错误码：" + Marshal.GetLastWin32Error());
        }
        private static object Ok(int result)
        {
            if (result < 0) throw new InvalidOperationException("火山原生 SDK 调用失败，错误码：" + result);
            return new Dictionary<string, object> { ["ok"] = true };
        }
        public object Command(Dictionary<string, object> args, DesktopSource selected)
        {
            var operation = Bridge.GetString(args, "operation");
            if (operation == "available") return new Dictionary<string, object> { ["available"] = Available, ["version"] = "3.60.107.2100", ["transport"] = "volc-native" };
            Load();
            switch (operation)
            {
                case "join":
                    if (_joined) throw new InvalidOperationException("原生媒体已连接。");
                    _joined = true;
                    try { return Ok(Join(Bridge.GetString(args, "appId"), Bridge.GetString(args, "room"), Bridge.GetString(args, "token"), Bridge.GetString(args, "uid"))); }
                    catch { Leave(); throw; }
                case "leave": Leave(); return Ok(0);
                case "prepare":
                    if (selected == null) throw new InvalidOperationException("请先选择共享来源。");
                    var bounds = SourceBounds(selected);
                    var maxWidth = Bridge.GetInt(args, "width"); var maxHeight = Bridge.GetInt(args, "height");
                    var scale = Math.Min(1.0, Math.Min((double)maxWidth / bounds.Width, (double)maxHeight / bounds.Height));
                    return new Dictionary<string, object> { ["width"] = Math.Max(2, (int)(bounds.Width * scale) / 2 * 2), ["height"] = Math.Max(2, (int)(bounds.Height * scale) / 2 * 2) };
                case "start":
                    if (!_joined || selected == null) throw new InvalidOperationException("媒体未连接或共享来源已失效。");
                    if (Bridge.GetBool(args, "filterVoice")) throw new InvalidOperationException("原生测试版暂不支持过滤语音软件，请关闭过滤或选择仅共享程序声音。");
                    var rect = SourceBounds(selected);
                    var process = "";
                    if (Bridge.GetString(args, "audioMode") == "app")
                    {
                        if (selected.Pid <= 0) throw new InvalidOperationException("无法确定程序音频来源。");
                        using (var app = Process.GetProcessById(selected.Pid)) process = app.ProcessName + ".exe";
                    }
                    return Ok(Start(selected.Kind == "window" ? 1 : 0, selected.Hwnd, rect.X, rect.Y,
                        Bridge.GetInt(args, "width"), Bridge.GetInt(args, "height"), Bridge.GetInt(args, "fps"), Bridge.GetInt(args, "bitrate"), process, Bridge.GetBool(args, "audio") ? 1 : 0));
                case "stop": return Ok(Stop());
                case "token": return Ok(Token(Bridge.GetString(args, "token")));
                case "subscribe": return Ok(Subscribe(Bridge.GetString(args, "streamId"), Bridge.GetString(args, "kind") == "audio" ? 1 : 0, Bridge.GetBool(args, "enabled") ? 1 : 0));
                case "volume": return Ok(Volume(Math.Max(0, Math.Min(100, Bridge.GetInt(args, "volume")))));
                case "render": return Ok(Render(Bridge.GetString(args, "streamId"), _parent.ToInt64(), Bridge.GetInt(args, "x"), Bridge.GetInt(args, "y"), Bridge.GetInt(args, "width"), Bridge.GetInt(args, "height"), Bridge.GetBool(args, "fit") ? 1 : 0, Bridge.GetBool(args, "visible") ? 1 : 0));
                case "poll":
                    var events = new List<object>(); var buffer = new byte[16384];
                    for (var i = 0; i < 128; i++)
                    {
                        var length = Poll(buffer, buffer.Length); if (length <= 0) break;
                        events.Add(SimpleJson.ParseObject(Encoding.UTF8.GetString(buffer, 0, length)));
                    }
                    return new Dictionary<string, object> { ["events"] = events };
                default: throw new InvalidOperationException("未知原生媒体操作。");
            }
        }
        private static System.Drawing.Rectangle SourceBounds(DesktopSource source)
        {
            if (source.Kind == "screen")
            {
                var screens = Screen.AllScreens;
                if (source.ScreenIndex < 0 || source.ScreenIndex >= screens.Length) throw new InvalidOperationException("屏幕已断开，请重新选择。");
                return screens[source.ScreenIndex].Bounds;
            }
            if (!GetWindowRect(new IntPtr(source.Hwnd), out var rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top) throw new InvalidOperationException("共享窗口已关闭。");
            return System.Drawing.Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
        }
        public void Leave() { if (!_joined) return; try { NativeLeave(); } finally { _joined = false; } }
        [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_join", CallingConvention = CallingConvention.Cdecl)] private static extern int Join(string app, string room, string token, string uid);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_leave", CallingConvention = CallingConvention.Cdecl)] private static extern void NativeLeave();
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_start", CallingConvention = CallingConvention.Cdecl)] private static extern int Start(int window, long source, int x, int y, int width, int height, int fps, int bitrate, string process, int audio);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_stop", CallingConvention = CallingConvention.Cdecl)] private static extern int Stop();
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_token", CallingConvention = CallingConvention.Cdecl)] private static extern int Token(string token);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_subscribe", CallingConvention = CallingConvention.Cdecl)] private static extern int Subscribe(string stream, int audio, int enabled);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_volume", CallingConvention = CallingConvention.Cdecl)] private static extern int Volume(int volume);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_render", CallingConvention = CallingConvention.Cdecl)] private static extern int Render(string stream, long parent, int x, int y, int width, int height, int fit, int visible);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_poll", CallingConvention = CallingConvention.Cdecl)] private static extern int Poll([Out] byte[] buffer, int capacity);
    }
}
