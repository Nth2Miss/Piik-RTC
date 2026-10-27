using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;

namespace PiikDesktop
{
    internal sealed class RawVideoFrame
    {
        public byte[] Data;
        public int Width;
        public int Height;
        public int Stride;
        public long Sequence;
        public long TimestampUs;
    }

    /// <summary>
    /// Captures a window or monitor with Windows Graphics Capture, copies the
    /// GPU surface to CPU once, and emits BGRA frames. The WebView2 side wraps
    /// these frames in VideoFrames so the RTC SDK encodes them only once.
    /// </summary>
    internal sealed class WgcCapture : IVideoCapture
    {
        [DllImport("d3d11.dll", ExactSpelling = true)]
        private static extern int D3D11CreateDevice(
            IntPtr adapter, int driverType, IntPtr software, uint flags,
            IntPtr featureLevels, uint featureLevelsCount, uint sdkVersion,
            out IntPtr device, out int featureLevel, out IntPtr context);

        [DllImport("d3d11.dll", ExactSpelling = true)]
        private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

        [DllImport("kernel32.dll", EntryPoint = "RtlMoveMemory")]
        private static extern void CopyMemory(IntPtr destination, IntPtr source, UIntPtr length);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromPoint(POINT point, uint flags);

        [DllImport("combase.dll", ExactSpelling = true)]
        private static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string sourceString, int length, out IntPtr hstring);

        [DllImport("combase.dll", ExactSpelling = true)]
        private static extern int WindowsDeleteString(IntPtr hstring);

        [DllImport("combase.dll", ExactSpelling = true)]
        private static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [ComImport]
        [Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IGraphicsCaptureItemInterop
        {
            [PreserveSig] int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr item);
            [PreserveSig] int CreateForMonitor(IntPtr monitor, ref Guid iid, out IntPtr item);
        }

        [ComImport]
        [Guid("5B0D3235-4DBA-4D44-865E-8F1D0E4FD04D")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMemoryBufferByteAccess
        {
            void GetBuffer(out IntPtr buffer, out uint capacity);
        }

        private const int D3D_DRIVER_TYPE_HARDWARE = 1;
        private const int D3D_DRIVER_TYPE_WARP = 5;
        private const uint D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
        private const uint D3D11_SDK_VERSION = 7;
        private const uint MONITOR_DEFAULTTONEAREST = 2;
        private static readonly Guid DxgiDeviceGuid = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
        private static readonly Guid GraphicsCaptureItemGuid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");

        private readonly DesktopSource _source;
        private readonly int _requestedWidth;
        private readonly int _requestedHeight;
        private readonly int _fps;
        private readonly Action<RawVideoFrame> _onFrame;
        private readonly Action<VideoEndedInfo> _onEnded;
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly object _gate = new object();
        private volatile bool _running;
        private int _ended;
        private long _sequence;
        private long _lastFrameTicks;
        private IDirect3DDevice _device;
        private GraphicsCaptureItem _item;
        private Direct3D11CaptureFramePool _framePool;
        private GraphicsCaptureSession _session;
        private System.Threading.Timer _watchdog;
        private SizeInt32 _poolSize;
        private Bitmap _sourceBitmap;
        private Bitmap _target;
        private Graphics _targetGraphics;

        public int Width { get; private set; }
        public int Height { get; private set; }

        public WgcCapture(DesktopSource source, int width, int height, int fps,
            Action<RawVideoFrame> onFrame, Action<VideoEndedInfo> onEnded)
        {
            _source = source ?? throw new ArgumentNullException(nameof(source));
            _requestedWidth = width;
            _requestedHeight = height;
            _fps = Math.Max(1, Math.Min(60, fps));
            _onFrame = onFrame ?? throw new ArgumentNullException(nameof(onFrame));
            _onEnded = onEnded ?? throw new ArgumentNullException(nameof(onEnded));
        }

        public static bool IsSupported()
        {
            try { return GraphicsCaptureSession.IsSupported(); }
            catch { return false; }
        }

        public void Start()
        {
            if (_running) return;
            _device = CreateDevice();
            _item = CreateItem();
            _poolSize = _item.Size;
            if (_poolSize.Width <= 1 || _poolSize.Height <= 1) throw new InvalidOperationException("共享来源尺寸无效。");
            ComputeTargetSize(_poolSize.Width, _poolSize.Height);
            _framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                _device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 3, _poolSize);
            _framePool.FrameArrived += OnFrameArrived;
            _session = _framePool.CreateCaptureSession(_item);
            _session.IsCursorCaptureEnabled = false;
            try { _session.IsBorderRequired = false; } catch { /* older Windows versions always draw the border */ }
            _running = true;
            _session.StartCapture();
            _watchdog = new System.Threading.Timer(Watchdog, null, 500, 500);
        }

        private static IDirect3DDevice CreateDevice()
        {
            foreach (var driver in new[] { D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP })
            {
                IntPtr devicePtr;
                IntPtr contextPtr;
                var hr = D3D11CreateDevice(IntPtr.Zero, driver, IntPtr.Zero, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    IntPtr.Zero, 0, D3D11_SDK_VERSION, out devicePtr, out _, out contextPtr);
                if (hr < 0) continue;
                try
                {
                    IntPtr dxgiDevice;
                    var dxgiDeviceGuid = DxgiDeviceGuid;
                    hr = Marshal.QueryInterface(devicePtr, ref dxgiDeviceGuid, out dxgiDevice);
                    if (hr < 0) continue;
                    try
                    {
                        IntPtr inspectable;
                        hr = CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice, out inspectable);
                        if (hr < 0) continue;
                        try { return (IDirect3DDevice)Marshal.GetObjectForIUnknown(inspectable); }
                        finally { Marshal.Release(inspectable); }
                    }
                    finally { Marshal.Release(dxgiDevice); }
                }
                finally
                {
                    if (contextPtr != IntPtr.Zero) Marshal.Release(contextPtr);
                    Marshal.Release(devicePtr);
                }
            }
            throw new InvalidOperationException("无法创建 Direct3D 设备，硬件采集不可用。");
        }

        private GraphicsCaptureItem CreateItem()
        {
            var interop = GetItemInterop();
            var iid = GraphicsCaptureItemGuid;
            IntPtr itemPtr;
            int hr;
            if (_source.Kind == "screen")
            {
                var screens = Screen.AllScreens;
                if (_source.ScreenIndex < 0 || _source.ScreenIndex >= screens.Length) throw new InvalidOperationException("共享屏幕已失效。");
                var bounds = screens[_source.ScreenIndex].Bounds;
                var monitor = MonitorFromPoint(new POINT { X = bounds.Left + 1, Y = bounds.Top + 1 }, MONITOR_DEFAULTTONEAREST);
                hr = interop.CreateForMonitor(monitor, ref iid, out itemPtr);
            }
            else
            {
                var hwnd = new IntPtr(_source.Hwnd);
                if (!Win32.IsWindow(hwnd)) throw new InvalidOperationException("共享窗口已关闭。");
                hr = interop.CreateForWindow(hwnd, ref iid, out itemPtr);
            }
            Marshal.ThrowExceptionForHR(hr);
            try { return (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(itemPtr); }
            finally { Marshal.Release(itemPtr); }
        }

        private static IGraphicsCaptureItemInterop GetItemInterop()
        {
            const string className = "Windows.Graphics.Capture.GraphicsCaptureItem";
            var iid = typeof(IGraphicsCaptureItemInterop).GUID;
            var hr = WindowsCreateString(className, className.Length, out var hstring);
            Marshal.ThrowExceptionForHR(hr);
            try
            {
                hr = RoGetActivationFactory(hstring, ref iid, out var factoryPtr);
                Marshal.ThrowExceptionForHR(hr);
                try { return (IGraphicsCaptureItemInterop)Marshal.GetObjectForIUnknown(factoryPtr); }
                finally { Marshal.Release(factoryPtr); }
            }
            finally { WindowsDeleteString(hstring); }
        }

        private void ComputeTargetSize(int sourceWidth, int sourceHeight)
        {
            if (_requestedWidth <= 0 || _requestedHeight <= 0)
            {
                Width = Even(sourceWidth);
                Height = Even(sourceHeight);
            }
            else
            {
                var scale = Math.Min((double)_requestedWidth / sourceWidth, (double)_requestedHeight / sourceHeight);
                if (scale <= 0 || scale > 1) scale = 1;
                Width = Even((int)Math.Round(sourceWidth * scale));
                Height = Even((int)Math.Round(sourceHeight * scale));
            }
            if (Width < 2) Width = 2;
            if (Height < 2) Height = 2;
            _target = new Bitmap(Width, Height, PixelFormat.Format32bppArgb);
            _targetGraphics = Graphics.FromImage(_target);
            _targetGraphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
            _targetGraphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            _targetGraphics.SmoothingMode = SmoothingMode.HighQuality;
        }

        private static int Even(int value)
        {
            return Math.Max(2, value - (value % 2));
        }

        private void OnFrameArrived(Direct3D11CaptureFramePool sender, object args)
        {
            if (!_running) return;
            try
            {
                using (var frame = sender.TryGetNextFrame())
                {
                    if (frame == null) return;
                    var size = frame.ContentSize;
                    if (size.Width <= 1 || size.Height <= 1) return;
                    if (size.Width != _poolSize.Width || size.Height != _poolSize.Height)
                    {
                        _poolSize = size;
                        sender.Recreate(_device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 3, size);
                        return;
                    }
                    var interval = Stopwatch.Frequency / (double)_fps;
                    var now = _clock.ElapsedTicks;
                    if (_lastFrameTicks != 0 && now - _lastFrameTicks < interval) return;
                    _lastFrameTicks = now;
                    using (var software = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface, BitmapAlphaMode.Ignore)
                        .AsTask().GetAwaiter().GetResult())
                    {
                        Emit(software);
                    }
                }
            }
            catch (Exception exception)
            {
                if (!_running) return;
                Log.Write("WGC frame failed: " + exception);
                End("VIDEO_FAILED", "硬件画面采集失败：" + exception.Message);
            }
        }

        private void Emit(SoftwareBitmap software)
        {
            var sourceWidth = software.PixelWidth;
            var sourceHeight = software.PixelHeight;
            if (sourceWidth <= 0 || sourceHeight <= 0) return;
            lock (_gate)
            {
                if (!_running || _targetGraphics == null || _target == null) return;
                EnsureSourceBitmap(sourceWidth, sourceHeight);
                CopyToSourceBitmap(software, sourceWidth, sourceHeight);
                var output = _sourceBitmap.Width == Width && _sourceBitmap.Height == Height ? _sourceBitmap : _target;
                if (!ReferenceEquals(output, _sourceBitmap)) _targetGraphics.DrawImage(_sourceBitmap, 0, 0, Width, Height);
                var data = output.LockBits(new Rectangle(0, 0, Width, Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try
                {
                    var stride = Math.Abs(data.Stride);
                    var bytes = new byte[stride * Height];
                    Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
                    _onFrame(new RawVideoFrame
                    {
                        Data = bytes,
                        Width = Width,
                        Height = Height,
                        Stride = stride,
                        Sequence = _sequence++,
                        TimestampUs = (long)(_clock.Elapsed.TotalMilliseconds * 1000),
                    });
                }
                finally { output.UnlockBits(data); }
            }
        }

        private void EnsureSourceBitmap(int width, int height)
        {
            lock (_gate)
            {
                if (_sourceBitmap != null && _sourceBitmap.Width == width && _sourceBitmap.Height == height) return;
                _sourceBitmap?.Dispose();
                _sourceBitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            }
        }

        private void CopyToSourceBitmap(SoftwareBitmap software, int width, int height)
        {
            using (var buffer = software.LockBuffer(BitmapBufferAccessMode.Read))
            using (var reference = buffer.CreateReference())
            {
                ((IMemoryBufferByteAccess)reference).GetBuffer(out var source, out _);
                var plane = buffer.GetPlaneDescription(0);
                Bitmap bitmap;
                lock (_gate) { bitmap = _sourceBitmap; }
                if (bitmap == null) return;
                var locked = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                try
                {
                    var sourceStride = Math.Abs(plane.Stride);
                    var targetStride = Math.Abs(locked.Stride);
                    var rowBytes = Math.Min(sourceStride, targetStride);
                    var step = locked.Stride < 0 ? -1 : 1;
                    for (var y = 0; y < height; y++)
                    {
                        var sourceRow = IntPtr.Add(source, plane.StartIndex + y * plane.Stride);
                        var targetRow = IntPtr.Add(locked.Scan0, (step > 0 ? y : height - 1 - y) * targetStride);
                        CopyMemory(targetRow, sourceRow, (UIntPtr)rowBytes);
                    }
                }
                finally { bitmap.UnlockBits(locked); }
            }
        }

        private void Watchdog(object state)
        {
            if (!_running || _source.Kind != "window") return;
            var hwnd = new IntPtr(_source.Hwnd);
            if (!Win32.IsWindow(hwnd) || Win32.IsIconic(hwnd))
            {
                End("VIDEO_ENDED", "窗口已关闭或最小化，共享已停止。");
            }
        }

        private void End(string code, string message)
        {
            if (Interlocked.Exchange(ref _ended, 1) != 0) return;
            try { _onEnded(new VideoEndedInfo { Code = code, Message = message }); }
            catch (Exception exception) { Log.Write("WGC end callback failed: " + exception.Message); }
        }

        public void Stop()
        {
            _running = false;
            var watchdog = Interlocked.Exchange(ref _watchdog, null);
            watchdog?.Dispose();
            var pool = Interlocked.Exchange(ref _framePool, null);
            if (pool != null)
            {
                try { pool.FrameArrived -= OnFrameArrived; } catch { }
                try { pool.Dispose(); } catch { }
            }
            var session = Interlocked.Exchange(ref _session, null);
            try { session?.Dispose(); } catch { }
            lock (_gate)
            {
                _targetGraphics?.Dispose();
                _targetGraphics = null;
                _target?.Dispose();
                _target = null;
                _sourceBitmap?.Dispose();
                _sourceBitmap = null;
            }
            _item = null;
            _device = null;
        }
    }
}
