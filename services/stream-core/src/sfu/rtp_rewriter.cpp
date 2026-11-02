#include "sfu/rtp_rewriter.hpp"

#include <algorithm>

#include "rtp/vp8.hpp"

namespace stream::sfu {
namespace {

constexpr std::size_t kMaxEpochs = 8;

// a está "después" de b en aritmética de 16 bits (RFC 1982).
bool seq_after_or_equal(std::uint16_t a, std::uint16_t b) { return static_cast<std::int16_t>(a - b) >= 0; }

}  // namespace

RtpRewriter::RtpRewriter(RewriterConfig config)
    : config_(std::move(config)), epochs_(std::make_shared<const Epochs>()) {}

std::optional<int> RtpRewriter::current() const {
  if (!anchored_) return std::nullopt;
  return epoch_.layer;
}

void RtpRewriter::resync() {
  if (anchored_) resync_ = true;
}

void RtpRewriter::start_epoch(const rtp::RtpView& view, int layer, std::optional<std::uint16_t> picture_id,
                              std::optional<std::uint8_t> tl0, std::int64_t now_ms) {
  std::uint16_t out_seq;
  std::uint32_t out_ts;
  std::uint16_t out_pic;
  std::uint8_t out_tl0;
  if (!sent_any_) {
    out_seq = config_.first_seq;
    out_ts = config_.first_timestamp;
    out_pic = picture_id.value_or(0);
    out_tl0 = tl0.value_or(0);
  } else {
    // Continúa la secuencia del viewer: seq + 1, timestamp avanzado por el reloj de pared.
    out_seq = static_cast<std::uint16_t>(last_out_seq_ + 1);
    const auto elapsed = std::max<std::int64_t>(1, now_ms - last_out_ms_);
    out_ts = last_out_ts_ + static_cast<std::uint32_t>(std::max<std::int64_t>(
                                1, elapsed * static_cast<std::int64_t>(config_.clock_rate) / 1000));
    out_pic = static_cast<std::uint16_t>(last_out_picture_id_ + 1);
    out_tl0 = static_cast<std::uint8_t>(last_out_tl0_ + 1);
  }
  epoch_ = Epoch{out_seq,
                 layer,
                 static_cast<std::uint16_t>(out_seq - view.seq),
                 out_ts - view.timestamp,
                 static_cast<std::uint16_t>(out_pic - picture_id.value_or(0)),
                 static_cast<std::uint8_t>(out_tl0 - tl0.value_or(0))};
  anchored_ = true;
  resync_ = false;

  auto old = epochs_.load();
  auto next = std::make_shared<Epochs>(*old);
  next->push_back(epoch_);
  if (next->size() > kMaxEpochs) next->erase(next->begin());
  epochs_.store(std::move(next));
}

std::optional<rtp::Bytes> RtpRewriter::apply(rtp::ByteView packet, const rtp::RtpView& view,
                                             const Epoch& e) const {
  rtp::Bytes out = rtp::rewrite_extensions(packet, view, config_.extensions);
  auto ov = rtp::parse_rtp(out);
  if (!ov) return std::nullopt;
  rtp::set_ssrc(out, config_.out_ssrc);
  rtp::set_payload_type(out, config_.out_payload_type);
  rtp::set_sequence(out, static_cast<std::uint16_t>(view.seq + e.seq_delta));
  rtp::set_timestamp(out, view.timestamp + e.ts_delta);
  if (config_.vp8) {
    auto payload = std::span(out).subspan(ov->payload_offset, ov->payload_size);
    if (auto d = rtp::parse_vp8(payload)) {
      if (d->picture_id)
        rtp::write_picture_id(payload, *d, static_cast<std::uint16_t>(*d->picture_id + e.picture_id_delta));
      if (d->tl0picidx)
        rtp::write_tl0picidx(payload, *d, static_cast<std::uint8_t>(*d->tl0picidx + e.tl0_delta));
    }
  }
  return out;
}

std::optional<rtp::Bytes> RtpRewriter::rewrite(rtp::ByteView packet, const rtp::RtpView& view, int layer,
                                               bool keyframe, std::int64_t now_ms) {
  std::optional<rtp::Vp8Descriptor> vp8;
  if (config_.vp8) vp8 = rtp::parse_vp8(packet.subspan(view.payload_offset, view.payload_size));
  const bool can_switch = !config_.vp8 || keyframe;

  // Anclar: al empezar, al cambiar a la capa objetivo o tras reemplazar el host.
  const bool needs_anchor = !anchored_ || resync_ || (layer == target_ && layer != epoch_.layer);
  if (needs_anchor) {
    if (layer != target_ || !can_switch) {
      // Mientras tanto se sigue enviando la capa actual (salvo que haya que re-anclar).
      if (!anchored_ || resync_ || layer != epoch_.layer) return std::nullopt;
    } else {
      start_epoch(view, layer, vp8 ? vp8->picture_id : std::nullopt, vp8 ? vp8->tl0picidx : std::nullopt,
                  now_ms);
    }
  } else if (layer != epoch_.layer) {
    return std::nullopt;
  }

  auto out = apply(packet, view, epoch_);
  if (!out) return std::nullopt;
  const auto out_seq = static_cast<std::uint16_t>(view.seq + epoch_.seq_delta);
  if (!sent_any_ || seq_after_or_equal(out_seq, last_out_seq_)) {
    last_out_seq_ = out_seq;
    last_out_ts_ = view.timestamp + epoch_.ts_delta;
    last_out_ms_ = now_ms;
    if (vp8 && vp8->picture_id)
      last_out_picture_id_ = static_cast<std::uint16_t>(*vp8->picture_id + epoch_.picture_id_delta);
    if (vp8 && vp8->tl0picidx) last_out_tl0_ = static_cast<std::uint8_t>(*vp8->tl0picidx + epoch_.tl0_delta);
  }
  sent_any_ = true;
  return out;
}

std::optional<RtpRewriter::Source> RtpRewriter::source_of(std::uint16_t out_seq) const {
  auto epochs = epochs_.load();
  // La época más reciente cuyo inicio es <= out_seq.
  for (auto it = epochs->rbegin(); it != epochs->rend(); ++it)
    if (seq_after_or_equal(out_seq, it->out_seq_start))
      return Source{it->layer, static_cast<std::uint16_t>(out_seq - it->seq_delta)};
  return std::nullopt;
}

std::optional<rtp::Bytes> RtpRewriter::retransmission(rtp::ByteView source_packet,
                                                      std::uint16_t out_seq) const {
  auto view = rtp::parse_rtp(source_packet);
  if (!view) return std::nullopt;
  auto epochs = epochs_.load();
  for (auto it = epochs->rbegin(); it != epochs->rend(); ++it)
    if (seq_after_or_equal(out_seq, it->out_seq_start)) return apply(source_packet, *view, *it);
  return std::nullopt;
}

}  // namespace stream::sfu
