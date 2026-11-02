using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace PiikDesktop
{
    internal sealed class NativeRtc
    {
        private static IntPtr _library;
        private bool _joined;
        private int _leaving;
        private int _active;
        private int _leaveRequested;
        private int _remoteFrameErrors;
        private bool _frameCallbackSet;
        private bool _hooksLogged;
        private volatile bool _externalVideo;
        private int _videoPushErrors;
        private int _videoTimestampWarnings;
        private FrameCallback _frameCallback;
        public event Action<string, int, int, int, byte[], long> Frame;
        private readonly object _audioGate = new object();
        private byte[] _audioPending = new byte[65536];
        private int _audioPendingCount;
        private int _audioRate;
        private int _audioChannels;
        private int _audioPushed;
        private int _audioPushErrors;
        private static readonly string DirectoryPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "native-volc");
        public static bool Available => File.Exists(Path.Combine(DirectoryPath, "PiikVolc.dll"));
        public NativeRtc() { }

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
            if (!_frameCallbackSet)
            {
                _frameCallback = OnFrame;
                SetFrameCallback(Marshal.GetFunctionPointerForDelegate(_frameCallback));
                _frameCallbackSet = true;
            }
            var watch = Stopwatch.StartNew();
            if (operation != "poll" && operation != "render") Log.Write("native " + operation + " begin");
            var guarded = operation != "leave";
            if (guarded) Interlocked.Increment(ref _active);
            try
            {
                var result = Execute(operation, args, selected);
                if (operation != "poll" && operation != "render" || watch.ElapsedMilliseconds > 500)
                    Log.Write("native " + operation + " " + watch.ElapsedMilliseconds + "ms");
                return result;
            }
            catch (Exception exception)
            {
                Log.Write("native " + operation + " failed: " + exception.Message + " (" + watch.ElapsedMilliseconds + "ms)");
                throw;
            }
            finally
            {
                if (guarded)
                {
                    Interlocked.Decrement(ref _active);
                    if (Volatile.Read(ref _active) == 0 && Interlocked.Exchange(ref _leaveRequested, 0) != 0) Leave();
                }
            }
        }
        private object Execute(string operation, Dictionary<string, object> args, DesktopSource selected)
        {
            if (operation != "leave" && Volatile.Read(ref _leaving) != 0)
            {
                if (operation == "join" || operation == "start") throw new InvalidOperationException("原生媒体正在断开。");
                if (operation == "poll") return new Dictionary<string, object> { ["events"] = new List<object>() };
                return Ok(0);
            }
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
                    var externalVideo = Bridge.GetBool(args, "externalVideo");
                    var rect = externalVideo ? System.Drawing.Rectangle.Empty : SourceBounds(selected);
                    var process = "";
                    if (Bridge.GetString(args, "audioMode") == "app")
                    {
                        if (selected.Pid <= 0) throw new InvalidOperationException("无法确定程序音频来源。");
                        using (var app = Process.GetProcessById(selected.Pid)) process = app.ProcessName + ".exe";
                    }
                    var externalAudio = Bridge.GetBool(args, "externalAudio");
                    SetScreenAudio(externalAudio ? 1 : 0);
                    var audio = Bridge.GetBool(args, "audio");
                    Log.Write("native start: " + selected.Kind + " " + Bridge.GetInt(args, "width") + "x" + Bridge.GetInt(args, "height") + " fps=" + Bridge.GetInt(args, "fps") + " bitrate=" + Bridge.GetInt(args, "bitrate") + " audio=" + audio + " externalVideo=" + externalVideo + (process.Length > 0 ? " process=" + process : ""));
                    _externalVideo = externalVideo;
                    int startResult;
                    try
                    {
                        startResult = Start(selected.Kind == "window" ? 1 : 0, selected.Hwnd, rect.X, rect.Y,
                            Bridge.GetInt(args, "width"), Bridge.GetInt(args, "height"), Bridge.GetInt(args, "fps"), Bridge.GetInt(args, "bitrate"), process, audio ? 1 : 0, externalVideo ? 1 : 0);
                    }
                    catch
                    {
                        _externalVideo = false;
                        throw;
                    }
                    if (!externalVideo)
                    {
                        if (!_hooksLogged)
                        {
                            _hooksLogged = true;
                            Log.Write("native activation hooks=" + ActivationHooksInstalled());
                        }
                        var suppressed = SuppressedActivations();
                        if (suppressed > 0) Log.Write("native activation suppressed: " + suppressed);
                    }
                    return Ok(startResult);
                case "stop":
                    var stopResult = Stop();
                    _externalVideo = false;
                    var stopSuppressed = SuppressedActivations();
                    if (stopSuppressed > 0) Log.Write("native activation suppressed: " + stopSuppressed);
                    return Ok(stopResult);
                case "token": return Ok(Token(Bridge.GetString(args, "token")));
                case "subscribe": return Ok(Subscribe(Bridge.GetString(args, "streamId"), Bridge.GetString(args, "kind") == "audio" ? 1 : 0, Bridge.GetBool(args, "enabled") ? 1 : 0));
                case "volume": return Ok(Volume(Math.Max(0, Math.Min(100, Bridge.GetInt(args, "volume")))));
                case "render":
                    var streamId = Bridge.GetString(args, "streamId");
                    var visible = Bridge.GetBool(args, "visible");
                    if (streamId.Length == 0) return Ok(EnableLocalFramesNative(visible ? 1 : 0));
                    var frames = EnableRemoteFramesNative(streamId, visible ? 1 : 0);
                    if (frames < 0 && Interlocked.Increment(ref _remoteFrameErrors) <= 3) Log.Write("remote frames failed: " + frames);
                    return Ok(0);
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
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void FrameCallback(IntPtr stream, int width, int height, int rotation, IntPtr data, int length, long timestampUs);
        private void OnFrame(IntPtr streamPtr, int width, int height, int rotation, IntPtr data, int length, long timestampUs)
        {
            if (data == IntPtr.Zero || width <= 0 || height <= 0 || length <= 0) return;
            var bytes = new byte[length];
            try { Marshal.Copy(data, bytes, 0, length); }
            catch { return; }
            var stream = streamPtr == IntPtr.Zero ? "" : Marshal.PtrToStringAnsi(streamPtr) ?? "";
            Frame?.Invoke(stream, width, height, rotation, bytes, timestampUs);
        }
        public int PushVideo(RawVideoFrame frame)
        {
            if (!_joined || !_externalVideo || Volatile.Read(ref _leaving) != 0 || frame?.Data == null || frame.Length <= 0) return -1000;
            var handle = GCHandle.Alloc(frame.Data, GCHandleType.Pinned);
            try
            {
                var result = PushVideoNative(handle.AddrOfPinnedObject(), frame.Stride, frame.Width, frame.Height, frame.TimestampUs);
                if (result == -202)
                {
                    // kReturnStatusVideoTimeStampWarning: the SDK accepted the
                    // frame but the capture cadence differs from the push interval.
                    if (Interlocked.Increment(ref _videoTimestampWarnings) == 1) Log.Write("native video timestamp warning: " + result);
                }
                else if (result < 0 && result != -1000)
                {
                    if (Interlocked.Increment(ref _videoPushErrors) == 1) Log.Write("native video push failed: " + result);
                }
                return result;
            }
            catch (Exception exception)
            {
                if (Interlocked.Increment(ref _videoPushErrors) == 1) Log.Write("native video push failed: " + exception.Message);
                return -1;
            }
            finally { handle.Free(); }
        }
        public void PushAudio(byte[] data, int length, AudioFormat format)
        {
            if (!_joined || Volatile.Read(ref _leaving) != 0 || data == null || format == null || length <= 0) return;
            var channels = Math.Min(2, Math.Max(1, format.Channels));
            var rate = format.SampleRate;
            if (rate < 8000) return;
            var pcm = ConvertToS16(data, length, format, channels);
            if (pcm == null || pcm.Length == 0) return;
            var frameBytes = Math.Max(2, rate / 100 * channels * 2);
            lock (_audioGate)
            {
                if (rate != _audioRate || channels != _audioChannels)
                {
                    _audioRate = rate;
                    _audioChannels = channels;
                    _audioPendingCount = 0;
                }
                if (_audioPendingCount + pcm.Length > _audioPending.Length)
                    Array.Resize(ref _audioPending, Math.Max(_audioPending.Length * 2, _audioPendingCount + pcm.Length));
                Buffer.BlockCopy(pcm, 0, _audioPending, _audioPendingCount, pcm.Length);
                _audioPendingCount += pcm.Length;
                var frame = new byte[frameBytes];
                while (_audioPendingCount >= frameBytes)
                {
                    Buffer.BlockCopy(_audioPending, 0, frame, 0, frameBytes);
                    var pushed = PushScreenAudio(frame, frameBytes, rate, channels);
                    if (pushed < 0)
                    {
                        if (Interlocked.Increment(ref _audioPushErrors) == 1) Log.Write("native audio push failed: " + pushed);
                    }
                    else if (Interlocked.Increment(ref _audioPushed) == 1) Log.Write("native audio push started: " + rate + "Hz " + channels + "ch");
                    Buffer.BlockCopy(_audioPending, frameBytes, _audioPending, 0, _audioPendingCount - frameBytes);
                    _audioPendingCount -= frameBytes;
                }
            }
        }
        private static byte[] ConvertToS16(byte[] data, int length, AudioFormat format, int outChannels)
        {
            var inChannels = Math.Max(1, format.Channels);
            var isFloat = format.Encoding == "pcm_f32le" || (format.Bits == 32 && format.Encoding != "pcm_s32le");
            var isInt32 = format.Encoding == "pcm_s32le" || (format.Bits == 32 && !isFloat);
            var bytesPerSample = isFloat || isInt32 ? 4 : 2;
            var frames = length / (bytesPerSample * inChannels);
            if (frames <= 0) return null;
            var output = new byte[frames * outChannels * 2];
            var target = 0;
            for (var frame = 0; frame < frames; frame++)
            {
                var offset = frame * inChannels * bytesPerSample;
                for (var channel = 0; channel < outChannels; channel++)
                {
                    var sampleOffset = offset + channel * bytesPerSample;
                    short value;
                    if (isFloat)
                    {
                        var sample = BitConverter.ToSingle(data, sampleOffset);
                        value = sample <= -1f ? short.MinValue : sample >= 1f ? short.MaxValue : (short)Math.Round(sample * 32767f);
                    }
                    else if (isInt32) value = (short)(BitConverter.ToInt32(data, sampleOffset) >> 16);
                    else value = BitConverter.ToInt16(data, sampleOffset);
                    output[target++] = (byte)value;
                    output[target++] = (byte)(value >> 8);
                }
            }
            return output;
        }
        private static System.Drawing.Rectangle SourceBounds(DesktopSource source)
        {
            if (source.Kind == "screen")
            {
                var screens = Screen.AllScreens;
                if (source.ScreenIndex < 0 || source.ScreenIndex >= screens.Length) throw new InvalidOperationException("屏幕已断开，请重新选择。");
                return screens[source.ScreenIndex].Bounds;
            }
            var window = new IntPtr(source.Hwnd);
            if (!Win32.IsWindowVisible(window) || Win32.IsIconic(window)) throw new InvalidOperationException("共享窗口已最小化或不可见，请恢复窗口后重试。");
            if (!GetWindowRect(window, out var rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top) throw new InvalidOperationException("共享窗口已关闭。");
            return System.Drawing.Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
        }
        public void Leave()
        {
            if (!_joined) return;
            // A native call can pump window messages; never tear the engine
            // down from inside another call. The active call leaves afterwards.
            if (Volatile.Read(ref _active) != 0)
            {
                Interlocked.Exchange(ref _leaveRequested, 1);
                if (Volatile.Read(ref _active) != 0) return;
            }
            if (Interlocked.Exchange(ref _leaving, 1) != 0) return;
            // Clear the flag before entering the SDK: its teardown can pump
            // window messages, and a re-entrant leave must not destroy twice.
            _joined = false;
            _externalVideo = false;
            var watch = Stopwatch.StartNew();
            Log.Write("native leave begin");
            try { NativeLeave(); }
            finally
            {
                lock (_audioGate)
                {
                    _audioPendingCount = 0;
                    Interlocked.Exchange(ref _audioPushed, 0);
                    Interlocked.Exchange(ref _audioPushErrors, 0);
                }
                Interlocked.Exchange(ref _leaving, 0);
                Log.Write("native leave " + watch.ElapsedMilliseconds + "ms");
            }
        }
        [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_join", CallingConvention = CallingConvention.Cdecl)] private static extern int Join(string app, string room, string token, string uid);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_leave", CallingConvention = CallingConvention.Cdecl)] private static extern void NativeLeave();
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_start", CallingConvention = CallingConvention.Cdecl)] private static extern int Start(int window, long source, int x, int y, int width, int height, int fps, int bitrate, string process, int audio, int externalSource);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_push_video", CallingConvention = CallingConvention.Cdecl)] private static extern int PushVideoNative(IntPtr data, int stride, int width, int height, long timestampUs);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_stop", CallingConvention = CallingConvention.Cdecl)] private static extern int Stop();
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_set_screen_audio", CallingConvention = CallingConvention.Cdecl)] private static extern void SetScreenAudio(int external);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_push_audio", CallingConvention = CallingConvention.Cdecl)] private static extern int PushScreenAudio(byte[] data, int length, int sampleRate, int channels);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_set_frame_callback", CallingConvention = CallingConvention.Cdecl)] private static extern void SetFrameCallback(IntPtr callback);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_enable_local_frames", CallingConvention = CallingConvention.Cdecl)] private static extern int EnableLocalFramesNative(int enabled);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_enable_remote_frames", CallingConvention = CallingConvention.Cdecl)] private static extern int EnableRemoteFramesNative(string stream, int enabled);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_suppressed_activations", CallingConvention = CallingConvention.Cdecl)] private static extern long SuppressedActivations();
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_activation_hooks_installed", CallingConvention = CallingConvention.Cdecl)] private static extern int ActivationHooksInstalled();
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_token", CallingConvention = CallingConvention.Cdecl)] private static extern int Token(string token);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_subscribe", CallingConvention = CallingConvention.Cdecl)] private static extern int Subscribe(string stream, int audio, int enabled);        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_volume", CallingConvention = CallingConvention.Cdecl)] private static extern int Volume(int volume);
        [DllImport("PiikVolc.dll", EntryPoint = "piik_volc_poll", CallingConvention = CallingConvention.Cdecl)] private static extern int Poll([Out] byte[] buffer, int capacity);
    }
}
