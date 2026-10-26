using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace PiikAudio;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static int Main(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { /* no console */ }

        var command = args.Length > 0 ? args[0].Trim().ToLowerInvariant() : "help";
        var options = ParseOptions(args);

        var comInitialized = NativeMethods.CoInitializeEx(IntPtr.Zero, NativeMethods.CoinitMultithreaded) >= 0;
        try
        {
            return command switch
            {
                "capabilities" => Capabilities(),
                "list" => List(),
                "resolve" => Resolve(options),
                "capture" => Capture(options),
                _ => Help(),
            };
        }
        catch (AudioCaptureException exception)
        {
            WriteError(exception);
            return 2;
        }
        catch (Exception exception)
        {
            WriteError(new AudioCaptureException("INTERNAL", exception.Message, exception));
            return 3;
        }
        finally
        {
            if (comInitialized) NativeMethods.CoUninitialize();
        }
    }

    private static int Capabilities()
    {
        WriteJson(new
        {
            ok = true,
            osBuild = Environment.OSVersion.Version.Build,
            processLoopback = AudioCaptureSession.ProcessLoopbackSupported,
            sessionId = Process.GetCurrentProcess().SessionId,
            arch = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
        });
        return 0;
    }

    private static int List()
    {
        var windows = AppList.Windows();
        var apps = AppList.Apps(windows);
        WriteJson(new
        {
            ok = true,
            osBuild = Environment.OSVersion.Version.Build,
            processLoopback = AudioCaptureSession.ProcessLoopbackSupported,
            apps,
            windows,
        });
        return 0;
    }

    private static int Resolve(Dictionary<string, string?> options)
    {
        var raw = Option(options, "hwnd") ?? throw new AudioCaptureException("BAD_ARGS", "缺少窗口句柄。");
        if (!TryParseHandle(raw, out var handle))
        {
            throw new AudioCaptureException("BAD_ARGS", "窗口句柄格式不正确。");
        }
        if (!NativeMethods.IsWindow(handle))
        {
            throw new AudioCaptureException("WINDOW_NOT_FOUND", "窗口已经关闭，请重新选择。");
        }

        NativeMethods.GetWindowThreadProcessId(handle, out var processId);
        var title = ReadTitle(handle);
        var (name, exe) = AppList.Describe((int)processId);
        WriteJson(new
        {
            ok = true,
            hwnd = handle.ToInt64(),
            pid = (int)processId,
            name,
            exe,
            title,
            voice = AppList.IsVoiceName(name),
        });
        return 0;
    }

    private static int Capture(Dictionary<string, string?> options)
    {
        var modeText = (Option(options, "mode") ?? "system").ToLowerInvariant();
        var mode = modeText switch
        {
            "system" => CaptureMode.System,
            "include" => CaptureMode.Include,
            "exclude" => CaptureMode.Exclude,
            _ => throw new AudioCaptureException("BAD_ARGS", "未知的音频采集模式。"),
        };

        var processId = 0;
        if (mode != CaptureMode.System)
        {
            var pidText = Option(options, "pid") ?? throw new AudioCaptureException("BAD_ARGS", "缺少程序进程号。");
            if (!int.TryParse(pidText, out processId) || processId <= 0)
            {
                throw new AudioCaptureException("BAD_ARGS", "程序进程号格式不正确。");
            }
        }

        using var session = AudioCaptureSession.Create(mode, processId);
        session.Start();

        using var output = Console.OpenStandardOutput();
        var header = JsonSerializer.Serialize(new
        {
            sampleRate = session.Format.SampleRate,
            channels = session.Format.Channels,
            bits = session.Format.Bits,
            encoding = session.Format.Encoding,
            blockAlign = session.Format.BlockAlign,
            mode = modeText,
        }, JsonOptions);
        var headerBytes = Encoding.UTF8.GetBytes("PIIK1 " + header + "\n");
        output.Write(headerBytes, 0, headerBytes.Length);
        output.Flush();

        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };
        session.Pump(output, cancellation.Token);
        return 0;
    }

    private static int Help()
    {
        Console.Error.WriteLine("PiikAudio commands: capabilities | list | resolve --hwnd <handle> | capture --mode system|include|exclude [--pid <pid>]");
        return 1;
    }

    private static string ReadTitle(IntPtr handle)
    {
        var length = NativeMethods.GetWindowTextLength(handle);
        if (length <= 0) return "";
        var text = new StringBuilder(length + 1);
        return NativeMethods.GetWindowText(handle, text, text.Capacity) > 0 ? text.ToString().Trim() : "";
    }

    private static bool TryParseHandle(string value, out IntPtr handle)
    {
        long parsed;
        if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            if (!long.TryParse(value[2..], System.Globalization.NumberStyles.HexNumber, null, out parsed))
            {
                handle = IntPtr.Zero;
                return false;
            }
        }
        else if (!long.TryParse(value, out parsed))
        {
            handle = IntPtr.Zero;
            return false;
        }
        handle = new IntPtr(parsed);
        return parsed != 0;
    }

    private static string? Option(Dictionary<string, string?> options, string name)
    {
        return options.TryGetValue(name, out var value) ? value : null;
    }

    private static Dictionary<string, string?> ParseOptions(string[] args)
    {
        var result = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        for (var index = 1; index < args.Length; index++)
        {
            var argument = args[index];
            if (!argument.StartsWith("--", StringComparison.Ordinal)) continue;
            var key = argument[2..];
            var equals = key.IndexOf('=');
            if (equals >= 0)
            {
                result[key[..equals]] = key[(equals + 1)..];
            }
            else if (index + 1 < args.Length && !args[index + 1].StartsWith("--", StringComparison.Ordinal))
            {
                result[key] = args[++index];
            }
            else
            {
                result[key] = null;
            }
        }
        return result;
    }

    private static void WriteJson(object value)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(value, JsonOptions));
        Console.Out.Flush();
    }

    private static void WriteError(AudioCaptureException exception)
    {
        try
        {
            Console.Error.WriteLine("PIIK-AUDIO-ERROR " + JsonSerializer.Serialize(new
            {
                code = exception.Code,
                message = exception.Message,
            }, JsonOptions));
            Console.Error.Flush();
        }
        catch { /* stderr unavailable */ }
    }
}
