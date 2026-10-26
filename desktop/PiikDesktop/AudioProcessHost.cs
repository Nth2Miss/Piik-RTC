using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace PiikDesktop
{
    internal sealed class AudioFormat
    {
        public int SampleRate;
        public int Channels;
        public int Bits;
        public string Encoding = "pcm_s16le";
        public int BlockAlign = 4;
    }

    internal sealed class AudioEndedInfo
    {
        public string Code;
        public string Message;
    }

    /// <summary>Runs the embedded self-contained PiikAudio helper and relays its PCM stream.</summary>
    internal sealed class AudioProcessHost
    {
        private readonly Action<byte[], int> _onData;
        private readonly Action<AudioEndedInfo> _onEnded;
        private readonly ManualResetEventSlim _headerReady = new ManualResetEventSlim(false);
        private readonly object _gate = new object();
        private Process _process;
        private Thread _reader;
        private Thread _errorReader;
        private AudioFormat _format;
        private string _startError;
        private string _stderr = "";
        private volatile bool _running;

        public AudioProcessHost(Action<byte[], int> onData, Action<AudioEndedInfo> onEnded)
        {
            _onData = onData;
            _onEnded = onEnded;
        }

        public AudioFormat Start(string mode, int pid)
        {
            var helper = Program.AudioHelperPath;
            if (string.IsNullOrEmpty(helper) || !File.Exists(helper))
            {
                throw new InvalidOperationException("原生音频组件不可用，本次只能共享画面。");
            }

            var arguments = "capture --mode " + mode;
            if (mode != "system") arguments += " --pid " + pid;
            var startInfo = new ProcessStartInfo(helper, arguments)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardErrorEncoding = new UTF8Encoding(false),
            };
            _process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            _process.Exited += OnProcessExited;
            _running = true;
            _process.Start();
            _reader = new Thread(ReadStdout) { IsBackground = true, Name = "PiikAudioStdout" };
            _errorReader = new Thread(ReadStderr) { IsBackground = true, Name = "PiikAudioStderr" };
            _reader.Start();
            _errorReader.Start();

            if (!_headerReady.Wait(15000))
            {
                Stop();
                throw new InvalidOperationException("启动音频采集超时。");
            }
            if (_startError != null)
            {
                Stop();
                throw new InvalidOperationException(_startError);
            }
            return _format;
        }

        private void ReadStdout()
        {
            var buffer = new byte[16384];
            var header = new MemoryStream();
            var readingHeader = true;
            try
            {
                using (var stream = _process.StandardOutput.BaseStream)
                {
                    while (_running)
                    {
                        var read = stream.Read(buffer, 0, buffer.Length);
                        if (read <= 0) break;
                        if (readingHeader)
                        {
                            var newline = Array.IndexOf(buffer, (byte)'\n', 0, read);
                            if (newline < 0)
                            {
                                header.Write(buffer, 0, read);
                                continue;
                            }
                            header.Write(buffer, 0, newline);
                            var line = Encoding.UTF8.GetString(header.ToArray()).Trim();
                            if (!line.StartsWith("PIIK1 ", StringComparison.Ordinal))
                            {
                                _startError = "音频组件返回了无法识别的数据。";
                                _headerReady.Set();
                                return;
                            }
                            try
                            {
                                var values = SimpleJson.ParseObject(line.Substring(6));
                                _format = new AudioFormat
                                {
                                    SampleRate = Convert.ToInt32(values["sampleRate"]),
                                    Channels = Convert.ToInt32(values["channels"]),
                                    Bits = Convert.ToInt32(values["bits"]),
                                    Encoding = Convert.ToString(values["encoding"]),
                                    BlockAlign = Convert.ToInt32(values["blockAlign"]),
                                };
                            }
                            catch (Exception exception)
                            {
                                _startError = "音频组件返回了无效的格式信息：" + exception.Message;
                                _headerReady.Set();
                                return;
                            }
                            _headerReady.Set();
                            readingHeader = false;
                            var remaining = read - newline - 1;
                            if (remaining > 0 && _running)
                            {
                                var chunk = new byte[remaining];
                                Buffer.BlockCopy(buffer, newline + 1, chunk, 0, remaining);
                                _onData(chunk, remaining);
                            }
                            continue;
                        }
                        if (_running)
                        {
                            var chunk = new byte[read];
                            Buffer.BlockCopy(buffer, 0, chunk, 0, read);
                            _onData(chunk, read);
                        }
                    }
                }
            }
            catch (Exception exception)
            {
                if (_running) Log.Write("audio stdout failed: " + exception.Message);
            }
            finally
            {
                if (readingHeader && _startError == null)
                {
                    _startError = "音频组件已退出：" + (_stderr.Trim().Length > 0 ? _stderr.Trim() : "未知原因");
                }
                _headerReady.Set();
            }
        }

        private void ReadStderr()
        {
            try
            {
                using (var reader = _process.StandardError)
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        _stderr += line + "\n";
                        if (line.StartsWith("PIIK-AUDIO-ERROR ", StringComparison.Ordinal))
                        {
                            try
                            {
                                var error = SimpleJson.ParseObject(line.Substring("PIIK-AUDIO-ERROR ".Length));
                                _startError = Convert.ToString(error["message"]);
                                _errorCode = Convert.ToString(error["code"]);
                            }
                            catch { /* keep the raw line */ }
                        }
                        else if (line.Trim().Length > 0)
                        {
                            Log.Write("audio: " + line);
                        }
                    }
                }
            }
            catch { /* process shutting down */ }
        }

        private string _errorCode;

        private void OnProcessExited(object sender, EventArgs eventArgs)
        {
            if (!_running) return;
            var process = sender as Process;
            var code = 0;
            try { if (process != null) code = process.ExitCode; } catch { }
            if (!_headerReady.IsSet)
            {
                _startError = _startError ?? ("音频组件已退出（" + code + "）。");
                _headerReady.Set();
                return;
            }
            _running = false;
            var info = new AudioEndedInfo
            {
                Code = _errorCode ?? (code == 0 ? "AUDIO_ENDED" : "AUDIO_FAILED"),
                Message = _startError ?? (code == 0 ? "音频采集已停止，画面共享会继续。" : "音频采集已退出（" + code + "）。"),
            };
            try { _onEnded(info); } catch (Exception exception) { Log.Write("audio ended callback failed: " + exception.Message); }
        }

        public void Stop()
        {
            _running = false;
            var process = _process;
            if (process != null)
            {
                try { if (!process.HasExited) process.Kill(); } catch { }
                try { process.WaitForExit(2000); } catch { }
            }
            _reader?.Join(1000);
            _errorReader?.Join(1000);
            process?.Dispose();
            _process = null;
        }
    }
}
