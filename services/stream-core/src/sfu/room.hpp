#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "rtp/packet.hpp"
#include "sfu/layers.hpp"
#include "sfu/rtp_rewriter.hpp"

namespace stream::sfu {

// Salida hacia un viewer (la implementa el adaptador de libdatachannel). Solo encola: no bloquea.
class ViewerSink {
 public:
  virtual ~ViewerSink() = default;
  virtual void send_video(rtp::Bytes packet) = 0;
  virtual void send_audio(rtp::Bytes packet) = 0;
  virtual void send_event(std::string json) = 0;
  virtual void close() = 0;
};

// RTCP hacia el host (PLI/REMB a la PeerConnection de vídeo).
class HostSink {
 public:
  virtual ~HostSink() = default;
  virtual void send_video_rtcp(rtp::Bytes packet) = 0;
};

struct ViewerOptions {
  std::uint32_t video_ssrc = 0;
  std::uint8_t video_payload_type = 96;
  std::uint32_t audio_ssrc = 0;
  std::uint8_t audio_payload_type = 111;
  std::uint16_t first_video_seq = 0;
  std::uint16_t first_audio_seq = 0;
  std::uint32_t first_video_ts = 0;
  std::uint32_t first_audio_ts = 0;
  std::map<int, int> video_extensions;  // id del host -> id del viewer
};

class Viewer {
 public:
  Viewer(std::string id, std::string sub, ViewerOptions options, std::shared_ptr<ViewerSink> sink,
         LayerSelectorConfig selector = {});

  const std::string& id() const { return id_; }
  const std::string& sub() const { return sub_; }
  ViewerSink& sink() { return *sink_; }
  int desired_layer() const { return desired_layer_.load(); }
  void set_desired_layer(int layer) { desired_layer_.store(layer); }
  std::uint32_t video_ssrc() const { return options_.video_ssrc; }

 private:
  friend class Room;
  std::string id_;
  std::string sub_;
  ViewerOptions options_;
  std::shared_ptr<ViewerSink> sink_;
  std::atomic<int> desired_layer_{0};
  std::atomic<bool> closed_{false};
  std::atomic<bool> rtcp_seen_{false};  // su primer SRTCP: ya tiene claves y puede recibir un keyframe
  // Solo el hilo de ingesta de cada medio toca su reescritor.
  RtpRewriter video_;
  RtpRewriter audio_;
  std::uint64_t video_generation_ = 0;
  std::uint64_t audio_generation_ = 0;
  // RTCP del viewer y el tick de capas: protegido por su mutex (no es camino caliente).
  std::mutex selector_mu_;
  LayerSelector selector_;
};

struct RoomConfig {
  int max_viewers = 50;
  std::size_t nack_capacity = 512;
  std::uint32_t server_ssrc = 1;  // SSRC del SFU como emisor de RTCP
};

// Reenvío de una sala (HU-LIVE-02, 04): el host sube una vez y cada viewer recibe su capa.
//  - on_host_video / on_host_audio: hilos de ingesta (uno por PeerConnection del host).
//  - add/remove/set_host/teardown: plano de control.
//  - on_viewer_rtcp / tick: callbacks RTCP y temporizador.
class Room {
 public:
  explicit Room(std::string id, RoomConfig config = {});

  const std::string& id() const { return id_; }

  // false si la sala está llena (409 ROOM_FULL) o ya terminó.
  bool add_viewer(std::shared_ptr<Viewer> viewer, std::int64_t now_ms);
  std::shared_ptr<Viewer> remove_viewer(const std::string& viewer_id);
  int viewer_count() const;

  // Nuevo WHIP de vídeo del host (primera vez o reconexión). Los viewers se conservan.
  void set_host_video(std::shared_ptr<HostSink> sink, int rid_extension_id, std::vector<std::string> rids);
  void set_host_audio();
  void clear_host_video();

  struct Ingest {
    std::optional<int> layer;
    bool keyframe = false;
  };
  Ingest on_host_video(rtp::ByteView packet, std::int64_t now_ms);
  void on_host_audio(rtp::ByteView packet, std::int64_t now_ms);
  // El primer RTCP del viewer (o cualquier PLI/FIR) pide un keyframe de su capa (limitado).
  void on_viewer_rtcp(const std::string& viewer_id, rtp::ByteView packet, std::int64_t now_ms);
  void tick(std::int64_t now_ms);  // evalúa capas de todos los viewers

  void broadcast_event(const std::string& json);
  // Avisa (p. ej. stream_state ended) y cierra a todos; la sala deja de aceptar viewers.
  void teardown(const std::string& final_event);
  bool ended() const { return ended_.load(); }

  std::array<bool, kLayers> active_layers(std::int64_t now_ms) const;
  // host_stats (1 Hz, plano de control): bitrate por capa desde la llamada anterior. Thread-safe.
  HostStats host_stats(std::int64_t now_ms);

 private:
  using ViewerList = std::vector<std::shared_ptr<Viewer>>;
  struct HostVideo {
    std::shared_ptr<HostSink> sink;
    int rid_extension_id = 0;
    std::vector<std::string> rids;
  };

  std::shared_ptr<const ViewerList> viewers() const { return viewers_.load(std::memory_order_acquire); }
  void request_keyframe(int layer, std::int64_t now_ms);
  void apply_layer(Viewer& v, int layer, std::int64_t now_ms);

  std::string id_;
  RoomConfig config_;
  std::atomic<std::shared_ptr<const ViewerList>> viewers_;
  std::mutex control_mu_;  // altas, bajas y cambio de host (copy-on-write)
  std::atomic<bool> ended_{false};

  std::atomic<std::shared_ptr<const HostVideo>> host_video_;
  std::atomic<std::uint64_t> video_generation_{0};
  std::atomic<std::uint64_t> audio_generation_{0};

  // Estado del hilo de ingesta de vídeo.
  std::uint64_t ingest_generation_ = 0;
  std::unique_ptr<SimulcastDemux> demux_;
  std::array<std::unique_ptr<NackBuffer>, kLayers> nack_;
  PliThrottle pli_;
  // Copia atómica de los SSRC del host para pedir PLI desde otros hilos.
  std::array<std::atomic<std::uint32_t>, kLayers> host_ssrc_{};
  std::array<std::atomic<std::int64_t>, kLayers> layer_seen_ms_{};
  std::array<std::atomic<bool>, kLayers> layer_seen_{};

  // Contadores de host_stats (relaxed: solo se leen para mostrarlos).
  std::array<std::atomic<std::uint64_t>, kLayers> layer_bytes_{};
  std::atomic<std::uint64_t> nacks_{0};
  std::atomic<std::uint64_t> plis_{0};
  std::mutex stats_mu_;
  std::array<std::uint64_t, kLayers> stats_bytes_{};
  std::optional<std::int64_t> stats_ms_;
};

}  // namespace stream::sfu
