using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace PiikDesktop
{
    internal static class Program
    {
        public static string AudioHelperPath { get; private set; }

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.ThreadException += (_, eventArgs) => Fatal(eventArgs.Exception);
            AppDomain.CurrentDomain.UnhandledException += (_, eventArgs) => Fatal(eventArgs.ExceptionObject as Exception);

            using (var mutex = new Mutex(true, "PiikDesktop.SingleInstance", out var created))
            {
                if (!created) return;
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
                Application.Run(new MainForm(config, args));
            }
        }

        private static void Fatal(Exception exception)
        {
            Log.Write("fatal: " + exception);
            try { MessageBox.Show(exception != null ? exception.ToString() : "未知错误", "Piik 桌面端", MessageBoxButtons.OK, MessageBoxIcon.Error); } catch { }
        }

        private static void ExtractAudioHelper()
        {
            var folder = Path.Combine(Path.GetTempPath(), "PiikDesktop", "audio");
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
            var folder = Path.Combine(Path.GetTempPath(), "PiikDesktop", "WebView2Loader");
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
