using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PiikAudio;

internal enum CaptureMode
{
    System,
    Include,
    Exclude,
}

internal sealed record CaptureFormat(uint SampleRate, ushort Channels, ushort Bits, bool IsFloat, ushort BlockAlign)
{
    public string Encoding => IsFloat ? "pcm_f32le" : Bits switch
    {
        16 => "pcm_s16le",
        32 => "pcm_s32le",
        _ => "unsupported",
    };

    public bool IsSupported => (Channels is 1 or 2) && (IsFloat || Bits is 16 or 32);
}

internal sealed class AudioCaptureException : Exception
{
    public string Code { get; }

    public AudioCaptureException(string code, string message, Exception? inner = null) : base(message, inner)
    {
        Code = code;
    }
}

internal sealed class AudioCaptureSession : IDisposable
{
    private const uint ClsctxAll = 0x17;
    private const uint WaitMilliseconds = 500;
    private const int HnsBufferDuration = 200_000;

    private readonly IAudioClient _client;
    private readonly IAudioCaptureClient _capture;
    private readonly IntPtr _event;
    private bool _started;
    private bool _disposed;

    public CaptureFormat Format { get; }

    private AudioCaptureSession(IAudioClient client, IAudioCaptureClient capture, IntPtr readyEvent, CaptureFormat format)
    {
        _client = client;
        _capture = capture;
        _event = readyEvent;
        Format = format;
    }

    public static bool ProcessLoopbackSupported => Environment.OSVersion.Version.Build >= 19041;

    private readonly record struct Attempt(uint Rate, ushort Bits, bool MixFormat, bool AutoConvert);

    public static AudioCaptureSession Create(CaptureMode mode, int processId)
    {
        if (mode != CaptureMode.System && !ProcessLoopbackSupported)
        {
            throw new AudioCaptureException("PROCESS_LOOPBACK_UNSUPPORTED",
                "当前 Windows 版本不支持程序级音频采集，需要 Windows 10 2004（19041）或更高版本。");
        }
        if (mode != CaptureMode.System && processId <= 0)
        {
            throw new AudioCaptureException("BAD_ARGS", "缺少要采集的程序进程号。");
        }
        if (mode != CaptureMode.System && !ProcessExists(processId))
        {
            throw new AudioCaptureException("PROCESS_NOT_FOUND", "要采集的程序已经退出，请重新选择。");
        }

        var attempts = mode == CaptureMode.System
            ? new[]
            {
                new Attempt(48000, 16, false, true),
                new Attempt(44100, 16, false, false),
                new Attempt(0, 0, true, false),
            }
            : new[]
            {
                new Attempt(48000, 16, false, false),
                new Attempt(44100, 16, false, false),
            };

        AudioCaptureException? lastFormatError = null;
        foreach (var attempt in attempts)
        {
            IAudioClient client = mode == CaptureMode.System
                ? ActivateSystemClient()
                : ActivateProcessClient(processId, mode == CaptureMode.Include);
            IntPtr readyEvent = IntPtr.Zero;
            var keepClient = false;
            try
            {
                var flags = NativeMethods.AudclntStreamflagsLoopback | NativeMethods.AudclntStreamflagsEventcallback;
                if (attempt.AutoConvert)
                {
                    flags |= NativeMethods.AudclntStreamflagsAutoconvertpcm | NativeMethods.AudclntStreamflagsSrcDefaultQuality;
                }

                CaptureFormat? format = attempt.MixFormat
                    ? TryInitializeMixFormat(client, flags, out lastFormatError)
                    : TryInitializeFormat(client, attempt.Rate, attempt.Bits, flags, out lastFormatError);
                if (format is null) continue;

                readyEvent = NativeMethods.CreateEvent(IntPtr.Zero, false, false, null);
                if (readyEvent == IntPtr.Zero)
                {
                    throw new AudioCaptureException("STREAM_FAILED", "无法创建音频事件。");
                }

                var hr = client.SetEventHandle(readyEvent);
                if (hr < 0)
                {
                    throw Error("STREAM_FAILED", "无法注册音频事件。", hr);
                }

                var iid = NativeMethods.IidIAudioCaptureClient;
                hr = client.GetService(ref iid, out var service);
                if (hr < 0)
                {
                    throw Error("STREAM_FAILED", "无法获取音频采集接口。", hr);
                }

                var session = new AudioCaptureSession(client, (IAudioCaptureClient)service, readyEvent, format);
                readyEvent = IntPtr.Zero;
                keepClient = true;
                return session;
            }
            catch (AudioCaptureException exception)
            {
                lastFormatError = exception;
            }
            finally
            {
                if (readyEvent != IntPtr.Zero) NativeMethods.CloseHandle(readyEvent);
                if (!keepClient)
                {
                    Marshal.ReleaseComObject(client);
                }
            }
        }

        throw lastFormatError ?? new AudioCaptureException("UNSUPPORTED_FORMAT", "无法初始化音频采集。");
    }

    private static bool ProcessExists(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return !process.HasExited;
        }
        catch
        {
            return false;
        }
    }

    public void Start()
    {
        var hr = _client.Start();
        if (hr < 0)
        {
            throw Error("STREAM_FAILED", "无法开始音频采集。", hr);
        }
        _started = true;
    }

    public void Pump(Stream output, CancellationToken token)
    {
        var zeros = new byte[8192];
        try
        {
            while (!token.IsCancellationRequested)
            {
                var wait = NativeMethods.WaitForSingleObject(_event, WaitMilliseconds);
                if (wait == NativeMethods.WaitFailed)
                {
                    throw new AudioCaptureException("STREAM_FAILED", "等待音频数据失败。");
                }
                if (wait != NativeMethods.WaitObject0) continue;

                while (!token.IsCancellationRequested)
                {
                    var hr = _capture.GetNextPacketSize(out var frames);
                    if (hr < 0)
                    {
                        throw Error("DEVICE_LOST", "音频设备连接已断开。", hr);
                    }
                    if (frames == 0) break;

                    hr = _capture.GetBuffer(out var data, out var framesRead, out var flags, out _, out _);
                    if (hr < 0)
                    {
                        if ((uint)hr == 0x08890001) break; // AUDCLNT_S_BUFFER_EMPTY
                        throw Error("DEVICE_LOST", "读取音频数据失败。", hr);
                    }

                    try
                    {
                        var bytes = (int)framesRead * Format.BlockAlign;
                        if (bytes <= 0) continue;
                        if ((flags & NativeMethods.AudclntBufferflagsSilent) != 0)
                        {
                            WriteZeros(output, zeros, bytes);
                        }
                        else
                        {
                            unsafe
                            {
                                output.Write(new ReadOnlySpan<byte>((void*)data, bytes));
                            }
                        }
                        output.Flush();
                    }
                    finally
                    {
                        _capture.ReleaseBuffer(framesRead);
                    }
                }
            }
        }
        catch (IOException)
        {
            // The desktop host closed our pipe; nothing left to do.
        }
    }

    private static void WriteZeros(Stream output, byte[] zeros, int count)
    {
        while (count > 0)
        {
            var chunk = Math.Min(count, zeros.Length);
            output.Write(zeros, 0, chunk);
            count -= chunk;
        }
    }

    private static IAudioClient ActivateSystemClient()
    {
        object? enumeratorObject = null;
        object? deviceObject = null;
        try
        {
            var enumeratorType = Type.GetTypeFromCLSID(NativeMethods.ClsidMMDeviceEnumerator)
                ?? throw new AudioCaptureException("NO_AUDIO_DEVICE", "无法初始化音频设备枚举器。");
            enumeratorObject = Activator.CreateInstance(enumeratorType);
            if (enumeratorObject is not IMMDeviceEnumerator enumerator)
            {
                throw new AudioCaptureException("NO_AUDIO_DEVICE", "无法初始化音频设备枚举器。");
            }

            var hr = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Console, out var device);
            if (hr < 0)
            {
                throw Error("NO_AUDIO_DEVICE", "没有找到可用的播放设备。", hr);
            }
            deviceObject = device;

            var iid = NativeMethods.IidIAudioClient;
            hr = device.Activate(ref iid, ClsctxAll, IntPtr.Zero, out var instance);
            if (hr < 0)
            {
                throw Error("NO_AUDIO_DEVICE", "无法打开播放设备。", hr);
            }
            return (IAudioClient)instance;
        }
        finally
        {
            if (deviceObject is not null) Marshal.ReleaseComObject(deviceObject);
            if (enumeratorObject is not null) Marshal.ReleaseComObject(enumeratorObject);
        }
    }

    private static IAudioClient ActivateProcessClient(int processId, bool includeTree)
    {
        var activation = new AudioClientActivationParams
        {
            ActivationType = NativeMethods.AudclntActivationTypeProcessLoopback,
            ProcessLoopbackParams = new AudioClientProcessLoopbackParams
            {
                TargetProcessId = processId,
                ProcessLoopbackMode = includeTree
                    ? NativeMethods.ProcessLoopbackModeIncludeTargetProcessTree
                    : NativeMethods.ProcessLoopbackModeExcludeTargetProcessTree,
            },
        };

        var paramsSize = Marshal.SizeOf<AudioClientActivationParams>();
        var paramsPointer = Marshal.AllocHGlobal(paramsSize);
        var variantPointer = Marshal.AllocHGlobal(Marshal.SizeOf<PropVariant>());
        try
        {
            Marshal.StructureToPtr(activation, paramsPointer, false);
            var variant = new PropVariant
            {
                VariantType = 65, // VT_BLOB
                BlobSize = (uint)paramsSize,
                BlobData = paramsPointer,
            };
            Marshal.StructureToPtr(variant, variantPointer, false);

            var handler = new ActivationHandler();
            var iid = NativeMethods.IidIAudioClient;
            var hr = NativeMethods.ActivateAudioInterfaceAsync(
                NativeMethods.VirtualAudioDeviceProcessLoopback,
                ref iid,
                variantPointer,
                handler,
                out var operation);

            if (hr < 0)
            {
                throw Error("ACTIVATION_FAILED", "无法启动程序音频采集。", hr);
            }

            try
            {
                if (!handler.Completed.Wait(TimeSpan.FromSeconds(15)))
                {
                    throw new AudioCaptureException("ACTIVATION_FAILED", "启动程序音频采集超时。");
                }
            }
            finally
            {
                if (operation is not null) Marshal.ReleaseComObject(operation);
            }

            if (handler.Error is not null)
            {
                throw new AudioCaptureException("ACTIVATION_FAILED", "启动程序音频采集失败。", handler.Error);
            }
            if (handler.HResult < 0)
            {
                throw Error("ACTIVATION_FAILED", "启动程序音频采集失败。", handler.HResult);
            }
            if (handler.Client is null)
            {
                throw new AudioCaptureException("ACTIVATION_FAILED", "程序音频采集没有返回音频接口。");
            }

            var client = handler.Client;
            GC.KeepAlive(handler);
            return client;
        }
        finally
        {
            Marshal.FreeHGlobal(variantPointer);
            Marshal.FreeHGlobal(paramsPointer);
        }
    }

    private static CaptureFormat? TryInitializeFormat(IAudioClient client, uint rate, ushort bits, uint flags, out AudioCaptureException? error)
    {
        var blockAlign = (ushort)(2 * bits / 8);
        var format = new WaveFormatEx
        {
            FormatTag = NativeMethods.WaveFormatPcm,
            Channels = 2,
            SamplesPerSecond = rate,
            BlockAlign = blockAlign,
            BitsPerSample = bits,
            AverageBytesPerSecond = rate * blockAlign,
            ExtraSize = 0,
        };
        var pointer = Marshal.AllocHGlobal(Marshal.SizeOf<WaveFormatEx>());
        try
        {
            Marshal.StructureToPtr(format, pointer, false);
            var hr = client.Initialize(AudioClientShareMode.Shared, flags, HnsBufferDuration, 0, pointer, IntPtr.Zero);
            if (hr < 0)
            {
                error = Error("UNSUPPORTED_FORMAT", $"当前音频设备不支持 {rate} Hz / 16 位音频采集。", hr);
                return null;
            }
            error = null;
            return new CaptureFormat(rate, 2, bits, false, blockAlign);
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static CaptureFormat? TryInitializeMixFormat(IAudioClient client, uint flags, out AudioCaptureException? error)
    {
        error = null;
        var hr = client.GetMixFormat(out var mixPointer);
        if (hr < 0)
        {
            error = Error("UNSUPPORTED_FORMAT", "无法读取音频设备格式。", hr);
            return null;
        }

        try
        {
            var format = Marshal.PtrToStructure<WaveFormatEx>(mixPointer);
            hr = client.Initialize(AudioClientShareMode.Shared, flags, HnsBufferDuration, 0, mixPointer, IntPtr.Zero);
            if (hr < 0)
            {
                error = Error("UNSUPPORTED_FORMAT", "无法初始化音频设备。", hr);
                return null;
            }

            var isFloat = format.FormatTag == NativeMethods.WaveFormatIeeeFloat;
            if (format.FormatTag == NativeMethods.WaveFormatExtensible)
            {
                isFloat = IsIeeeFloatSubFormat(mixPointer);
            }
            var blockAlign = format.BlockAlign != 0
                ? format.BlockAlign
                : (ushort)(format.Channels * format.BitsPerSample / 8);
            var captureFormat = new CaptureFormat(format.SamplesPerSecond, format.Channels, format.BitsPerSample, isFloat, blockAlign);
            if (!captureFormat.IsSupported)
            {
                error = new AudioCaptureException("UNSUPPORTED_FORMAT",
                    $"音频设备返回了不支持的格式（{format.Channels} 声道 / {format.BitsPerSample} 位）。");
                return null;
            }
            return captureFormat;
        }
        finally
        {
            Marshal.FreeCoTaskMem(mixPointer);
        }
    }

    private static bool IsIeeeFloatSubFormat(IntPtr format)
    {
        var guid = new byte[16];
        Marshal.Copy(IntPtr.Add(format, 24), guid, 0, guid.Length);
        // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = 00000003-0000-0010-8000-00AA00389B71
        return guid[0] == 0x03 && guid[1] == 0x00 && guid[2] == 0x00 && guid[3] == 0x00
            && guid[4] == 0x00 && guid[5] == 0x00 && guid[6] == 0x10 && guid[7] == 0x00
            && guid[8] == 0x80 && guid[9] == 0x00 && guid[10] == 0x00 && guid[11] == 0xAA
            && guid[12] == 0x00 && guid[13] == 0x38 && guid[14] == 0x9B && guid[15] == 0x71;
    }

    private static AudioCaptureException Error(string code, string message, int hresult)
    {
        return new AudioCaptureException(code, $"{message} (0x{hresult:X8})");
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try
        {
            if (_started) _client.Stop();
        }
        catch { /* shutting down */ }
        if (_event != IntPtr.Zero) NativeMethods.CloseHandle(_event);
        Marshal.ReleaseComObject(_capture);
        Marshal.ReleaseComObject(_client);
    }
}

[ComVisible(true)]
public sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler
{
    public ManualResetEventSlim Completed { get; } = new(false);
    public IAudioClient? Client { get; private set; }
    public int HResult { get; private set; } = unchecked((int)0x80004005);
    public Exception? Error { get; private set; }

    public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
    {
        try
        {
            var hr = operation.GetActivateResult(out var activateResult, out var instance);
            if (hr < 0)
            {
                HResult = hr;
                return;
            }
            if (activateResult < 0)
            {
                HResult = activateResult;
                return;
            }
            Client = (IAudioClient)instance;
            HResult = 0;
        }
        catch (Exception exception)
        {
            Error = exception;
        }
        finally
        {
            Completed.Set();
        }
    }
}
