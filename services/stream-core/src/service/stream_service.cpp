#include "service/stream_service.hpp"

#include <random>
#include <vector>

#include "events/messages.hpp"
#include "rtp/vp8.hpp"
#include "sdp/offer_inspect.hpp"
#include "util/uuid.hpp"

namespace stream::service {
namespace {

http::Problem disabled() { return {410, "ROOM_DISABLED", "El evento terminó y la sala fue deshabilitada."}; }

std::uint32_t random_u32() {
  thread_local std::mt19937 rng{std::random_device{}()};
  return std::uniform_int_distribution<std::uint32_t>(1, 0xFFFFFFF0u)(rng);
}

std::string end_reason(sfu::EndReason r) {
  return std::string(sfu::to_string(r == sfu::EndReason::None ? sfu::EndReason::HostEnded : r));
}

}  // namespace

StreamService::StreamService(ServiceConfig config, PeerFactory& peers, RoomStore& store,
                             IdentityClient& identity, Clock clock, Async async)
    : config_(config),
      peers_(peers),
      store_(store),
      identity_(identity),
      clock_(std::move(clock)),
      async_(std::move(async)) {}

std::string StreamService::new_id() { return util::new_uuid(); }

std::shared_ptr<StreamService::RoomEntry> StreamService::entry(const std::string& room_id, bool create) {
  std::lock_guard lock(mu_);
  auto it = rooms_.find(room_id);
  if (it != rooms_.end()) return it->second;
  if (!create) return nullptr;
  auto e = std::make_shared<RoomEntry>(room_id, config_);
  rooms_.emplace(room_id, e);
  return e;
}

// --- Efectos de la máquina de estados -------------------------------------------------------

void StreamService::apply(const std::shared_ptr<RoomEntry>& e, const sfu::Effects& effects,
                          std::int64_t now) {
  const std::string room_id = e->room.id();
  if (effects.publish_stream_started) store_.publish_started(room_id, now);
  // request_keyframe: un host nuevo envía un keyframe por capa al arrancar su codificador, y cada
  // viewer pide el suyo (PLI limitado) al entrar o al cambiar de capa; no hace falta más aquí.
  sfu::State state;
  std::optional<std::int64_t> deadline;
  sfu::EndReason reason;
  {
    std::lock_guard lock(e->state_mu);
    state = e->state.state();
    deadline = e->state.grace_deadline_ms();
    reason = e->state.end_reason();
  }
  if (effects.notify_state && !effects.teardown)
    e->room.broadcast_event(events::stream_state(state, deadline));
  if (effects.request_disable)
    async_([this, room_id] {
      // Si identity-api no responde, la sala igual termina aquí; ROOM_CLOSED llegará cuando se deshabilite.
      identity_.disable_room(room_id, "grace_expired");
    });
  if (effects.teardown) teardown(e, end_reason(reason));
}

void StreamService::teardown(const std::shared_ptr<RoomEntry>& e, const std::string& reason) {
  e->room.teardown(events::stream_state(sfu::State::Ended, std::nullopt, reason));
  std::vector<std::shared_ptr<Peer>> to_close;
  {
    std::lock_guard lock(mu_);
    for (auto it = sessions_.begin(); it != sessions_.end();) {
      if (it->second.room_id == e->room.id()) {
        to_close.push_back(it->second.peer);
        it = sessions_.erase(it);
      } else {
        ++it;
      }
    }
  }
  for (auto& p : to_close) p->close();
  e->host_video.reset();
  e->host_audio.reset();
  store_.publish_ended(e->room.id(), reason);
}

// --- Host --------------------------------------------------------------------------------

void StreamService::on_host_rtp(const std::shared_ptr<RoomEntry>& e, PeerRole role, rtp::ByteView packet) {
  const auto now = clock_();
  if (role == PeerRole::HostAudio) {
    e->room.on_host_audio(packet, now);
    return;
  }
  auto ingest = e->room.on_host_video(packet, now);
  if (!ingest.layer) return;
  // La máquina de estados solo necesita los keyframes y un latido cada 250 ms (watchdog).
  if (!ingest.keyframe && now - e->last_state_rtp_ms.load() < 250) return;
  e->last_state_rtp_ms.store(now);
  sfu::Effects effects;
  {
    std::lock_guard lock(e->state_mu);
    effects = e->state.on_host_rtp(now, ingest.keyframe);
  }
  apply(e, effects, now);
}

void StreamService::on_host_closed(const std::shared_ptr<RoomEntry>& e, const std::string& session_id) {
  {
    std::lock_guard lock(mu_);
    // Solo cuenta si es la sesión de vídeo vigente (no una reemplazada por un nuevo WHIP).
    if (e->host_video_session != session_id) {
      sessions_.erase(session_id);
      return;
    }
    sessions_.erase(session_id);
  }
  const auto now = clock_();
  sfu::Effects effects;
  {
    std::lock_guard lock(e->state_mu);
    effects = e->state.on_host_lost(now);
  }
  apply(e, effects, now);
}

std::expected<SessionAnswer, http::Problem> StreamService::publish(const http::WhipCommand& cmd) {
  auto e = entry(cmd.room_id, /*create=*/true);
  if (e->room.ended()) return std::unexpected(disabled());
  auto offer = sdp::parse_offer(cmd.sdp);
  if (!offer) return std::unexpected(http::Problem{400, "INVALID_SDP", "La oferta SDP no se pudo leer."});

  const auto role = cmd.media == http::PublishMedia::Video ? PeerRole::HostVideo : PeerRole::HostAudio;
  const std::string session_id = new_id();
  std::weak_ptr<RoomEntry> weak = e;
  PeerCallbacks callbacks{.on_rtp =
                              [this, weak, role](rtp::ByteView p) {
                                if (auto e = weak.lock()) on_host_rtp(e, role, p);
                              },
                          .on_rtcp = {},
                          .on_message =
                              [this, weak](const std::string& text) {
                                auto e = weak.lock();
                                if (!e) return;
                                if (auto name = events::parse_scene_request(text)) {
                                  {
                                    std::lock_guard lock(mu_);
                                    e->scene = *name;
                                  }
                                  e->room.broadcast_event(events::scene(*name));
                                }
                              },
                          .on_closed =
                              [this, weak, session_id, role] {
                                auto e = weak.lock();
                                if (!e) return;
                                if (role == PeerRole::HostVideo)
                                  on_host_closed(e, session_id);
                                else
                                  remove_session(session_id);
                              },
                          .on_open = {}};

  auto peer = peers_.create({role, session_id, cmd.sdp, {}}, std::move(callbacks));
  if (!peer) return std::unexpected(peer.error());

  const auto now = clock_();
  sfu::Effects effects;
  if (role == PeerRole::HostVideo) {
    std::lock_guard lock(e->state_mu);
    effects = e->state.on_host_publish(now);
    if (effects.rejected) {
      (*peer)->close();
      return std::unexpected(disabled());
    }
  }

  std::shared_ptr<Peer> replaced;
  std::string replaced_session;
  {
    std::lock_guard lock(mu_);
    sessions_[session_id] = {session_id, cmd.room_id, cmd.claims.sub, cmd.claims.jti, role, *peer};
    auto& slot = role == PeerRole::HostVideo ? e->host_video : e->host_audio;
    auto& slot_session = role == PeerRole::HostVideo ? e->host_video_session : e->host_audio_session;
    replaced = slot;
    replaced_session = slot_session;
    slot = *peer;
    slot_session = session_id;
    if (!replaced_session.empty()) sessions_.erase(replaced_session);
  }
  if (replaced) replaced->close();  // recarga de pestaña: el WHIP nuevo reemplaza al viejo

  if (role == PeerRole::HostVideo) {
    const auto* video = offer->first("video");
    const int rid_ext = video && video->extmaps.contains(std::string(sdp::kRidExtension))
                            ? video->extmaps.at(std::string(sdp::kRidExtension))
                            : 0;
    e->room.set_host_video(*peer, rid_ext, video ? video->send_rids : std::vector<std::string>{});
  } else {
    e->room.set_host_audio();
  }
  apply(e, effects, now);
  return SessionAnswer{session_id, (*peer)->answer_sdp()};
}

// --- Viewers -------------------------------------------------------------------------------

std::expected<SessionAnswer, http::Problem> StreamService::watch(const http::WhepCommand& cmd) {
  auto e = entry(cmd.room_id, /*create=*/true);
  if (e->room.ended()) return std::unexpected(disabled());
  if (e->room.viewer_count() >= config_.max_viewers)
    return std::unexpected(http::Problem{409, "ROOM_FULL", "La sala está llena; intenta más tarde."});
  auto offer = sdp::parse_offer(cmd.sdp);
  const auto* video = offer ? offer->first("video") : nullptr;
  const auto* audio = offer ? offer->first("audio") : nullptr;
  if (!video || !video->payload_type_of("vp8"))
    return std::unexpected(http::Problem{400, "INVALID_SDP", "La oferta debe aceptar VP8."});

  sfu::ViewerOptions options;
  options.video_ssrc = random_u32();
  options.audio_ssrc = options.video_ssrc + 1;
  options.video_payload_type = static_cast<std::uint8_t>(*video->payload_type_of("vp8"));
  options.audio_payload_type = static_cast<std::uint8_t>(
      audio && audio->payload_type_of("opus") ? *audio->payload_type_of("opus") : 111);
  options.first_video_seq = static_cast<std::uint16_t>(random_u32());
  options.first_audio_seq = static_cast<std::uint16_t>(random_u32());
  options.first_video_ts = random_u32();
  options.first_audio_ts = random_u32();
  if (auto abs = video->extmaps.find(std::string(sdp::kAbsSendTimeExtension)); abs != video->extmaps.end())
    options.video_extensions = {{abs->second, abs->second}};

  const std::string session_id = new_id();
  std::weak_ptr<RoomEntry> weak = e;
  PeerCallbacks callbacks{.on_rtp = {},
                          .on_rtcp =
                              [this, weak, session_id](rtp::ByteView p) {
                                if (auto e = weak.lock()) e->room.on_viewer_rtcp(session_id, p, clock_());
                              },
                          .on_message = {},
                          .on_closed = [this, session_id] { remove_session(session_id); },
                          .on_open =
                              [this, weak, session_id] {
                                if (auto e = weak.lock()) e->room.on_viewer_ready(session_id, clock_());
                              }};
  auto peer = peers_.create({PeerRole::Viewer, session_id, cmd.sdp, options}, std::move(callbacks));
  if (!peer) return std::unexpected(peer.error());

  auto viewer = std::make_shared<sfu::Viewer>(session_id, cmd.claims.sub, options, *peer);
  if (!e->room.add_viewer(viewer, clock_())) {
    (*peer)->close();
    if (e->room.ended()) return std::unexpected(disabled());
    return std::unexpected(http::Problem{409, "ROOM_FULL", "La sala está llena; intenta más tarde."});
  }
  std::string scene;
  {
    std::lock_guard lock(mu_);
    sessions_[session_id] = {session_id,     cmd.room_id,      cmd.claims.sub,
                             cmd.claims.jti, PeerRole::Viewer, *peer};
    scene = e->scene;
  }
  sfu::State state;
  std::optional<std::int64_t> deadline;
  {
    std::lock_guard lock(e->state_mu);
    state = e->state.state();
    deadline = e->state.grace_deadline_ms();
  }
  (*peer)->send_event(events::stream_state(state, deadline));
  if (scene != "live") (*peer)->send_event(events::scene(scene));
  return SessionAnswer{session_id, (*peer)->answer_sdp()};
}

void StreamService::remove_session(const std::string& session_id) {
  std::optional<Session> s;
  {
    std::lock_guard lock(mu_);
    auto it = sessions_.find(session_id);
    if (it == sessions_.end()) return;
    s = it->second;
    sessions_.erase(it);
  }
  if (s->role == PeerRole::Viewer)
    if (auto e = entry(s->room_id, false)) e->room.remove_viewer(session_id);
  s->peer->close();
}

std::optional<http::Problem> StreamService::trickle(const http::PatchCommand& cmd) {
  std::shared_ptr<Peer> peer;
  {
    std::lock_guard lock(mu_);
    auto it = sessions_.find(cmd.session_id);
    if (it == sessions_.end())
      return http::Problem{404, "SESSION_NOT_FOUND", "La sesión no existe o ya terminó."};
    peer = it->second.peer;
  }
  peer->add_remote_candidates(cmd.fragment);
  return std::nullopt;
}

void StreamService::end_session(const http::DeleteCommand& cmd) {
  std::optional<Session> s;
  {
    std::lock_guard lock(mu_);
    auto it = sessions_.find(cmd.session_id);
    if (it == sessions_.end()) return;
    s = it->second;
  }
  if (s->role == PeerRole::HostVideo) {
    s->peer->close();
    if (auto e = entry(s->room_id, false)) on_host_closed(e, s->id);
    return;
  }
  remove_session(cmd.session_id);
}

// --- Eventos de identity-api y temporizador ------------------------------------------------

bool StreamService::events_start(const std::string& room_id) { return store_.enable(room_id); }

bool StreamService::events_stop(const std::string& room_id) {
  const bool ok = store_.disable(room_id);
  if (auto e = entry(room_id, false)) {
    sfu::Effects effects;
    {
      std::lock_guard lock(e->state_mu);
      effects = e->state.on_room_closed();
    }
    apply(e, effects, clock_());
  }
  return ok;
}

void StreamService::on_room_closed(const std::string& room_id, sfu::EndReason reason) {
  auto e = entry(room_id, /*create=*/true);  // aunque nadie esté conectado, la sala queda Ended
  sfu::Effects effects;
  {
    std::lock_guard lock(e->state_mu);
    effects = e->state.on_room_closed(reason);
  }
  if (effects.teardown)
    apply(e, effects, clock_());
  else
    e->room.teardown({});
}

void StreamService::on_revoked(const std::string& jti) {
  std::vector<std::string> ids;
  {
    std::lock_guard lock(mu_);
    for (const auto& [id, s] : sessions_)
      if (s.jti == jti) ids.push_back(id);
  }
  for (const auto& id : ids) remove_session(id);
}

void StreamService::tick() {
  const auto now = clock_();
  std::vector<std::shared_ptr<RoomEntry>> rooms;
  {
    std::lock_guard lock(mu_);
    for (const auto& [_, e] : rooms_) rooms.push_back(e);
  }
  for (const auto& e : rooms) {
    if (e->room.ended()) continue;
    sfu::Effects effects;
    {
      std::lock_guard lock(e->state_mu);
      effects = e->state.on_tick(now);
    }
    apply(e, effects, now);
    if (e->room.ended()) continue;
    e->room.tick(now);
    const int count = e->room.viewer_count();
    if (count != e->last_viewer_count) {
      e->last_viewer_count = count;
      e->room.broadcast_event(events::viewer_count(count));
    }
    if (now - e->last_host_stats_ms >= 1000) {  // host_stats a 1 Hz, solo al host (§4)
      e->last_host_stats_ms = now;
      std::shared_ptr<Peer> host;
      {
        std::lock_guard lock(mu_);
        host = e->host_video;
      }
      const auto stats = e->room.host_stats(now);
      if (host) host->send_event(events::host_stats(stats));
    }
  }
}

// --- http::SessionLookup -------------------------------------------------------------------

std::optional<http::SessionInfo> StreamService::session(const std::string& session_id) {
  std::lock_guard lock(mu_);
  auto it = sessions_.find(session_id);
  if (it == sessions_.end()) return std::nullopt;
  return http::SessionInfo{it->second.room_id, it->second.sub, it->second.peer->remote_ufrag()};
}

int StreamService::viewer_count(const std::string& room_id) {
  auto e = entry(room_id, false);
  return e ? e->room.viewer_count() : 0;
}

std::optional<sfu::State> StreamService::state_of(const std::string& room_id) {
  auto e = entry(room_id, false);
  if (!e) return std::nullopt;
  std::lock_guard lock(e->state_mu);
  return e->state.state();
}

}  // namespace stream::service
