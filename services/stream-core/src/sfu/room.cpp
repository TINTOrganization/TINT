#include "sfu/room.hpp"

#include <algorithm>

#include "rtp/rtcp.hpp"
#include "rtp/vp8.hpp"

namespace stream::sfu {

Viewer::Viewer(std::string id, std::string sub, ViewerOptions options, std::shared_ptr<ViewerSink> sink,
               LayerSelectorConfig selector)
    : id_(std::move(id)),
      sub_(std::move(sub)),
      options_(std::move(options)),
      sink_(std::move(sink)),
      video_(RewriterConfig{.out_ssrc = options_.video_ssrc,
                            .out_payload_type = options_.video_payload_type,
                            .first_seq = options_.first_video_seq,
                            .first_timestamp = options_.first_video_ts,
                            .clock_rate = 90000,
                            .vp8 = true,
                            .extensions = options_.video_extensions}),
      audio_(RewriterConfig{.out_ssrc = options_.audio_ssrc,
                            .out_payload_type = options_.audio_payload_type,
                            .first_seq = options_.first_audio_seq,
                            .first_timestamp = options_.first_audio_ts,
                            .clock_rate = 48000,
                            .vp8 = false,
                            .extensions = {}}),
      selector_(selector) {}

Room::Room(std::string id, RoomConfig config)
    : id_(std::move(id)),
      config_(config),
      viewers_(std::make_shared<const ViewerList>()),
      host_video_(std::shared_ptr<const HostVideo>()) {
  for (auto& n : nack_) n = std::make_unique<NackBuffer>(config_.nack_capacity);
}

// --- Plano de control ----------------------------------------------------------------------

bool Room::add_viewer(std::shared_ptr<Viewer> viewer, std::int64_t /*now_ms*/) {
  {
    std::lock_guard lock(control_mu_);
    if (ended_.load()) return false;
    auto current = viewers();
    if (static_cast<int>(current->size()) >= config_.max_viewers) return false;
    auto next = std::make_shared<ViewerList>(*current);
    next->push_back(viewer);
    viewers_.store(std::move(next), std::memory_order_release);
  }
  // Entra en la capa baja (primer frame rápido). El keyframe se pide cuando abre su DataChannel o con
  // su primer RTCP (lo que llegue antes): uno pedido ahora (o al abrir la pista del lado del SFU) llega
  // antes de que el viewer tenga las claves SRTP, se pierde y el siguiente cae en la ventana de
  // PliThrottle (spike S2: TTFF 1.2 s -> 0.17 s). Chrome manda su primer RTCP ~2.5 s después de
  // conectar; su DataChannel abre enseguida (E2E R7).
  return true;
}

std::shared_ptr<Viewer> Room::remove_viewer(const std::string& viewer_id) {
  std::lock_guard lock(control_mu_);
  auto current = viewers();
  auto it = std::ranges::find_if(*current, [&](const auto& v) { return v->id() == viewer_id; });
  if (it == current->end()) return nullptr;
  auto removed = *it;
  removed->closed_.store(true);
  auto next = std::make_shared<ViewerList>();
  next->reserve(current->size() - 1);
  for (const auto& v : *current)
    if (v != removed) next->push_back(v);
  viewers_.store(std::move(next), std::memory_order_release);
  return removed;
}

int Room::viewer_count() const { return static_cast<int>(viewers()->size()); }

void Room::set_host_video(std::shared_ptr<HostSink> sink, int rid_extension_id,
                          std::vector<std::string> rids) {
  std::lock_guard lock(control_mu_);
  host_video_.store(
      std::make_shared<const HostVideo>(HostVideo{std::move(sink), rid_extension_id, std::move(rids)}));
  // El hilo de ingesta reinicia el demux y re-ancla a cada viewer al ver la nueva generación.
  video_generation_.fetch_add(1);
  for (auto& seen : layer_seen_) seen.store(false);
}

void Room::set_host_audio() { audio_generation_.fetch_add(1); }

void Room::clear_host_video() {
  std::lock_guard lock(control_mu_);
  host_video_.store(std::shared_ptr<const HostVideo>());
}

// --- Ingesta (hilo de la PeerConnection del host) ------------------------------------------

Room::Ingest Room::on_host_video(rtp::ByteView packet, std::int64_t now_ms) {
  auto host = host_video_.load();
  if (!host || ended_.load()) return {};
  const auto generation = video_generation_.load();
  if (generation != ingest_generation_ || !demux_) {
    ingest_generation_ = generation;
    demux_ = std::make_unique<SimulcastDemux>(host->rid_extension_id, host->rids);
    for (auto& n : nack_) n->clear();
  }
  auto view = rtp::parse_rtp(packet);
  if (!view) return {};
  auto layer = demux_->layer_of(packet, *view, now_ms);
  if (!layer) return {};
  host_ssrc_[*layer].store(view->ssrc);
  layer_seen_ms_[*layer].store(now_ms);
  layer_seen_[*layer].store(true);
  layer_bytes_[*layer].fetch_add(packet.size(), std::memory_order_relaxed);
  nack_[*layer]->store(view->seq, packet);

  auto vp8 = rtp::parse_vp8(packet.subspan(view->payload_offset, view->payload_size));
  const bool keyframe = vp8 && vp8->keyframe;

  // La instantánea vive en una variable: el temporal de *viewers() moriría antes del bucle.

  const auto snapshot = viewers();

  for (const auto& v : *snapshot) {
    if (v->closed_.load()) continue;
    if (v->video_generation_ != generation) {
      v->video_generation_ = generation;
      v->video_.resync();
    }
    v->video_.set_target(v->desired_layer());
    if (auto out = v->video_.rewrite(packet, *view, *layer, keyframe, now_ms))
      v->sink().send_video(std::move(*out));
    const int forwarding = v->video_.current().value_or(-1);
    if (forwarding != v->forwarding_.load(std::memory_order_relaxed))
      v->forwarding_.store(forwarding, std::memory_order_relaxed);
  }
  return {layer, keyframe};
}

void Room::on_host_audio(rtp::ByteView packet, std::int64_t now_ms) {
  if (ended_.load()) return;
  auto view = rtp::parse_rtp(packet);
  if (!view) return;
  const auto generation = audio_generation_.load();
  // La instantánea vive en una variable: el temporal de *viewers() moriría antes del bucle.

  const auto snapshot = viewers();

  for (const auto& v : *snapshot) {
    if (v->closed_.load()) continue;
    if (v->audio_generation_ != generation) {
      v->audio_generation_ = generation;
      v->audio_.resync();
    }
    if (auto out = v->audio_.rewrite(packet, *view, 0, false, now_ms)) v->sink().send_audio(std::move(*out));
  }
}

// --- RTCP de los viewers y evaluación de capas ---------------------------------------------

void Room::request_keyframe(int layer, std::int64_t now_ms) {
  auto host = host_video_.load();
  if (!host || !host->sink || layer < 0 || layer >= kLayers || !layer_seen_[layer].load()) return;
  if (!pli_.should_send(layer, now_ms)) return;
  plis_.fetch_add(1, std::memory_order_relaxed);
  host->sink->send_video_rtcp(rtp::build_pli(config_.server_ssrc, host_ssrc_[layer].load()));
}

void Room::apply_layer(Viewer& v, int layer, std::int64_t now_ms) {
  if (layer == v.desired_layer()) return;
  v.set_desired_layer(layer);
  request_keyframe(layer, now_ms);  // el cambio se aplica en el próximo keyframe de esa capa
}

std::array<bool, kLayers> Room::active_layers(std::int64_t now_ms) const {
  std::array<bool, kLayers> out{};
  for (int l = 0; l < kLayers; ++l)
    out[l] = layer_seen_[l].load() && now_ms - layer_seen_ms_[l].load() <= 1000;
  return out;
}

HostStats Room::host_stats(std::int64_t now_ms) {
  HostStats out;
  out.active = active_layers(now_ms);
  out.nacks = nacks_.load(std::memory_order_relaxed);
  out.plis = plis_.load(std::memory_order_relaxed);
  // La instantánea vive en una variable: el temporal de *viewers() moriría antes del bucle.
  const auto snapshot = viewers();
  for (const auto& v : *snapshot) {
    const int layer = v->desired_layer();
    if (layer >= 0 && layer < kLayers) ++out.viewers_per_layer[layer];
  }
  std::lock_guard lock(stats_mu_);
  for (int l = 0; l < kLayers; ++l) {
    const auto bytes = layer_bytes_[l].load(std::memory_order_relaxed);
    if (stats_ms_ && now_ms > *stats_ms_)
      out.bitrate_bps[l] =
          (bytes - stats_bytes_[l]) * 8 * 1000 / static_cast<std::uint64_t>(now_ms - *stats_ms_);
    stats_bytes_[l] = bytes;
  }
  stats_ms_ = now_ms;
  return out;
}

void Room::on_viewer_ready(const std::string& viewer_id, std::int64_t now_ms) {
  auto list = viewers();
  auto it = std::ranges::find_if(*list, [&](const auto& v) { return v->id() == viewer_id; });
  if (it == list->end()) return;
  if (!(*it)->ready_.exchange(true)) request_keyframe((*it)->desired_layer(), now_ms);
}

void Room::on_viewer_rtcp(const std::string& viewer_id, rtp::ByteView packet, std::int64_t now_ms) {
  auto list = viewers();
  auto it = std::ranges::find_if(*list, [&](const auto& v) { return v->id() == viewer_id; });
  if (it == list->end()) return;
  Viewer& v = **it;
  auto info = rtp::parse_rtcp(packet);
  if (!info) return;

  for (const auto& nack : info->nacks) {
    if (nack.media_ssrc != v.video_ssrc()) continue;
    nacks_.fetch_add(nack.sequences.size(), std::memory_order_relaxed);
    for (auto out_seq : nack.sequences) {
      auto source = v.video_.source_of(out_seq);
      if (!source) continue;
      auto stored = nack_[source->layer]->get(source->seq);
      if (!stored) continue;
      if (auto rtx = v.video_.retransmission(*stored, out_seq)) v.sink().send_video(std::move(*rtx));
    }
  }
  const bool first_signal = !v.ready_.exchange(true);
  if (first_signal || !info->keyframe_requests.empty()) request_keyframe(v.desired_layer(), now_ms);

  std::lock_guard lock(v.selector_mu_);
  int layer = v.selector_.layer();
  if (info->remb) layer = v.selector_.on_remb(info->remb->bitrate_bps, now_ms);
  for (const auto& report : info->reports)
    if (report.ssrc == v.video_ssrc()) layer = v.selector_.on_loss(report.fraction_lost, now_ms);
  apply_layer(v, layer, now_ms);
}

void Room::tick(std::int64_t now_ms) {
  const auto active = active_layers(now_ms);
  if (std::ranges::none_of(active, [](bool a) { return a; })) return;
  // La instantánea vive en una variable: el temporal de *viewers() moriría antes del bucle.

  const auto snapshot = viewers();

  for (const auto& v : *snapshot) {
    {
      std::lock_guard lock(v->selector_mu_);
      apply_layer(*v, v->selector_.on_tick(active, now_ms), now_ms);
    }
    // Un pedido de keyframe que PliThrottle descartó no se pierde: mientras un viewer listo no reciba
    // su capa, se vuelve a pedir (sigue limitado a 1 PLI por capa y por segundo).
    const int desired = v->desired_layer();
    if (v->ready_.load() && v->forwarding_.load(std::memory_order_relaxed) != desired)
      request_keyframe(desired, now_ms);
  }
}

// --- Avisos y cierre -----------------------------------------------------------------------

void Room::broadcast_event(const std::string& json) {
  // La instantánea vive en una variable: el temporal de *viewers() moriría antes del bucle.

  const auto snapshot = viewers();

  for (const auto& v : *snapshot)
    if (!v->closed_.load()) v->sink().send_event(json);
}

void Room::teardown(const std::string& final_event) {
  std::shared_ptr<const ViewerList> list;
  {
    std::lock_guard lock(control_mu_);
    if (ended_.exchange(true)) return;
    list = viewers();
    viewers_.store(std::make_shared<const ViewerList>(), std::memory_order_release);
    host_video_.store(std::shared_ptr<const HostVideo>());
  }
  for (const auto& v : *list) {
    v->closed_.store(true);
    if (!final_event.empty()) v->sink().send_event(final_event);
    v->sink().close();
  }
}

}  // namespace stream::sfu
