using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace PiikDesktop
{
    internal interface IBridgeHost
    {
        void ShowSetup(string error);
        void NavigateServer(string url);
        AppConfig Config { get; }
        string ServerUrl { get; }
    }

    internal sealed class Bridge
    {
        private readonly IBridgeHost _host;
        private readonly CoreWebView2 _core;
        private readonly SynchronizationContext _uiContext;
        private SourceListResult _lastList;
        private DesktopSource _selected;
        private bool _setupMode;
        private IVideoCapture _video;
        private string _videoMode;
        private AudioProcessHost _audio;
        private readonly object _bufferGate = new object();
        private readonly List<CoreWebView2SharedBuffer> _freeBuffers = new List<CoreWebView2SharedBuffer>();
        private readonly Dictionary<int, CoreWebView2SharedBuffer> _inFlightBuffers = new Dictionary<int, CoreWebView2SharedBuffer>();
        private int _nextBufferId;
        private int _pendingRawFrames;

        public Bridge(IBridgeHost host, CoreWebView2 core)
        {
            _host = host;
            _core = core;
            _uiContext = SynchronizationContext.Current;
        }

        public bool SetupMode
        {
            get { return _setupMode; }
            set { _setupMode = value; }
        }

        private string ServerOrigin
        {
            get
            {
                var url = _host.ServerUrl;
                if (string.IsNullOrWhiteSpace(url)) return "";
                try { return new Uri(url).GetLeftPart(UriPartial.Authority); } catch { return ""; }
            }
        }

        private static bool IsSetupSource(string source)
        {
            return !string.IsNullOrEmpty(source) && source.StartsWith("https://piik.setup/", StringComparison.OrdinalIgnoreCase);
        }

        private bool IsTrustedSource(string source)
        {
            var origin = ServerOrigin;
            if (string.IsNullOrEmpty(origin) || string.IsNullOrEmpty(source)) return false;
            return source.StartsWith(origin + "/", StringComparison.OrdinalIgnoreCase) || string.Equals(source, origin, StringComparison.OrdinalIgnoreCase);
        }

        public async void HandleMessage(object sender, CoreWebView2WebMessageReceivedEventArgs eventArgs)
        {
            var source = eventArgs.Source ?? "";
            Dictionary<string, object> request;
            try { request = SimpleJson.ParseObject(eventArgs.WebMessageAsJson); }
            catch (Exception exception) { Log.Write("bridge parse failed: " + exception.Message); return; }

            var id = GetInt(request, "id");
            var type = GetString(request, "type");
            if (type == "ui-dismiss") return;
            var payload = request.TryGetValue("payload", out var payloadValue) ? payloadValue as Dictionary<string, object> : null;
            if (payload == null) payload = new Dictionary<string, object>();

            if (type == "video-frame-consumed")
            {
                if (!IsTrustedSource(source)) return;
                ReleaseSharedBuffer(GetInt(request, "bufferId"));
                return;
            }

            if (!Authorize(source, type, out var denial))
            {
                Reply(id, false, null, denial);
                return;
            }

            try
            {
                var result = await Dispatch(type, payload);
                Reply(id, true, result, null);
            }
            catch (Exception exception)
            {
                Log.Write("bridge '" + type + "' failed: " + exception);
                Reply(id, false, null, exception.Message);
            }
        }

        private bool Authorize(string source, string type, out string error)
        {
            error = null;
            if (IsSetupSource(source))
            {
                if (type == "setServer" || type == "cancelSetup" || type == "getConfig") return true;
                error = "设置页不能访问桌面采集功能。";
                return false;
            }
            if (IsTrustedSource(source)) return true;
            error = "不受信任的页面请求。";
            return false;
        }

        private async Task<object> Dispatch(string type, Dictionary<string, object> payload)
        {
            switch (type)
            {
                case "capabilities":
                    return SourceList.Capabilities();

                case "listSources":
                    _lastList = await Task.Run(() => SourceList.List());
                    return _lastList.ToJson();

                case "selectSource":
                {
                    var id = GetString(payload, "id");
                    var source = FindSource(id);
                    if (source == null) throw new InvalidOperationException("共享来源已失效，请刷新后重新选择。");
                    _selected = source;
                    return new Dictionary<string, object>
                    {
                        ["ok"] = true,
                        ["kind"] = source.Kind,
                        ["hwnd"] = source.Hwnd == 0 ? (object)null : source.Hwnd,
                        ["pid"] = source.Pid <= 0 ? (object)null : source.Pid,
                        ["appName"] = string.IsNullOrEmpty(source.AppName) ? null : source.AppName,
                        ["voice"] = source.Voice,
                    };
                }

                case "clearSource":
                    if (_video == null) _selected = null;
                    return new Dictionary<string, object> { ["ok"] = true };

                case "startVideo":
                    return StartVideo(payload);

                case "stopVideo":
                    StopVideo();
                    return new Dictionary<string, object> { ["ok"] = true };

                case "startAudio":
                    return StartAudio(payload);

                case "stopAudio":
                    StopAudio();
                    return new Dictionary<string, object> { ["ok"] = true };

                case "getConfig":
                    return new Dictionary<string, object>
                    {
                        ["serverUrl"] = _host.ServerUrl,
                        ["version"] = typeof(Bridge).Assembly.GetName().Version.ToString(3),
                        ["desktop"] = true,
                        ["platform"] = "win32",
                    };

                case "setServer":
                    return await SetServer(GetString(payload, "url"));

                case "cancelSetup":
                    if (string.IsNullOrWhiteSpace(_host.Config.ServerUrl)) return new Dictionary<string, object> { ["ok"] = false };
                    _host.NavigateServer(_host.Config.ServerUrl);
                    return new Dictionary<string, object> { ["ok"] = true };

                default:
                    throw new InvalidOperationException("未知的桌面请求：" + type);
            }
        }

        private DesktopSource FindSource(string id)
        {
            if (_lastList == null) return null;
            foreach (var source in _lastList.Sources)
            {
                if (string.Equals(source.Id, id, StringComparison.Ordinal)) return source;
            }
            return null;
        }

        private Dictionary<string, object> StartVideo(Dictionary<string, object> payload)
        {
            if (_selected == null) throw new InvalidOperationException("请先选择要共享的程序或屏幕。");
            var width = GetInt(payload, "width");
            var height = GetInt(payload, "height");
            var fps = GetInt(payload, "fps");
            if (fps <= 0) fps = 30;
            if (fps > 60) fps = 60;
            StopVideo();

            var wantRaw = GetBool(payload, "raw")
                && width > 0 && height > 0
                && (long)width * height <= 1920L * 1080L
                && fps <= 60
                && WgcCapture.IsSupported()
                && SupportsSharedBuffers();
            if (wantRaw)
            {
                var capture = new WgcCapture(_selected, width, height, fps, PostRawFrame, EndVideo);
                try
                {
                    capture.Start();
                    _video = capture;
                    _videoMode = "raw";
                }
                catch (Exception exception)
                {
                    Log.Write("WGC unavailable, falling back to JPEG: " + exception);
                    try { capture.Stop(); } catch { }
                }
            }
            if (_video == null)
            {
                var capture = new VideoCapture(_selected, width, height, fps,
                    frame => Post(new Dictionary<string, object>
                    {
                        ["type"] = "video-frame",
                        ["data"] = Convert.ToBase64String(frame.Data),
                        ["width"] = frame.Width,
                        ["height"] = frame.Height,
                        ["seq"] = frame.Sequence,
                    }),
                    info => Post(new Dictionary<string, object>
                    {
                        ["type"] = "video-ended",
                        ["info"] = new Dictionary<string, object> { ["code"] = info.Code, ["message"] = info.Message },
                    }));
                capture.Start();
                _video = capture;
                _videoMode = "jpeg";
            }
            Log.Write("video start: mode=" + _videoMode + " " + _video.Width + "x" + _video.Height + " fps=" + fps);
            return new Dictionary<string, object>
            {
                ["ok"] = true,
                ["width"] = _video.Width,
                ["height"] = _video.Height,
                ["mode"] = _videoMode,
            };
        }

        private bool SupportsSharedBuffers()
        {
            try
            {
                var version = _core.Environment?.BrowserVersionString ?? "";
                return int.TryParse(version.Split('.')[0], out var major) && major >= 93;
            }
            catch { return false; }
        }

        private void EndVideo(VideoEndedInfo info)
        {
            Post(new Dictionary<string, object>
            {
                ["type"] = "video-ended",
                ["info"] = new Dictionary<string, object> { ["code"] = info.Code, ["message"] = info.Message },
            });
        }

        private void PostRawFrame(RawVideoFrame frame)
        {
            if (frame == null || frame.Data == null) return;
            if (Interlocked.Increment(ref _pendingRawFrames) > 2)
            {
                Interlocked.Decrement(ref _pendingRawFrames);
                frame.Release?.Invoke();
                return;
            }
            if (_uiContext == null)
            {
                try { ShareRawFrame(frame); }
                finally
                {
                    frame.Release?.Invoke();
                    Interlocked.Decrement(ref _pendingRawFrames);
                }
                return;
            }
            _uiContext.Post(_ =>
            {
                try { ShareRawFrame(frame); }
                finally
                {
                    frame.Release?.Invoke();
                    Interlocked.Decrement(ref _pendingRawFrames);
                }
            }, null);
        }

        private void ShareRawFrame(RawVideoFrame frame)
        {
            if (_videoMode != "raw" || _video == null) return;
            CoreWebView2SharedBuffer buffer = null;
            var bufferId = 0;
            lock (_bufferGate)
            {
                while (_freeBuffers.Count > 0)
                {
                    var candidate = _freeBuffers[_freeBuffers.Count - 1];
                    _freeBuffers.RemoveAt(_freeBuffers.Count - 1);
                    if (candidate == null) continue;
                    if (candidate.Size >= (ulong)frame.Length) { buffer = candidate; break; }
                    try { candidate.Close(); } catch { }
                }
                if (buffer == null && _freeBuffers.Count + _inFlightBuffers.Count < 4)
                {
                    try { buffer = _core.Environment.CreateSharedBuffer((ulong)frame.Length); }
                    catch (Exception exception) { Log.Write("shared buffer create failed: " + exception.Message); return; }
                }
                // Backpressure: the renderer keeps at most a few buffers in flight.
                if (buffer == null) return;
                bufferId = ++_nextBufferId;
                _inFlightBuffers[bufferId] = buffer;
            }
            try
            {
                using (var stream = buffer.OpenStream()) stream.Write(frame.Data, 0, frame.Length);
                var payload = new Dictionary<string, object>
                {
                    ["type"] = "video-frame-raw",
                    ["bufferId"] = bufferId,
                    ["width"] = frame.Width,
                    ["height"] = frame.Height,
                    ["stride"] = frame.Stride,
                    ["seq"] = frame.Sequence,
                    ["timestamp"] = frame.TimestampUs,
                };
                _core.PostSharedBufferToScript(buffer, CoreWebView2SharedBufferAccess.ReadOnly, SimpleJson.Stringify(payload));
            }
            catch (Exception exception)
            {
                Log.Write("raw frame post failed: " + exception.Message);
                lock (_bufferGate)
                {
                    _inFlightBuffers.Remove(bufferId);
                    _freeBuffers.Add(buffer);
                }
            }
        }

        private void ReleaseSharedBuffer(int bufferId)
        {
            if (bufferId <= 0) return;
            lock (_bufferGate)
            {
                if (!_inFlightBuffers.TryGetValue(bufferId, out var buffer)) return;
                _inFlightBuffers.Remove(bufferId);
                _freeBuffers.Add(buffer);
            }
        }

        private void StopVideo()
        {
            var video = _video;
            _video = null;
            _videoMode = null;
            if (video != null) { try { video.Stop(); } catch { } }
            DisposeSharedBuffers();
        }

        private void DisposeSharedBuffers()
        {
            List<CoreWebView2SharedBuffer> buffers;
            lock (_bufferGate)
            {
                buffers = new List<CoreWebView2SharedBuffer>(_freeBuffers);
                buffers.AddRange(_inFlightBuffers.Values);
                _freeBuffers.Clear();
                _inFlightBuffers.Clear();
            }
            foreach (var buffer in buffers)
            {
                try { buffer.Close(); } catch { }
            }
        }

        private Dictionary<string, object> StartAudio(Dictionary<string, object> payload)
        {
            var mode = GetString(payload, "mode");
            var pid = GetInt(payload, "pid");
            if (mode != "system" && mode != "include" && mode != "exclude") throw new InvalidOperationException("未知的音频采集模式。");
            if (mode != "system" && pid <= 0) throw new InvalidOperationException("缺少要采集的程序进程号。");
            StopAudio();
            _audio = new AudioProcessHost(
                (data, length) => Post(new Dictionary<string, object>
                {
                    ["type"] = "audio-data",
                    ["data"] = Convert.ToBase64String(data, 0, length),
                }),
                info => Post(new Dictionary<string, object>
                {
                    ["type"] = "audio-ended",
                    ["info"] = new Dictionary<string, object> { ["code"] = info.Code, ["message"] = info.Message },
                }));
            var format = _audio.Start(mode, pid);
            return new Dictionary<string, object>
            {
                ["ok"] = true,
                ["sampleRate"] = format.SampleRate,
                ["channels"] = format.Channels,
                ["bits"] = format.Bits,
                ["encoding"] = format.Encoding,
                ["blockAlign"] = format.BlockAlign,
                ["mode"] = mode,
            };
        }

        private void StopAudio()
        {
            if (_audio == null) return;
            try { _audio.Stop(); } catch { }
            _audio = null;
        }

        private async Task<Dictionary<string, object>> SetServer(string value)
        {
            string url;
            try
            {
                url = NormalizeServerUrl(value);
            }
            catch (Exception exception)
            {
                return new Dictionary<string, object> { ["ok"] = false, ["message"] = exception.Message };
            }

            try
            {
                using (var client = new HttpClient { Timeout = TimeSpan.FromSeconds(6) })
                {
                    var response = await client.GetAsync(url + "/api/config");
                    if (!response.IsSuccessStatusCode)
                    {
                        return new Dictionary<string, object> { ["ok"] = false, ["message"] = "服务器返回 " + (int)response.StatusCode + "，请检查地址。" };
                    }
                }
            }
            catch (Exception exception)
            {
                return new Dictionary<string, object> { ["ok"] = false, ["message"] = "无法连接服务器：" + exception.Message };
            }

            _host.Config.ServerUrl = url;
            _host.Config.Save();
            _host.NavigateServer(url);
            return new Dictionary<string, object> { ["ok"] = true, ["serverUrl"] = url };
        }

        public static string NormalizeServerUrl(string value)
        {
            var text = (value ?? "").Trim();
            if (text.Length == 0) throw new InvalidOperationException("请填写服务器地址。");
            Uri uri;
            if (!Uri.TryCreate(text, UriKind.Absolute, out uri)) throw new InvalidOperationException("服务器地址格式不正确。");
            if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) throw new InvalidOperationException("服务器地址必须以 https:// 或 http:// 开头。");
            if (uri.Scheme == Uri.UriSchemeHttp && !(uri.IsLoopback || string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase)))
            {
                throw new InvalidOperationException("除本机地址外，请使用 HTTPS 服务器地址。");
            }
            return uri.GetLeftPart(UriPartial.Authority);
        }

        public void StopAll()
        {
            StopVideo();
            StopAudio();
            _selected = null;
        }

        private void Post(Dictionary<string, object> message)
        {
            var json = SimpleJson.Stringify(message);
            if (_uiContext == null)
            {
                try { _core.PostWebMessageAsJson(json); }
                catch (Exception exception) { Log.Write("post failed: " + exception.Message); }
                return;
            }
            _uiContext.Post(_ =>
            {
                try { _core.PostWebMessageAsJson(json); }
                catch (Exception exception) { Log.Write("post failed: " + exception.Message); }
            }, null);
        }

        private void Reply(int id, bool ok, object result, string error)
        {
            var message = new Dictionary<string, object>
            {
                ["id"] = id,
                ["ok"] = ok,
                ["result"] = result,
                ["error"] = error,
            };
            Post(message);
        }

        internal static int GetInt(Dictionary<string, object> map, string key)
        {
            if (map == null || !map.TryGetValue(key, out var value) || value == null) return 0;
            try { return Convert.ToInt32(value); } catch { return 0; }
        }

        internal static string GetString(Dictionary<string, object> map, string key)
        {
            if (map == null || !map.TryGetValue(key, out var value) || value == null) return "";
            return Convert.ToString(value);
        }

        internal static bool GetBool(Dictionary<string, object> map, string key)
        {
            if (map == null || !map.TryGetValue(key, out var value) || value == null) return false;
            if (value is bool flag) return flag;
            try { return Convert.ToBoolean(value, System.Globalization.CultureInfo.InvariantCulture); } catch { return false; }
        }
    }
}
