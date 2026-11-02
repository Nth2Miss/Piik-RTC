#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <sstream>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include "bytertc_engine.h"
#include "bytertc_room.h"
#include "rtc/bytertc_audio_frame.h"

// C ABI only: the C# host never depends on the vendor's C++ object layout.
namespace {
std::mutex gate;
std::deque<std::string> events;
std::atomic<bool> leaving{false};
std::atomic<bool> externalAudio{false};
std::atomic<bool> externalVideo{false};
typedef void (__cdecl *PiikFrameCallback)(const char* stream, int width, int height, int rotation, const uint8_t* data, int length, int64_t timestamp_us);
std::atomic<PiikFrameCallback> frameCallback{nullptr};
std::atomic<bool> localFrames{false};

class FrameSink final : public bytertc::IVideoSink {
 public:
  explicit FrameSink(std::string key) : key_(std::move(key)) {}
  bool onFrame(bytertc::IVideoFrame* frame) override {
    const auto callback = frameCallback.load();
    if (!callback || !frame || (key_.empty() && !localFrames)) return true;
    if (frame->pixelFormat() != bytertc::kVideoPixelFormatI420 || frame->numberOfPlanes() < 3) return true;
    const int width = frame->width(), height = frame->height();
    if (width <= 0 || height <= 0) return true;
    const int chromaWidth = (width + 1) / 2, chromaHeight = (height + 1) / 2;
    const size_t ySize = static_cast<size_t>(width) * height;
    const size_t uvSize = static_cast<size_t>(chromaWidth) * chromaHeight;
    static thread_local std::vector<uint8_t> packed;
    packed.resize(ySize + uvSize * 2);
    for (int row = 0; row < height; ++row)
      memcpy(packed.data() + static_cast<size_t>(row) * width, frame->planeData(0) + static_cast<size_t>(row) * frame->planeStride(0), width);
    for (int row = 0; row < chromaHeight; ++row)
      memcpy(packed.data() + ySize + static_cast<size_t>(row) * chromaWidth, frame->planeData(1) + static_cast<size_t>(row) * frame->planeStride(1), chromaWidth);
    for (int row = 0; row < chromaHeight; ++row)
      memcpy(packed.data() + ySize + uvSize + static_cast<size_t>(row) * chromaWidth, frame->planeData(2) + static_cast<size_t>(row) * frame->planeStride(2), chromaWidth);
    callback(key_.c_str(), width, height, static_cast<int>(frame->rotation()), packed.data(), static_cast<int>(packed.size()), frame->timestampUs());
    return true;
  }
  int getRenderElapse() override { return 0; }
  void release() override {}
 private:
  std::string key_;
};

std::unique_ptr<FrameSink> localSink;
bool localSinkRegistered = false;
std::unordered_map<std::string, std::unique_ptr<FrameSink>> remoteSinks;
std::unordered_set<std::string> remoteSinkRegistered;

// The SDK's window capturer calls BringWindowToTop/ShowWindow/SetWindowPos on
// the shared window. Patch its USER32 import table so those calls are swallowed
// only for the current source window while capture starts.
std::atomic<bool> suppressActivation{false};
std::atomic<HWND> suppressedWindow{nullptr};
std::atomic<unsigned> suppressionGeneration{0};
using BringWindowToTopFn = BOOL (WINAPI*)(HWND);
using ShowWindowFn = BOOL (WINAPI*)(HWND, int);
using SetWindowPosFn = BOOL (WINAPI*)(HWND, HWND, int, int, int, int, UINT);
BringWindowToTopFn realBringWindowToTop = nullptr;
ShowWindowFn realShowWindow = nullptr;
SetWindowPosFn realSetWindowPos = nullptr;
std::atomic<long> suppressedActivations{0};
bool activationHooksInstalled = false;
std::mutex activationHookGate;

bool ShouldSuppress(HWND window) {
  return window && suppressActivation.load() && window == suppressedWindow.load();
}
BOOL WINAPI SuppressBringWindowToTop(HWND window) {
  if (ShouldSuppress(window)) { suppressedActivations.fetch_add(1); return TRUE; }
  return realBringWindowToTop ? realBringWindowToTop(window) : TRUE;
}
BOOL WINAPI SuppressShowWindow(HWND window, int command) {
  if (ShouldSuppress(window) && (command == SW_SHOW || command == SW_SHOWNORMAL || command == SW_SHOWDEFAULT || command == SW_RESTORE)) {
    suppressedActivations.fetch_add(1);
    return TRUE;
  }
  return realShowWindow ? realShowWindow(window, command) : FALSE;
}
BOOL WINAPI SuppressSetWindowPos(HWND window, HWND insertAfter, int x, int y, int width, int height, UINT flags) {
  if (ShouldSuppress(window) && (insertAfter == HWND_TOP || insertAfter == HWND_TOPMOST)) {
    suppressedActivations.fetch_add(1);
    return TRUE;
  }
  return realSetWindowPos ? realSetWindowPos(window, insertAfter, x, y, width, height, flags) : FALSE;
}
void InstallActivationHooks() {
  std::lock_guard<std::mutex> lock(activationHookGate);
  if (activationHooksInstalled) return;
  const HMODULE sdk = GetModuleHandleW(L"VolcEngineRTC.dll");
  if (!sdk) return;
  const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(sdk);
  const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS*>(reinterpret_cast<const BYTE*>(sdk) + dos->e_lfanew);
  const auto& directory = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
  if (!directory.VirtualAddress) return;
  auto* imports = reinterpret_cast<IMAGE_IMPORT_DESCRIPTOR*>(reinterpret_cast<BYTE*>(sdk) + directory.VirtualAddress);
  for (; imports->Name; ++imports) {
    const auto* module = reinterpret_cast<const char*>(reinterpret_cast<const BYTE*>(sdk) + imports->Name);
    if (_stricmp(module, "USER32.dll") != 0) continue;
    if (!imports->OriginalFirstThunk) break;
    auto* names = reinterpret_cast<IMAGE_THUNK_DATA*>(reinterpret_cast<BYTE*>(sdk) + imports->OriginalFirstThunk);
    auto* thunks = reinterpret_cast<IMAGE_THUNK_DATA*>(reinterpret_cast<BYTE*>(sdk) + imports->FirstThunk);
    for (; names->u1.AddressOfData; ++names, ++thunks) {
      if (IMAGE_SNAP_BY_ORDINAL64(names->u1.Ordinal)) continue;
      const auto* import = reinterpret_cast<const IMAGE_IMPORT_BY_NAME*>(reinterpret_cast<const BYTE*>(sdk) + names->u1.AddressOfData);
      const char* name = reinterpret_cast<const char*>(import->Name);
      void* replacement = nullptr;
      if (strcmp(name, "BringWindowToTop") == 0) {
        realBringWindowToTop = reinterpret_cast<BringWindowToTopFn>(thunks->u1.Function);
        replacement = reinterpret_cast<void*>(&SuppressBringWindowToTop);
      } else if (strcmp(name, "ShowWindow") == 0) {
        realShowWindow = reinterpret_cast<ShowWindowFn>(thunks->u1.Function);
        replacement = reinterpret_cast<void*>(&SuppressShowWindow);
      } else if (strcmp(name, "SetWindowPos") == 0) {
        realSetWindowPos = reinterpret_cast<SetWindowPosFn>(thunks->u1.Function);
        replacement = reinterpret_cast<void*>(&SuppressSetWindowPos);
      }
      if (!replacement) continue;
      DWORD oldProtect = 0;
      if (VirtualProtect(&thunks->u1.Function, sizeof(void*), PAGE_READWRITE, &oldProtect)) {
        thunks->u1.Function = reinterpret_cast<ULONGLONG>(replacement);
        DWORD ignored = 0;
        VirtualProtect(&thunks->u1.Function, sizeof(void*), oldProtect, &ignored);
      }
    }
    break;
  }
  activationHooksInstalled = true;
}
void BeginActivationSuppression(HWND window) {
  if (!window) return;
  suppressedWindow = window;
  suppressActivation = true;
  const auto generation = ++suppressionGeneration;
  std::thread([generation] {
    Sleep(3000);
    if (suppressionGeneration.load() == generation) {
      suppressActivation = false;
      suppressedWindow = nullptr;
    }
  }).detach();
}
bytertc::IRTCEngine* engine = nullptr;
bytertc::IRTCRoom* room = nullptr;
HWND render = nullptr;
std::string renderStream;
int renderFit = -1;
std::string quote(const char* text) {
  std::string out = "\"";
  for (const unsigned char c : std::string(text ? text : "")) {
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if (c >= 32) out += c;
  }
  return out + "\"";
}
void emit(std::string value) {
  std::lock_guard<std::mutex> lock(gate);
  if (events.size() >= 512) events.pop_front();
  events.push_back(std::move(value));
}
class Handler final : public bytertc::IRTCEngineEventHandler, public bytertc::IRTCRoomEventHandler {
 public:
  void onError(int code) override { emit("{\"type\":\"error\",\"code\":" + std::to_string(code) + "}"); }
  void onRoomStateChangedWithReason(const char*, const char*, bytertc::RoomState state, bytertc::RoomStateChangeReason reason) override {
    emit("{\"type\":\"connection\",\"state\":" + std::to_string(state) + ",\"reason\":" + std::to_string(reason) + "}");
  }
  void onTokenWillExpire() override { emit("{\"type\":\"token\"}"); }
  void onPublishPrivilegeTokenWillExpire() override { onTokenWillExpire(); }
  void onSubscribePrivilegeTokenWillExpire() override { onTokenWillExpire(); }
  void onVideoPublishStateChanged(const char*, const bytertc::StreamInfo&, bytertc::PublishState state, bytertc::PublishStateChangeReason reason) override {
    emit("{\"type\":\"publish-state\",\"state\":" + std::to_string(state) + ",\"reason\":" + std::to_string(reason) + "}");
  }
  void onAudioPublishStateChanged(const char*, const bytertc::StreamInfo&, bytertc::PublishState state, bytertc::PublishStateChangeReason reason) override {
    if (state == bytertc::kPublishStateUnpublished && static_cast<int>(reason) > 1) emit("{\"type\":\"error\",\"code\":" + std::to_string(reason) + "}");
  }
  void onVideoDeviceStateChanged(const char*, bytertc::RTCVideoDeviceType type, bytertc::MediaDeviceState state, bytertc::MediaDeviceError error) override {
    if (type == bytertc::kRTCVideoDeviceTypeScreenCaptureDevice && state == bytertc::kMediaDeviceStateRuntimeError)
      emit("{\"type\":\"error\",\"code\":" + std::to_string(error) + "}");
  }
  void onUserLeave(const char* uid, bytertc::UserOfflineReason) override { emit("{\"type\":\"left\",\"uid\":" + quote(uid) + "}"); }
  void onRemoteStreamStats(const char* id, const bytertc::StreamInfo&, const bytertc::RemoteStreamStats& stats) override {
    const auto& v = stats.video_stats;
    std::ostringstream s;
    s << "{\"type\":\"remote-stats\",\"streamId\":" << quote(id) << ",\"width\":" << v.width << ",\"height\":" << v.height
      << ",\"decodeFps\":" << v.decoder_output_frame_rate << ",\"renderFps\":" << v.renderer_output_frame_rate << ",\"bitrate\":" << v.received_kbitrate * 1000 << "}";
    emit(s.str());
  }
  void publication(const char* id, const bytertc::StreamInfo& info, bool published, const char* kind) {
    emit("{\"type\":\"publication\",\"streamId\":" + quote(id) + ",\"uid\":" + quote(info.user_id) + ",\"kind\":" + quote(kind) + ",\"published\":" + (published ? "true" : "false") + "}");
  }
  void onUserPublishStreamVideo(const char* id, const bytertc::StreamInfo& info, bool published) override { publication(id, info, published, "video"); }
  void onUserPublishStreamAudio(const char* id, const bytertc::StreamInfo& info, bool published) override { publication(id, info, published, "audio"); }
  void onLocalStreamStats(const char*, const bytertc::StreamInfo&, const bytertc::LocalStreamStats& stats) override {
    const auto& v = stats.video_stats;
    std::ostringstream s;
    s << "{\"type\":\"local-stats\",\"width\":" << v.encoded_frame_width << ",\"height\":" << v.encoded_frame_height
      << ",\"captureFps\":" << v.input_frame_rate << ",\"sendFps\":" << v.sent_frame_rate << ",\"encoderFps\":" << v.encoder_output_frame_rate
      << ",\"bitrate\":" << v.sent_kbitrate * 1000 << ",\"rtt\":" << v.rtt << "}";
    emit(s.str());
  }
} handler;
}
#define API extern "C" __declspec(dllexport)
API const char* __cdecl piik_volc_version() { return bytertc::IRTCEngine::getSDKVersion(); }
API int __cdecl piik_volc_join(const char* app, const char* roomId, const char* token, const char* uid) {
  if (engine || leaving) return -1;
  { std::lock_guard<std::mutex> lock(gate); events.clear(); }
  bytertc::EngineConfig config{};
  config.app_id = app;
  engine = bytertc::IRTCEngine::createRTCEngine(config, &handler);
  if (!engine) return -2;
  room = engine->createRTCRoom(roomId);
  if (!room) return -3;
  room->setRTCRoomEventHandler(&handler);
  bytertc::RTCRoomConfig rtc{};
  rtc.is_auto_publish_audio = rtc.is_auto_publish_video = false;
  rtc.is_auto_subscribe_audio = rtc.is_auto_subscribe_video = false;
  bytertc::UserInfo user{}; user.uid = uid;
  return room->joinRoom(token, user, true, rtc);
}
API int __cdecl piik_volc_stop() {
  if (!engine || !room) return 0;
  externalVideo = false;
  const int result = room->publishStreamVideo(false);
  room->publishStreamAudio(false);
  engine->stopScreenVideoCapture(); engine->stopScreenAudioCapture();
  return result;
}
API void __cdecl piik_volc_leave() {
  if (leaving.exchange(true)) return;
  if (engine) {
    piik_volc_stop();
    if (room) { room->leaveRoom(); room->destroy(); room = nullptr; }
    bytertc::IRTCEngine::destroyRTCEngine(); engine = nullptr;
  }
  if (render) { DestroyWindow(render); render = nullptr; }
  renderStream.clear(); renderFit = -1;
  localFrames = false;
  localSinkRegistered = false;
  localSink.reset();
  remoteSinkRegistered.clear();
  remoteSinks.clear();
  suppressActivation = false;
  suppressedWindow = nullptr;
  externalAudio = false;
  externalVideo = false;
  leaving = false;
}
API int __cdecl piik_volc_start(int window, long long source, int x, int y, int width, int height, int fps, int bitrate, const char* audioProcess, int audio, int externalSource) {
  if (!engine || !room || leaving || width <= 0 || height <= 0 || fps < 1 || fps > 60 || bitrate < 1 || bitrate > 16000) return -1;
  bytertc::VideoEncoderConfig config{};
  config.width = width; config.height = height; config.frame_rate = fps; config.max_bitrate = bitrate;
  int result = engine->setVideoEncoderConfig(config); if (result < 0) return result;
  externalVideo = false;
  if (externalSource != 0) {
    // WGC (host-side) is the source; the SDK only encodes and publishes frames
    // pushed with piik_volc_push_video.
    result = engine->setVideoSourceType(bytertc::kVideoSourceTypeExternal);
    if (result < 0) return result;
    externalVideo = true;
  } else {
    result = engine->setVideoSourceType(bytertc::kVideoSourceTypeInternal);
    if (result < 0) return result;
    InstallActivationHooks();
    if (window && source) {
      suppressedActivations = 0;
      BeginActivationSuppression(reinterpret_cast<HWND>(static_cast<intptr_t>(source)));
    }
    auto* list = engine->getScreenCaptureSourceList();
    if (!list) return -2;
    bytertc::ScreenCaptureSourceInfo selected{};
    bool found = false;
    for (int i = 0; i < list->getCount(); ++i) {
      const auto item = list->getSourceInfo(i);
      if ((window && item.type == bytertc::kScreenCaptureSourceTypeWindow && reinterpret_cast<long long>(item.source_id) == source)
          || (!window && item.type == bytertc::kScreenCaptureSourceTypeScreen && item.region_rect.x == x && item.region_rect.y == y)) {
        selected = item; found = true; break;
      }
    }
    if (!found) { list->release(); return -3; }
    bytertc::ScreenCaptureParameters params{};
    params.highlight_config.enable_highlight = false;
    result = engine->startScreenVideoCapture(selected, params);
    list->release();
    if (result < 0) return result;
  }
  if (audio) {
    if (externalAudio) {
      result = engine->setScreenAudioSourceType(bytertc::kAudioSourceTypeExternal);
    } else {
      result = engine->setScreenAudioSourceType(bytertc::kAudioSourceTypeInternal);
      if (result >= 0) result = audioProcess && *audioProcess ? engine->startScreenAudioCapture(audioProcess) : engine->startScreenAudioCapture();
    }
    if (result < 0) { piik_volc_stop(); return result; }
    result = room->publishStreamAudio(true);
    if (result < 0) { piik_volc_stop(); return result; }
  }
  result = room->publishStreamVideo(true);
  if (result < 0) piik_volc_stop();
  return result;
}
API int __cdecl piik_volc_push_video(const void* data, int stride, int width, int height, int64_t timestamp_us) {
  if (!engine || !externalVideo || leaving) return -1000;
  if (!data || width <= 0 || height <= 0 || stride < width * 4) return -2;
  bytertc::VideoFrameData frame{};
  frame.buffer_type = bytertc::kVideoBufferTypeRawMemory;
  frame.pixel_format = bytertc::kVideoPixelFormatBGRA;
  frame.number_of_planes = 1;
  frame.plane_data[0] = const_cast<uint8_t*>(static_cast<const uint8_t*>(data));
  frame.plane_stride[0] = stride;
  frame.width = width;
  frame.height = height;
  frame.timestamp_us = timestamp_us;
  return engine->pushExternalVideoFrame(frame);
}
API void __cdecl piik_volc_set_frame_callback(PiikFrameCallback callback) { frameCallback = callback; }
API int __cdecl piik_volc_enable_local_frames(int enabled) {
  localFrames = enabled != 0;
  if (!enabled || !engine) return 0;
  if (!localSink) localSink.reset(new FrameSink(""));
  if (!localSinkRegistered) {
    bytertc::LocalVideoSinkConfig config{};
    config.position = bytertc::kLocalVideoSinkPositionAfterPreProcess;
    config.pixel_format = bytertc::kVideoPixelFormatI420;
    const int result = engine->setLocalVideoSink(localSink.get(), config);
    if (result < 0) return result;
    localSinkRegistered = true;
  }
  return 0;
}
API int __cdecl piik_volc_enable_remote_frames(const char* stream, int enabled) {
  if (!engine || !stream || !*stream) return -1;
  const std::string id(stream);
  if (!enabled) {
    if (remoteSinkRegistered.erase(id)) {
      bytertc::RemoteVideoSinkConfig config{};
      engine->setRemoteVideoSink(id.c_str(), nullptr, config);
    }
    return 0;
  }
  auto entry = remoteSinks.find(id);
  if (entry == remoteSinks.end())
    entry = remoteSinks.emplace(id, std::unique_ptr<FrameSink>(new FrameSink(id))).first;
  if (remoteSinkRegistered.insert(id).second) {
    bytertc::RemoteVideoSinkConfig config{};
    config.position = bytertc::kRemoteVideoSinkPositionAfterPostProcess;
    config.pixel_format = bytertc::kVideoPixelFormatI420;
    const int result = engine->setRemoteVideoSink(id.c_str(), entry->second.get(), config);
    if (result < 0) { remoteSinkRegistered.erase(id); return result; }
  }
  return 0;
}
API long __cdecl piik_volc_suppressed_activations() { return suppressedActivations.load(); }
API int __cdecl piik_volc_activation_hooks_installed() { return activationHooksInstalled ? 1 : 0; }
API int __cdecl piik_volc_token(const char* token) { return room ? room->updateToken(token) : -1; }
API void __cdecl piik_volc_set_screen_audio(int external) {
  externalAudio = external != 0;
  if (engine) engine->setScreenAudioSourceType(externalAudio ? bytertc::kAudioSourceTypeExternal : bytertc::kAudioSourceTypeInternal);
}
API int __cdecl piik_volc_push_audio(const void* data, int length, int sampleRate, int channels) {
  if (!engine || !externalAudio || leaving || !data || length <= 0 || sampleRate <= 0 || (channels != 1 && channels != 2)) return -1;
  bytertc::AudioFrameBuilder builder{};
  builder.sample_rate = static_cast<bytertc::AudioSampleRate>(sampleRate);
  builder.channel = static_cast<bytertc::AudioChannel>(channels);
  builder.data = const_cast<uint8_t*>(static_cast<const uint8_t*>(data));
  builder.data_size = length;
  builder.deep_copy = true;
  bytertc::IAudioFrame* frame = bytertc::buildAudioFrame(builder);
  if (!frame) return -2;
  const int result = engine->pushScreenAudioFrame(frame);
  frame->release();
  return result;
}
API int __cdecl piik_volc_subscribe(const char* stream, int audio, int subscribe) {
  if (!room) return -1;
  return audio ? room->subscribeStreamAudio(stream, subscribe != 0) : room->subscribeStreamVideo(stream, subscribe != 0);
}
API int __cdecl piik_volc_volume(int volume) { return engine ? engine->setPlaybackVolume(volume) : -1; }
API int __cdecl piik_volc_render(const char* stream, long long parent, int x, int y, int width, int height, int fit, int visible) {
  if (!engine) return -1;
  if (!visible) { if (render) ShowWindow(render, SW_HIDE); return 0; }
  if (!render) render = CreateWindowExW(0, L"STATIC", L"", WS_CHILD | WS_CLIPSIBLINGS, x, y, width, height, reinterpret_cast<HWND>(parent), nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!render) return -2;
  SetWindowPos(render, HWND_TOP, x, y, width, height, SWP_SHOWWINDOW | SWP_NOACTIVATE);
  const std::string id = stream ? stream : "";
  if (renderFit == fit && renderStream == id) return 0;
  bytertc::VideoCanvas canvas{}; canvas.view = render; canvas.render_mode = fit ? bytertc::kRenderModeFit : bytertc::kRenderModeHidden;
  const int result = id.empty() ? engine->setLocalVideoCanvas(canvas) : engine->setRemoteVideoCanvas(stream, canvas);
  if (result >= 0) { renderStream = id; renderFit = fit; }
  return result;
}
API int __cdecl piik_volc_poll(char* buffer, int capacity) {
  std::lock_guard<std::mutex> lock(gate);
  if (events.empty()) return 0;
  if (static_cast<int>(events.front().size()) + 1 > capacity) return -1;
  const auto event = std::move(events.front()); events.pop_front();
  memcpy(buffer, event.c_str(), event.size() + 1);
  return static_cast<int>(event.size());
}
