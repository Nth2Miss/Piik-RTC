using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace PiikRTC
{
    internal static class Program
    {
        private const string RestartAfterArg = "--restart-after=";
        private const string DeleteOldArg = "--delete-old=";
        public static string AudioHelperPath { get; private set; }

        [STAThread]
        private static void Main(string[] args)
        {
            // 更新拉起是否成功只能靠这一行判断：进程有没有真正跑到 Main。
            Log.Write("process start: version=" + VersionText() + " pid=" + Process.GetCurrentProcess().Id
                + " exe=" + Application.ExecutablePath + " cwd=" + Environment.CurrentDirectory
                + " args=" + string.Join(" ", args) + " log=" + Log.FilePath);
            var restartAfter = ArgumentInt(args, RestartAfterArg);
            if (restartAfter > 0) WaitForPreviousProcess(restartAfter);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.ThreadException += (_, eventArgs) => Fatal(eventArgs.Exception);
            AppDomain.CurrentDomain.UnhandledException += (_, eventArgs) => Fatal(eventArgs.ExceptionObject as Exception);

            using (var mutex = new Mutex(true, "PiikRTC.SingleInstance", out var created))
            {
                // 旧进程没退干净时新进程会在这里静默返回，必须留痕。
                Log.Write("single instance: acquired=" + created + " name=PiikRTC.SingleInstance");
                if (!created) return;
                ScheduleDeleteOldExe(ArgumentValue(args, DeleteOldArg));
                LogSiblingExes();
                try
                {
                    ExtractWebView2Loader();
                }
                catch (Exception exception)
                {
                    Log.Write("loader extraction failed: " + exception);
                }
                try
                {
                    ExtractAudioHelper();
                }
                catch (Exception exception)
                {
                    Log.Write("audio helper extraction failed: " + exception);
                }
                var config = AppConfig.Load(args);
                try
                {
                    Application.Run(new MainForm(config, args));
                }
                finally
                {
                    Log.Write("desktop exit: message loop returned");
                }
            }
        }

        private static string ArgumentValue(string[] args, string prefix)
        {
            foreach (var argument in args ?? Array.Empty<string>())
            {
                if (argument.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    return argument.Substring(prefix.Length).Trim('"');
            }
            return "";
        }

        private static int ArgumentInt(string[] args, string prefix)
        {
            int value;
            return int.TryParse(ArgumentValue(args, prefix), NumberStyles.Integer, CultureInfo.InvariantCulture, out value) && value > 0 ? value : 0;
        }

        private static void WaitForPreviousProcess(int pid)
        {
            var watch = Stopwatch.StartNew();
            try
            {
                using (var process = Process.GetProcessById(pid))
                {
                    if (process.WaitForExit(120000)) Log.Write("update handoff: old process exited in " + (long)watch.Elapsed.TotalMilliseconds + "ms");
                    else Log.Write("update handoff: old process wait timeout in " + (long)watch.Elapsed.TotalMilliseconds + "ms");
                }
            }
            catch (ArgumentException)
            {
                Log.Write("update handoff: old process already exited");
            }
            catch (Exception exception)
            {
                Log.Write("update handoff: old process wait failed: " + exception.Message);
            }
        }

        private static void ScheduleDeleteOldExe(string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            string current;
            try { current = Path.GetFullPath(Application.ExecutablePath); }
            catch { current = Application.ExecutablePath; }
            string old;
            try { old = Path.GetFullPath(path); }
            catch { old = path; }
            if (string.Equals(old, current, StringComparison.OrdinalIgnoreCase)) return;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                for (var attempt = 0; attempt < 40; attempt++)
                {
                    try
                    {
                        if (!File.Exists(old)) { Log.Write("old exe already removed: " + old); return; }
                        File.Delete(old);
                        Log.Write("removed old exe: " + old);
                        return;
                    }
                    catch (Exception exception)
                    {
                        if (attempt == 39) Log.Write("remove old exe failed: " + old + " -> " + exception.Message);
                        else Thread.Sleep(250);
                    }
                }
            });
        }

        private static string VersionText()
        {
            try
            {
                var assembly = Assembly.GetEntryAssembly() ?? Assembly.GetExecutingAssembly();
                return (assembly.GetName().Version ?? new Version()).ToString();
            }
            catch { return ""; }
        }

        private static void LogSiblingExes()
        {
            try
            {
                var directory = Path.GetDirectoryName(Application.ExecutablePath) ?? Environment.CurrentDirectory;
                var files = Directory.GetFiles(directory, "Piik-RTC-v*.exe");
                Log.Write("sibling exe scan: " + files.Length + " in " + directory);
                foreach (var path in files)
                {
                    var version = "unreadable";
                    try { version = (AssemblyName.GetAssemblyName(path).Version ?? new Version()).ToString(); } catch { }
                    Log.Write("sibling exe: " + Path.GetFileName(path) + " version=" + version
                        + " modified=" + File.GetLastWriteTime(path).ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture));
                }
            }
            catch (Exception exception)
            {
                Log.Write("sibling exe scan failed: " + exception.Message);
            }
        }

        private static void Fatal(Exception exception)
        {
            Log.Write("fatal: " + exception);
            try { MessageBox.Show(exception != null ? exception.ToString() : "未知错误", "Piik-RTC 桌面端", MessageBoxButtons.OK, MessageBoxIcon.Error); } catch { }
        }

        private static void ExtractAudioHelper()
        {
            var folder = Path.Combine(Path.GetTempPath(), "PiikRTC", "audio");
            Directory.CreateDirectory(folder);
            var target = Path.Combine(folder, "PiikAudio.exe");
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Piik.Audio.gz"))
            {
                if (stream == null)
                {
                    Log.Write("embedded audio helper not found; only video will be shared");
                    return;
                }
                try
                {
                    using (var gzip = new GZipStream(stream, CompressionMode.Decompress))
                    using (var file = File.Create(target)) gzip.CopyTo(file);
                }
                catch (Exception exception)
                {
                    if (!File.Exists(target)) throw;
                    Log.Write("audio helper overwrite failed, using existing file: " + exception.Message);
                }
            }
            AudioHelperPath = target;
            Log.Write("audio helper extracted to " + target);
        }

        private static void ExtractWebView2Loader()
        {
            var folder = Path.Combine(Path.GetTempPath(), "PiikRTC", "WebView2Loader");
            Directory.CreateDirectory(folder);
            var target = Path.Combine(folder, "WebView2Loader.dll");
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Piik.WebView2Loader.dll"))
            {
                if (stream == null)
                {
                    Log.Write("embedded WebView2Loader.dll not found");
                    return;
                }
                using (var file = File.Create(target)) stream.CopyTo(file);
            }
            CoreWebView2Environment.SetLoaderDllFolderPath(folder);
            Log.Write("WebView2 loader extracted to " + folder);
        }
    }
}
