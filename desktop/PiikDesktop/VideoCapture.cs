using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

namespace PiikDesktop
{
    internal sealed class VideoFrameData
    {
        public byte[] Data;
        public int Width;
        public int Height;
        public long Sequence;
    }

    internal sealed class VideoEndedInfo
    {
        public string Code;
        public string Message;
    }

    internal interface IVideoCapture
    {
        int Width { get; }
        int Height { get; }
        void Start();
        void Stop();
    }

    /// <summary>Captures a screen or window with GDI and publishes JPEG frames.</summary>
    internal sealed class VideoCapture : IVideoCapture
    {
        private readonly DesktopSource _source;
        private readonly int _requestedWidth;
        private readonly int _requestedHeight;
        private readonly int _fps;
        private readonly Action<VideoFrameData> _onFrame;
        private readonly Action<VideoEndedInfo> _onEnded;
        private readonly int _screenWidth;
        private readonly int _screenHeight;
        private volatile bool _running;
        private Thread _thread;

        public int Width { get; private set; }
        public int Height { get; private set; }

        public VideoCapture(DesktopSource source, int width, int height, int fps, Action<VideoFrameData> onFrame, Action<VideoEndedInfo> onEnded)
        {
            _source = source;
            _requestedWidth = width;
            _requestedHeight = height;
            _fps = Math.Max(1, Math.Min(60, fps));
            _onFrame = onFrame;
            _onEnded = onEnded;

            GetSourceSize(out _screenWidth, out _screenHeight);
            if (_screenWidth <= 1 || _screenHeight <= 1) throw new InvalidOperationException("共享来源尺寸无效。");

            if (_requestedWidth <= 0 || _requestedHeight <= 0)
            {
                Width = Even(_screenWidth);
                Height = Even(_screenHeight);
            }
            else
            {
                var scale = Math.Min((double)_requestedWidth / _screenWidth, (double)_requestedHeight / _screenHeight);
                if (scale <= 0 || scale > 1) scale = 1;
                Width = Even((int)Math.Round(_screenWidth * scale));
                Height = Even((int)Math.Round(_screenHeight * scale));
            }
            if (Width < 2) Width = 2;
            if (Height < 2) Height = 2;
        }

        private static int Even(int value)
        {
            return Math.Max(2, value - (value % 2));
        }

        private void GetSourceSize(out int width, out int height)
        {
            width = 0;
            height = 0;
            if (_source.Kind == "screen")
            {
                var screens = Screen.AllScreens;
                if (_source.ScreenIndex < 0 || _source.ScreenIndex >= screens.Length) return;
                var bounds = screens[_source.ScreenIndex].Bounds;
                width = bounds.Width;
                height = bounds.Height;
                return;
            }
            if (!Win32.IsWindow(new IntPtr(_source.Hwnd)) || !Win32.GetWindowRect(new IntPtr(_source.Hwnd), out var rect)) return;
            width = rect.Width;
            height = rect.Height;
        }

        public void Start()
        {
            if (_thread != null) return;
            _running = true;
            _thread = new Thread(Loop) { IsBackground = true, Name = "PiikVideoCapture" };
            _thread.Start();
        }

        private void Loop()
        {
            var interval = 1000.0 / _fps;
            var clock = new Stopwatch();
            long sequence = 0;
            Bitmap source = null;
            int sourceWidth = 0;
            int sourceHeight = 0;
            var target = new Bitmap(Width, Height, PixelFormat.Format24bppRgb);
            var targetGraphics = Graphics.FromImage(target);
            targetGraphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
            targetGraphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            targetGraphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
            var jpegCodec = ImageCodecInfo.GetImageEncoders().FirstOrDefault(item => item.MimeType == "image/jpeg");
            using (var parameters = new EncoderParameters(1))
            {
                parameters.Param[0] = new EncoderParameter(Encoder.Quality, 72L);
                try
                {
                    while (_running)
                    {
                        clock.Restart();
                        try
                        {
                            if (_source.Kind == "screen")
                            {
                                if (source == null || sourceWidth != _screenWidth || sourceHeight != _screenHeight)
                                {
                                    source?.Dispose();
                                    source = new Bitmap(_screenWidth, _screenHeight, PixelFormat.Format32bppArgb);
                                    sourceWidth = _screenWidth;
                                    sourceHeight = _screenHeight;
                                }
                                using (var graphics = Graphics.FromImage(source))
                                {
                                    var bounds = Screen.AllScreens[_source.ScreenIndex].Bounds;
                                    graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
                                }
                            }
                            else
                            {
                                var hwnd = new IntPtr(_source.Hwnd);
                                if (!Win32.IsWindow(hwnd) || Win32.IsIconic(hwnd))
                                {
                                    End("VIDEO_ENDED", "窗口已关闭或最小化，共享已停止。");
                                    return;
                                }
                                if (!Win32.GetWindowRect(hwnd, out var rect)) { End("VIDEO_ENDED", "窗口已关闭，共享已停止。"); return; }
                                if (rect.Width <= 1 || rect.Height <= 1) { Thread.Sleep(100); continue; }
                                if (source == null || sourceWidth != rect.Width || sourceHeight != rect.Height)
                                {
                                    source?.Dispose();
                                    source = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb);
                                    sourceWidth = rect.Width;
                                    sourceHeight = rect.Height;
                                }
                                var captured = false;
                                using (var graphics = Graphics.FromImage(source))
                                {
                                    var deviceContext = graphics.GetHdc();
                                    try { captured = Win32.PrintWindow(hwnd, deviceContext, Win32.PwRenderFullContent); }
                                    finally { graphics.ReleaseHdc(deviceContext); }
                                }
                                if (!captured)
                                {
                                    using (var graphics = Graphics.FromImage(source))
                                    {
                                        graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(rect.Width, rect.Height), CopyPixelOperation.SourceCopy);
                                    }
                                }
                            }

                            targetGraphics.DrawImage(source, 0, 0, Width, Height);
                            byte[] jpeg;
                            using (var stream = new MemoryStream())
                            {
                                if (jpegCodec != null) target.Save(stream, jpegCodec, parameters);
                                else target.Save(stream, ImageFormat.Jpeg);
                                jpeg = stream.ToArray();
                            }
                            _onFrame(new VideoFrameData { Data = jpeg, Width = Width, Height = Height, Sequence = sequence++ });

                            var elapsed = clock.Elapsed.TotalMilliseconds;
                            var wait = interval - elapsed;
                            if (wait > 0) Thread.Sleep((int)wait);
                        }
                        catch (Exception exception)
                        {
                            if (!_running) return;
                            Log.Write("video frame failed: " + exception);
                            End("VIDEO_FAILED", "画面采集失败：" + exception.Message);
                            return;
                        }
                    }
                }
                finally
                {
                    source?.Dispose();
                    targetGraphics.Dispose();
                    target.Dispose();
                }
            }
        }

        private void End(string code, string message)
        {
            try { _onEnded(new VideoEndedInfo { Code = code, Message = message }); }
            catch (Exception exception) { Log.Write("video end callback failed: " + exception.Message); }
        }

        public void Stop()
        {
            _running = false;
            var thread = _thread;
            _thread = null;
            if (thread != null && thread.IsAlive) thread.Join(2000);
        }
    }
}
