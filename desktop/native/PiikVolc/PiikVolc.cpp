#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <algorithm>
#include <deque>
#include <mutex>
#include <string>
#include <sstream>
#include "bytertc_engine.h"
#include "bytertc_room.h"

// C ABI only: the C# host never depends on the vendor's C++ object layout.
namespace {
std::mutex gate;
std::deque<std::string> events;
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
  if (engine) return -1;
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
  const int result = room->publishStreamVideo(false);
  room->publishStreamAudio(false);
  engine->stopScreenVideoCapture(); engine->stopScreenAudioCapture();
  return result;
}
API void __cdecl piik_volc_leave() {
  if (engine) {
    piik_volc_stop();
    if (room) { room->leaveRoom(); room->destroy(); room = nullptr; }
    bytertc::IRTCEngine::destroyRTCEngine(); engine = nullptr;
  }
  if (render) { DestroyWindow(render); render = nullptr; }
  renderStream.clear(); renderFit = -1;
}
API int __cdecl piik_volc_start(int window, long long source, int x, int y, int width, int height, int fps, int bitrate, const char* audioProcess, int audio) {
  if (!engine || !room || width <= 0 || height <= 0 || fps < 1 || fps > 60 || bitrate < 1 || bitrate > 16000) return -1;
  bytertc::VideoEncoderConfig config{};
  config.width = width; config.height = height; config.frame_rate = fps; config.max_bitrate = bitrate;
  int result = engine->setVideoEncoderConfig(config); if (result < 0) return result;
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
  result = engine->startScreenVideoCapture(selected, params);
  list->release();
  if (result < 0) return result;
  if (audio) {
    result = audioProcess && *audioProcess ? engine->startScreenAudioCapture(audioProcess) : engine->startScreenAudioCapture();
    if (result < 0) { piik_volc_stop(); return result; }
    result = room->publishStreamAudio(true);
    if (result < 0) { piik_volc_stop(); return result; }
  }
  result = room->publishStreamVideo(true);
  if (result < 0) piik_volc_stop();
  return result;
}
API int __cdecl piik_volc_token(const char* token) { return room ? room->updateToken(token) : -1; }
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
