using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Vortice;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;

namespace PiikRTC
{
    internal sealed class RawVideoFrame
    {
        public byte[] Data;
        public int Length;
        public int Width;
        public int Height;
        public int Stride;
        public long Sequence;
        public long TimestampUs;
        public Action Release;
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

        [ComImport]
        [Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IDirect3DDxgiInterfaceAccess
        {
            [PreserveSig] int GetInterface(ref Guid iid, out IntPtr ppvObject);
        }

        private const int D3D_DRIVER_TYPE_HARDWARE = 1;
        private const int D3D_DRIVER_TYPE_WARP = 5;
        private const uint D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
        private const uint D3D11_SDK_VERSION = 7;
        private const uint MONITOR_DEFAULTTONEAREST = 2;
        private static readonly Guid DxgiDeviceGuid = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
        private static readonly Guid GraphicsCaptureItemGuid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
        private static readonly Guid DxgiInterfaceAccessGuid = new Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1");
        private static readonly Guid Texture2DGuid = new Guid("6F15AAF2-D208-4E89-9AB4-489535D34F9C");

        private readonly DesktopSource _source;
        private readonly int _requestedWidth;
        private readonly int _requestedHeight;
        private readonly int _fps;
        private readonly Action<RawVideoFrame> _onFrame;
        private readonly Action<VideoEndedInfo> _onEnded;
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private readonly object _gate = new object();
        private readonly object _poolGate = new object();
        private readonly object _frameGate = new object();
        private readonly object _d3dGate = new object();
        private readonly object _stagingGate = new object();
        private readonly List<ID3D11Texture2D> _stagingTextures = new List<ID3D11Texture2D>();
        private readonly Queue<byte[]> _frameBuffers = new Queue<byte[]>();
        private BlockingCollection<Direct3D11CaptureFrame> _frameQueue;
        private Task[] _workers;
        private ID3D11Device _d3dDevice;
        private ID3D11DeviceContext _d3dContext;
        private ID3D11VideoDevice _videoDevice;
        private ID3D11VideoContext _videoContext;
        private ID3D11VideoProcessorEnumerator _videoEnumerator;
        private ID3D11VideoProcessor _videoProcessor;
        private ID3D11Texture2D _scaleTexture;
        private ID3D11VideoProcessorOutputView _scaleOutputView;
        private ID3D11Texture2D _inputTexture;
        private int _inputTextureWidth;
        private int _inputTextureHeight;
        private int _videoInputWidth;
        private int _videoInputHeight;
        private int _scaleLogged;
        private int _scaleUnsupported;
        private int _scaleErrorLogged;
        private int _inputCopyRequired;
        private int _bufferLength;
        private bool _disposed;
        private volatile bool _running;
        private int _ended;
        private long _sequence;
        private long _lastFrameTicks;
        private long _framesArrived;
        private long _framesEmitted;
        private long _framesPaceDropped;
        private long _framesQueueDropped;
        private int _d3dActiveLogged;
        private int _d3dFallbackLogged;
        private System.Threading.Timer _stats;
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
                _device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 6, _poolSize);
            _framePool.FrameArrived += OnFrameArrived;
            _session = _framePool.CreateCaptureSession(_item);
            _session.IsCursorCaptureEnabled = false;
            try { _session.IsBorderRequired = false; } catch { /* older Windows versions always draw the border */ }
            _frameQueue = new BlockingCollection<Direct3D11CaptureFrame>(new ConcurrentQueue<Direct3D11CaptureFrame>(), 8);
            var queue = _frameQueue;
            _workers = new[] { Task.Run(() => WorkerLoop(queue)), Task.Run(() => WorkerLoop(queue)) };
            _running = true;
            _session.StartCapture();
            _watchdog = new System.Threading.Timer(Watchdog, null, 500, 500);
            _stats = new System.Threading.Timer(LogStats, null, 2000, 2000);
        }

        private IDirect3DDevice CreateDevice()
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
                        try
                        {
                            var result = (IDirect3DDevice)Marshal.GetObjectForIUnknown(inspectable);
                            // The Vortice wrappers own the device/context references
                            // returned by D3D11CreateDevice.
                            _d3dDevice = new ID3D11Device(devicePtr);
                            _d3dContext = new ID3D11DeviceContext(contextPtr);
                            try
                            {
                                _videoDevice = _d3dDevice.QueryInterface<ID3D11VideoDevice>();
                                _videoContext = _d3dContext.QueryInterface<ID3D11VideoContext>();
                            }
                            catch (Exception exception)
                            {
                                _videoDevice = null;
                                _videoContext = null;
                                Log.Write("D3D video processor unavailable: " + exception.Message);
                            }
                            return result;
                        }
                        finally { Marshal.Release(inspectable); }
                    }
                    finally { Marshal.Release(dxgiDevice); }
                }
                catch
                {
                    if (contextPtr != IntPtr.Zero) Marshal.Release(contextPtr);
                    Marshal.Release(devicePtr);
                    throw;
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
            _targetGraphics.InterpolationMode = _fps >= 50 ? InterpolationMode.Bilinear : InterpolationMode.HighQualityBilinear;
            _targetGraphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            _targetGraphics.SmoothingMode = SmoothingMode.HighQuality;
            _bufferLength = Width * 4 * Height;
            for (var index = 0; index < 4; index++) _frameBuffers.Enqueue(new byte[_bufferLength]);
        }

        private byte[] RentBuffer(int length)
        {
            lock (_poolGate)
            {
                if (_disposed) return null;
                while (_frameBuffers.Count > 0)
                {
                    var buffer = _frameBuffers.Dequeue();
                    if (buffer.Length >= length) return buffer;
                }
                return null;
            }
        }

        private void ReturnBuffer(byte[] buffer)
        {
            if (buffer == null) return;
            lock (_poolGate)
            {
                if (!_disposed && buffer.Length >= _bufferLength) _frameBuffers.Enqueue(buffer);
            }
        }

        private static int Even(int value)
        {
            return Math.Max(2, value - (value % 2));
        }

        private void OnFrameArrived(Direct3D11CaptureFramePool sender, object args)
        {
            if (!_running) return;
            Direct3D11CaptureFrame frame = null;
            try
            {
                lock (_frameGate)
                {
                    frame = sender.TryGetNextFrame();
                    if (frame == null) return;
                    Interlocked.Increment(ref _framesArrived);
                    var size = frame.ContentSize;
                    if (size.Width <= 1 || size.Height <= 1) return;
                    if (size.Width != _poolSize.Width || size.Height != _poolSize.Height)
                    {
                        _poolSize = size;
                        sender.Recreate(_device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 6, size);
                        return;
                    }
                    var interval = Stopwatch.Frequency / (double)_fps;
                    var now = _clock.ElapsedTicks;
                    // WGC often delivers a 60Hz frame a few milliseconds early.
                    // Dropping it because it is 1-2ms inside the interval makes
                    // the next frame wait a whole interval, which collapses the
                    // emitted rate to ~40fps. Allow a small early window and
                    // keep the requested cadence instead.
                    if (_lastFrameTicks != 0 && now - _lastFrameTicks < interval * 0.8)
                    {
                        Interlocked.Increment(ref _framesPaceDropped);
                        return;
                    }
                    _lastFrameTicks = now;
                    var queue = _frameQueue;
                    if (queue != null && !queue.IsAddingCompleted && queue.TryAdd(frame))
                    {
                        frame = null;
                        return;
                    }
                    Interlocked.Increment(ref _framesQueueDropped);
                }
            }
            catch (Exception exception)
            {
                if (!_running) return;
                Log.Write("WGC frame failed: " + exception);
                End("VIDEO_FAILED", "硬件画面采集失败：" + exception.Message);
            }
            finally { frame?.Dispose(); }
        }

        private void WorkerLoop(BlockingCollection<Direct3D11CaptureFrame> queue)
        {
            try
            {
                foreach (var frame in queue.GetConsumingEnumerable())
                {
                    try
                    {
                        using (frame)
                        {
                            if (TryEmitD3D(frame)) continue;
                            if (!_running) continue;
                            using (var software = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface, BitmapAlphaMode.Ignore)
                                .AsTask().GetAwaiter().GetResult())
                            {
                                if (_running) Emit(software);
                            }
                        }
                    }
                    catch (Exception exception)
                    {
                        if (_running) Log.Write("WGC copy failed: " + exception.Message);
                    }
                }
            }
            catch (Exception exception)
            {
                if (_running) Log.Write("WGC worker stopped: " + exception.Message);
            }
        }

        private bool TryEmitD3D(Direct3D11CaptureFrame frame)
        {
            var context = _d3dContext;
            if (context == null || _d3dDevice == null) return D3DFallback("no device");
            var texture = GetTexture(frame.Surface);
            if (texture == null) return D3DFallback("surface access");
            try
            {
                var desc = texture.Description;
                var bgra = desc.Format == Format.B8G8R8A8_UNorm || desc.Format == Format.B8G8R8A8_UNorm_SRgb;
                if (!bgra)
                    return D3DFallback($"format frame={desc.Width}x{desc.Height}/{desc.Format}");
                if (desc.Width != Width || desc.Height != Height)
                {
                    if (desc.Format != Format.B8G8R8A8_UNorm)
                        return D3DFallback($"scale format frame={desc.Width}x{desc.Height}/{desc.Format}");
                    if (!TryEmitScaledD3D(texture, desc))
                        return D3DFallback($"size/scale frame={desc.Width}x{desc.Height} target={Width}x{Height}");
                    return true;
                }
                var staging = RentStaging(desc.Width, desc.Height, desc.Format);
                if (staging == null) return D3DFallback("staging create");
                try
                {
                    lock (_d3dGate)
                    {
                        context.CopyResource(staging, texture);
                        var mapped = context.Map(staging, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
                        try
                        {
                            if (!_running) return false;
                            lock (_gate)
                            {
                                if (!_running) return false;
                                EmitMapped(mapped.DataPointer, mapped.RowPitch);
                            }
                        }
                        finally { context.Unmap(staging, 0); }
                    }
                    if (Interlocked.Exchange(ref _d3dActiveLogged, 1) == 0) Log.Write("D3D staging readback active");
                    return true;
                }
                finally { ReturnStaging(staging); }
            }
            finally { texture.Dispose(); }
        }

        // The WGC frame is larger than the negotiated 1080p size. Let the GPU
        // video processor scale it into a same-size render target, so the
        // staging readback stays 1080p and GDI+ never touches the frame.
        private bool TryEmitScaledD3D(ID3D11Texture2D texture, Texture2DDescription desc)
        {
            var context = _d3dContext;
            if (context == null || _videoDevice == null || _videoContext == null) return false;
            ID3D11VideoProcessorInputView input = null;
            ID3D11Texture2D staging = null;
            lock (_d3dGate)
            {
                try
                {
                    if (!EnsureVideoProcessor(desc.Width, desc.Height)) return false;
                    var inputDesc = new VideoProcessorInputViewDescription
                    {
                        FourCC = 0,
                        ViewDimension = VideoProcessorInputViewDimension.Texture2D,
                        Texture2D = new Texture2DVideoProcessorInputView { MipSlice = 0, ArraySlice = 0 },
                    };
                    if (_inputCopyRequired == 0)
                    {
                        try { input = _videoDevice.CreateVideoProcessorInputView(texture, _videoEnumerator, inputDesc); }
                        catch { Interlocked.Exchange(ref _inputCopyRequired, 1); }
                    }
                    if (input == null)
                    {
                        EnsureInputTexture(desc.Width, desc.Height);
                        context.CopyResource(_inputTexture, texture);
                        input = _videoDevice.CreateVideoProcessorInputView(_inputTexture, _videoEnumerator, inputDesc);
                    }
                    _videoContext.VideoProcessorSetStreamSourceRect(_videoProcessor, 0, true, new RawRect(0, 0, desc.Width, desc.Height));
                    _videoContext.VideoProcessorSetStreamDestRect(_videoProcessor, 0, true, new RawRect(0, 0, Width, Height));
                    var stream = new VideoProcessorStream { Enable = true, OutputIndex = 0, InputFrameOrField = 0, InputSurface = input };
                    _videoContext.VideoProcessorBlt(_videoProcessor, _scaleOutputView, 0, 1, new[] { stream });
                    staging = RentStaging(Width, Height, Format.B8G8R8A8_UNorm);
                    if (staging == null) return false;
                    context.CopyResource(staging, _scaleTexture);
                    var mapped = context.Map(staging, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
                    try
                    {
                        if (!_running) return false;
                        lock (_gate)
                        {
                            if (!_running) return false;
                            EmitMapped(mapped.DataPointer, mapped.RowPitch);
                        }
                    }
                    finally { context.Unmap(staging, 0); }
                    if (Interlocked.Exchange(ref _scaleLogged, 1) == 0)
                        Log.Write("D3D video processor scaling active: " + desc.Width + "x" + desc.Height + " -> " + Width + "x" + Height);
                    return true;
                }
                catch (Exception exception)
                {
                    if (Interlocked.Exchange(ref _scaleErrorLogged, 1) == 0)
                        Log.Write("D3D video processor failed: " + exception.Message);
                    return false;
                }
                finally
                {
                    if (input != null) { try { input.Dispose(); } catch { } }
                    if (staging != null) ReturnStaging(staging);
                }
            }
        }

        private bool EnsureVideoProcessor(int inputWidth, int inputHeight)
        {
            if (_scaleUnsupported != 0) return false;
            if (_videoProcessor != null && _scaleTexture != null && _scaleOutputView != null
                && _videoInputWidth == inputWidth && _videoInputHeight == inputHeight) return true;
            DisposeVideoProcessor();
            if (_videoDevice == null || _videoContext == null || _d3dDevice == null) return false;
            var content = new VideoProcessorContentDescription
            {
                InputFrameFormat = VideoFrameFormat.Progressive,
                InputFrameRate = new Rational(_fps, 1),
                InputWidth = inputWidth,
                InputHeight = inputHeight,
                OutputFrameRate = new Rational(_fps, 1),
                OutputWidth = Width,
                OutputHeight = Height,
                Usage = VideoUsage.PlaybackNormal,
            };
            _videoEnumerator = _videoDevice.CreateVideoProcessorEnumerator(content);
            var support = _videoEnumerator.CheckVideoProcessorFormat(Format.B8G8R8A8_UNorm);
            if ((support & VideoProcessorFormatSupport.Input) == 0 || (support & VideoProcessorFormatSupport.Output) == 0)
            {
                if (Interlocked.Exchange(ref _scaleUnsupported, 1) == 0)
                    Log.Write("D3D video processor does not support BGRA scaling: " + support);
                DisposeVideoProcessor();
                return false;
            }
            _videoProcessor = _videoDevice.CreateVideoProcessor(_videoEnumerator, 0);
            _scaleTexture = _d3dDevice.CreateTexture2D(new Texture2DDescription
            {
                Width = Width, Height = Height, MipLevels = 1, ArraySize = 1,
                Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Default, BindFlags = BindFlags.RenderTarget | BindFlags.ShaderResource,
            });
            var outputDesc = new VideoProcessorOutputViewDescription
            {
                ViewDimension = VideoProcessorOutputViewDimension.Texture2D,
                Texture2D = new Texture2DVideoProcessorOutputView { MipSlice = 0 },
            };
            _scaleOutputView = _videoDevice.CreateVideoProcessorOutputView(_scaleTexture, _videoEnumerator, outputDesc);
            _videoInputWidth = inputWidth;
            _videoInputHeight = inputHeight;
            return true;
        }

        private void EnsureInputTexture(int width, int height)
        {
            if (_inputTexture != null && _inputTextureWidth == width && _inputTextureHeight == height) return;
            try { _inputTexture?.Dispose(); } catch { }
            _inputTexture = _d3dDevice.CreateTexture2D(new Texture2DDescription
            {
                Width = width, Height = height, MipLevels = 1, ArraySize = 1,
                Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Default, BindFlags = BindFlags.ShaderResource | BindFlags.RenderTarget,
            });
            _inputTextureWidth = width;
            _inputTextureHeight = height;
        }

        private void DisposeVideoProcessor()
        {
            try { _scaleOutputView?.Dispose(); } catch { }
            _scaleOutputView = null;
            try { _scaleTexture?.Dispose(); } catch { }
            _scaleTexture = null;
            try { _inputTexture?.Dispose(); } catch { }
            _inputTexture = null;
            _inputTextureWidth = 0;
            _inputTextureHeight = 0;
            try { _videoProcessor?.Dispose(); } catch { }
            _videoProcessor = null;
            try { _videoEnumerator?.Dispose(); } catch { }
            _videoEnumerator = null;
            _videoInputWidth = 0;
            _videoInputHeight = 0;
        }

        private bool D3DFallback(string reason)
        {
            if (Interlocked.Exchange(ref _d3dFallbackLogged, 1) == 0) Log.Write("D3D readback fallback: " + reason);
            return false;
        }

        private static ID3D11Texture2D GetTexture(IDirect3DSurface surface)
        {
            if (surface == null) return null;
            IntPtr unknown = IntPtr.Zero, accessPtr = IntPtr.Zero, texturePtr = IntPtr.Zero;
            try
            {
                unknown = Marshal.GetIUnknownForObject(surface);
                var accessIid = DxgiInterfaceAccessGuid;
                if (Marshal.QueryInterface(unknown, ref accessIid, out accessPtr) < 0 || accessPtr == IntPtr.Zero) return null;
                var access = (IDirect3DDxgiInterfaceAccess)Marshal.GetObjectForIUnknown(accessPtr);
                var textureIid = Texture2DGuid;
                if (access.GetInterface(ref textureIid, out texturePtr) < 0 || texturePtr == IntPtr.Zero) return null;
                var texture = new ID3D11Texture2D(texturePtr);
                texturePtr = IntPtr.Zero;
                return texture;
            }
            catch { return null; }
            finally
            {
                if (unknown != IntPtr.Zero) Marshal.Release(unknown);
                if (accessPtr != IntPtr.Zero) Marshal.Release(accessPtr);
                if (texturePtr != IntPtr.Zero) Marshal.Release(texturePtr);
            }
        }

        private ID3D11Texture2D RentStaging(int width, int height, Format format)
        {
            lock (_stagingGate)
            {
                for (var index = _stagingTextures.Count - 1; index >= 0; index--)
                {
                    var texture = _stagingTextures[index];
                    var desc = texture.Description;
                    if (desc.Width == width && desc.Height == height && desc.Format == format)
                    {
                        _stagingTextures.RemoveAt(index);
                        return texture;
                    }
                }
            }
            var device = _d3dDevice;
            if (device == null) return null;
            var stagingDesc = new Texture2DDescription
            {
                Width = width, Height = height, MipLevels = 1, ArraySize = 1, Format = format,
                SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Staging,
                BindFlags = BindFlags.None, CPUAccessFlags = CpuAccessFlags.Read, MiscFlags = ResourceOptionFlags.None,
            };
            try { return device.CreateTexture2D(stagingDesc, null); }
            catch (Exception exception)
            {
                Log.Write("staging texture create failed: " + exception.Message);
                return null;
            }
        }

        private void ReturnStaging(ID3D11Texture2D texture)
        {
            if (texture == null) return;
            lock (_stagingGate)
            {
                if (!_disposed && _stagingTextures.Count < 4)
                {
                    _stagingTextures.Add(texture);
                    return;
                }
            }
            try { texture.Dispose(); } catch { /* already disposed */ }
        }

        private void Emit(SoftwareBitmap software)
        {
            var sourceWidth = software.PixelWidth;
            var sourceHeight = software.PixelHeight;
            if (sourceWidth <= 0 || sourceHeight <= 0) return;
            lock (_gate)
            {
                if (!_running || _targetGraphics == null || _target == null) return;
                if (sourceWidth == Width && sourceHeight == Height)
                {
                    EmitDirect(software);
                    return;
                }
                EnsureSourceBitmap(sourceWidth, sourceHeight);
                CopyToSourceBitmap(software, sourceWidth, sourceHeight);
                var output = _sourceBitmap.Width == Width && _sourceBitmap.Height == Height ? _sourceBitmap : _target;
                if (!ReferenceEquals(output, _sourceBitmap)) _targetGraphics.DrawImage(_sourceBitmap, 0, 0, Width, Height);
                var data = output.LockBits(new Rectangle(0, 0, Width, Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try
                {
                    var stride = Math.Abs(data.Stride);
                    var length = stride * Height;
                    var bytes = RentBuffer(length);
                    if (bytes == null) return;
                    Marshal.Copy(data.Scan0, bytes, 0, length);
                    Interlocked.Increment(ref _framesEmitted);
                    try
                    {
                        _onFrame(new RawVideoFrame
                        {
                            Data = bytes,
                            Length = length,
                            Width = Width,
                            Height = Height,
                            Stride = stride,
                            Sequence = _sequence++,
                            TimestampUs = (long)(_clock.Elapsed.TotalMilliseconds * 1000),
                            Release = () => ReturnBuffer(bytes),
                        });
                    }
                    catch
                    {
                        ReturnBuffer(bytes);
                        throw;
                    }
                }
                finally { output.UnlockBits(data); }
            }
        }

        // The common window capture path has no scaling. Read the WGC
        // SoftwareBitmap rows directly into the shared frame buffer instead of
        // SoftwareBitmap -> GDI+ Bitmap -> byte[], which halves the CPU copies
        // and is what keeps 1080p near 30fps.
        private void EmitDirect(SoftwareBitmap software)
        {
            var stride = Width * 4;
            var length = stride * Height;
            var bytes = RentBuffer(length);
            if (bytes == null) return;
            try
            {
                using (var buffer = software.LockBuffer(BitmapBufferAccessMode.Read))
                using (var reference = buffer.CreateReference())
                {
                    ((IMemoryBufferByteAccess)reference).GetBuffer(out var source, out _);
                    var plane = buffer.GetPlaneDescription(0);
                    var sourceStride = Math.Abs(plane.Stride);
                    if (sourceStride < stride)
                    {
                        ReturnBuffer(bytes);
                        return;
                    }
                    var handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
                    try
                    {
                        var target = handle.AddrOfPinnedObject();
                        if (sourceStride == stride)
                        {
                            CopyMemory(target, IntPtr.Add(source, plane.StartIndex), (UIntPtr)length);
                        }
                        else
                        {
                            for (var y = 0; y < Height; y++)
                            {
                                var sourceRow = IntPtr.Add(source, plane.StartIndex + y * plane.Stride);
                                CopyMemory(IntPtr.Add(target, y * stride), sourceRow, (UIntPtr)stride);
                            }
                        }
                    }
                    finally { handle.Free(); }
                }
                Interlocked.Increment(ref _framesEmitted);
                _onFrame(new RawVideoFrame
                {
                    Data = bytes,
                    Length = length,
                    Width = Width,
                    Height = Height,
                    Stride = stride,
                    Sequence = _sequence++,
                    TimestampUs = (long)(_clock.Elapsed.TotalMilliseconds * 1000),
                    Release = () => ReturnBuffer(bytes),
                });
            }
            catch
            {
                ReturnBuffer(bytes);
                throw;
            }
        }

        private void EmitMapped(IntPtr source, int sourceStride)
        {
            var stride = Width * 4;
            var length = stride * Height;
            var bytes = RentBuffer(length);
            if (bytes == null) return;
            try
            {
                if (sourceStride < stride) throw new InvalidOperationException("staging row pitch is smaller than the frame width.");
                var handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
                try
                {
                    var target = handle.AddrOfPinnedObject();
                    if (sourceStride == stride)
                    {
                        CopyMemory(target, source, (UIntPtr)length);
                    }
                    else
                    {
                        for (var y = 0; y < Height; y++)
                            CopyMemory(IntPtr.Add(target, y * stride), IntPtr.Add(source, y * sourceStride), (UIntPtr)stride);
                    }
                }
                finally { handle.Free(); }
                Interlocked.Increment(ref _framesEmitted);
                _onFrame(new RawVideoFrame
                {
                    Data = bytes,
                    Length = length,
                    Width = Width,
                    Height = Height,
                    Stride = stride,
                    Sequence = _sequence++,
                    TimestampUs = (long)(_clock.Elapsed.TotalMilliseconds * 1000),
                    Release = () => ReturnBuffer(bytes),
                });
            }
            catch
            {
                ReturnBuffer(bytes);
                throw;
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

        private void LogStats(object state)
        {
            if (!_running) return;
            var arrived = Interlocked.Exchange(ref _framesArrived, 0);
            var emitted = Interlocked.Exchange(ref _framesEmitted, 0);
            var dropped = Interlocked.Exchange(ref _framesPaceDropped, 0);
            var queued = Interlocked.Exchange(ref _framesQueueDropped, 0);
            if (arrived == 0 && emitted == 0 && dropped == 0 && queued == 0) return;
            Log.Write($"WGC fps arrived={arrived / 2.0:F1} emitted={emitted / 2.0:F1} paceDrop={dropped / 2.0:F1} queueDrop={queued / 2.0:F1}");
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
            var stats = Interlocked.Exchange(ref _stats, null);
            stats?.Dispose();
            var queue = Interlocked.Exchange(ref _frameQueue, null);
            if (queue != null)
            {
                try { queue.CompleteAdding(); } catch { }
                Direct3D11CaptureFrame pending;
                while (queue.TryTake(out pending))
                {
                    try { pending.Dispose(); } catch { }
                }
            }
            Interlocked.Exchange(ref _workers, null);
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
            lock (_poolGate)
            {
                _disposed = true;
                _frameBuffers.Clear();
            }
            lock (_stagingGate)
            {
                foreach (var texture in _stagingTextures)
                {
                    try { texture.Dispose(); } catch { }
                }
                _stagingTextures.Clear();
            }
            lock (_d3dGate) { DisposeVideoProcessor(); }
            var videoContext = _videoContext;
            var videoDevice = _videoDevice;
            _videoContext = null;
            _videoDevice = null;
            try { videoContext?.Dispose(); } catch { }
            try { videoDevice?.Dispose(); } catch { }
            var d3dContext = _d3dContext;
            var d3dDevice = _d3dDevice;
            _d3dContext = null;
            _d3dDevice = null;
            try { d3dContext?.Dispose(); } catch { }
            try { d3dDevice?.Dispose(); } catch { }
            _item = null;
            _device = null;
        }
    }
}
