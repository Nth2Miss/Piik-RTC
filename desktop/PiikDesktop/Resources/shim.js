(function () {
  if (!window.chrome || !window.chrome.webview) return;
  var webview = window.chrome.webview;
  var nextId = 1;
  var pending = new Map();
  var audioData = new Set();
  var audioEnded = new Set();
  var videoFrames = new Set();
  var rawVideoFrames = new Set();
  var videoEnded = new Set();

  // The WinForms context menu lives outside WebView2, so the page has to tell
  // the host when the user clicks, scrolls, or presses Escape elsewhere.
  document.addEventListener('pointerdown', function (event) {
    if (event.button !== 2) webview.postMessage({ type: 'ui-dismiss' });
  }, true);
  document.addEventListener('wheel', function () {
    webview.postMessage({ type: 'ui-dismiss' });
  }, { capture: true, passive: true });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') webview.postMessage({ type: 'ui-dismiss' });
  }, true);

  function bytesFromBase64(value) {
    var binary = atob(value || '');
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function subscribe(set) {
    return function (handler) {
      if (typeof handler !== 'function') return function () {};
      set.add(handler);
      return function () { set.delete(handler); };
    };
  }

  function emit(set, value) {
    set.forEach(function (handler) {
      try { handler(value); } catch (error) { console.error(error); }
    });
  }

  function request(type, payload) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      webview.postMessage({ id: id, type: type, payload: payload || {} });
      setTimeout(function () {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error('本地桌面服务响应超时。'));
      }, type === 'listSources' ? 30000 : 15000);
    });
  }

  webview.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.id && pending.has(message.id)) {
      var waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new Error(message.error || '本地桌面服务请求失败。'));
      return;
    }
    if (message.type === 'audio-data') {
      emit(audioData, bytesFromBase64(message.data));
    } else if (message.type === 'audio-ended') {
      emit(audioEnded, message.info || {});
    } else if (message.type === 'video-frame') {
      emit(videoFrames, {
        data: message.data,
        width: message.width,
        height: message.height,
        seq: message.seq,
      });
    } else if (message.type === 'video-ended') {
      emit(videoEnded, message.info || {});
    }
  });

  webview.addEventListener('sharedbufferreceived', function (event) {
    var info = event.additionalData || {};
    var buffer = event.getBuffer ? event.getBuffer() : null;
    if (!buffer) return;
    var frame = null;
    try {
      if (info.type === 'video-frame-raw'
        && rawVideoFrames.size > 0
        && typeof VideoFrame === 'function') {
        frame = new VideoFrame(buffer, {
          format: 'BGRA',
          codedWidth: info.width,
          codedHeight: info.height,
          timestamp: info.timestamp,
          layout: [{ offset: 0, stride: info.stride }],
        });
      }
    } catch (error) {
      console.error('raw video frame failed', error);
    } finally {
      try { webview.releaseBuffer(buffer); } catch (error) { }
      webview.postMessage({ type: 'video-frame-consumed', bufferId: info.bufferId });
    }
    if (frame) emit(rawVideoFrames, { frame: frame, width: info.width, height: info.height, seq: info.seq });
  });

  var api = {
    isDesktop: true,
    captureMode: 'webview2',
    platform: 'win32',
    capabilities: function () { return request('capabilities'); },
    listSources: function () { return request('listSources'); },
    selectSource: function (id) { return request('selectSource', { id: id }); },
    clearSource: function () { return request('clearSource'); },
    startVideo: function (options) { return request('startVideo', options); },
    stopVideo: function () { return request('stopVideo'); },
    onVideoFrame: subscribe(videoFrames),
    onVideoFrameRaw: subscribe(rawVideoFrames),
    onVideoEnded: subscribe(videoEnded),
    startAudio: function (options) { return request('startAudio', options); },
    stopAudio: function () { return request('stopAudio'); },
    onAudioData: subscribe(audioData),
    onAudioEnded: subscribe(audioEnded),
    getConfig: function () { return request('getConfig'); },
    setServer: function (url) { return request('setServer', { url: url }); },
    cancelSetup: function () { return request('cancelSetup'); },
  };

  Object.defineProperty(window, 'piikDesktop', {
    value: Object.freeze(api),
    configurable: false,
    writable: false,
  });
})();
