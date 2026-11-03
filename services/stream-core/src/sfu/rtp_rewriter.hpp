#pragma once

#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <vector>

#include "rtp/packet.hpp"

namespace stream::sfu {

struct RewriterConfig {
  std::uint32_t out_ssrc = 0;
  std::uint8_t out_payload_type = 0;
  std::uint16_t first_seq = 0;  // aleatorio por viewer
  std::uint32_t first_timestamp = 0;
  std::uint32_t clock_rate = 90000;  // 90 kHz vídeo, 48 kHz Opus
  bool vp8 = true;                   // reescribir PictureID/TL0PICIDX y conmutar solo en keyframe
  std::map<int, int> extensions;     // id del host -> id del viewer (p. ej. abs-send-time)
};

// Reescribe los paquetes de la capa elegida hacia un viewer para que vea UNA secuencia continua
// (SSRC, seq, timestamp, PT y PictureID propios) aunque cambie de capa o se reemplace el host
// (HU-LIVE-02 AC3, HU-LIVE-05 AC3). Lo usa solo el hilo de ingesta; el mapeo inverso para NACK
// (source_of / retransmission) se puede leer desde otros hilos: las épocas son inmutables.
class RtpRewriter {
 public:
  explicit RtpRewriter(RewriterConfig config);

  void set_target(int layer) { target_ = layer; }
  int target() const { return target_; }
  std::optional<int> current() const;

  // nullopt = el paquete no se envía (otra capa, o esperando keyframe).
  std::optional<rtp::Bytes> rewrite(rtp::ByteView packet, const rtp::RtpView& view, int layer, bool keyframe,
                                    std::int64_t now_ms);

  // El host se reemplazó: espera un keyframe de la capa objetivo y re-ancla sin saltos.
  void resync();

  struct Source {
    int layer = 0;
    std::uint16_t seq = 0;
  };
  std::optional<Source> source_of(std::uint16_t out_seq) const;
  // Reescribe un paquete guardado (NACK) con los desfases de la época de out_seq.
  std::optional<rtp::Bytes> retransmission(rtp::ByteView source_packet, std::uint16_t out_seq) const;

 private:
  struct Epoch {
    std::uint16_t out_seq_start = 0;
    int layer = 0;
    std::uint16_t seq_delta = 0;
    std::uint32_t ts_delta = 0;
    std::uint16_t picture_id_delta = 0;
    std::uint8_t tl0_delta = 0;
  };
  using Epochs = std::vector<Epoch>;

  void start_epoch(const rtp::RtpView& view, int layer, std::optional<std::uint16_t> picture_id,
                   std::optional<std::uint8_t> tl0, std::int64_t now_ms);
  std::optional<rtp::Bytes> apply(rtp::ByteView packet, const rtp::RtpView& view, const Epoch& e) const;

  RewriterConfig config_;
  int target_ = 0;
  bool anchored_ = false;
  bool resync_ = false;
  bool sent_any_ = false;
  std::uint16_t last_out_seq_ = 0;
  std::uint32_t last_out_ts_ = 0;
  std::uint16_t last_out_picture_id_ = 0;
  std::uint8_t last_out_tl0_ = 0;
  std::int64_t last_out_ms_ = 0;
  Epoch epoch_{};
  std::atomic<std::shared_ptr<const Epochs>> epochs_;
};

}  // namespace stream::sfu
