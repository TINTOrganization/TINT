#include "hub/hub.hpp"

#include "protocol/messages.hpp"

namespace voice::hub {

using domain::JoinResult;
using domain::Member;
namespace proto = voice::protocol;

Hub::Hub(HubOptions options) : options_(std::move(options)) {}

bool Hub::join(const std::string& room_id, const auth::Claims& claims, std::shared_ptr<Peer> peer) {
  std::lock_guard lock(mu_);
  const auto now = options_.now_ms();
  auto [it, inserted] = rooms_.try_emplace(room_id, options_.max_members);
  Room& room = it->second;

  Member member{peer->id(), claims.sub, claims.nick, claims.role, claims.jti};
  auto others = room.voice.members();
  const auto result = room.voice.join(member);
  if (result != JoinResult::Joined) {
    const bool full = result == JoinResult::Full;
    peer->send(error_locked(full ? "VOICE_FULL" : "DUPLICATE_PEER", ""));
    peer->close(full ? close_code::kFull : close_code::kNormal, full ? "voice full" : "duplicate peer");
    if (room.voice.empty()) rooms_.erase(it);
    return false;
  }
  room.peers[member.peer_id] = peer;

  peer->send(proto::make_voice_state({options_.new_event_id(), now, now}, room_id, member, others,
                                     options_.ice_servers(claims), room.voice.max_members()));
  broadcast_locked(room, member.peer_id,
                   proto::make_peer_joined({options_.new_event_id(), now, now}, room_id, member));
  return true;
}

void Hub::handle_message(const std::string& room_id, const std::string& peer_id, std::string_view text) {
  std::lock_guard lock(mu_);
  auto room_it = rooms_.find(room_id);
  if (room_it == rooms_.end()) return;
  Room& room = room_it->second;
  auto peer_it = room.peers.find(peer_id);
  if (peer_it == room.peers.end()) return;
  auto peer = peer_it->second.lock();
  if (!peer) return;

  auto parsed = proto::parse_client_message(text);
  if (!parsed) {
    peer->send(error_locked(proto::error_code(parsed.error()), ""));
    return;
  }

  if (auto* signal = std::get_if<proto::SignalIn>(&*parsed)) {
    auto target = room.peers.find(signal->to);
    if (signal->to == peer_id || target == room.peers.end()) {
      peer->send(error_locked("PEER_NOT_FOUND", signal->event_id));
      return;
    }
    if (auto target_peer = target->second.lock())
      target_peer->send(proto::make_signal({signal->event_id, signal->occurred_at, options_.now_ms()},
                                           room_id, peer_id, signal->data));
    return;
  }

  // leave: el cliente sale de la voz a propósito.
  leave_locked(room_id, peer_id);
  peer->close(close_code::kNormal, "left voice");
}

void Hub::leave(const std::string& room_id, const std::string& peer_id) {
  std::lock_guard lock(mu_);
  leave_locked(room_id, peer_id);
}

void Hub::revoke(const std::string& room_id, const std::string& jti) {
  std::lock_guard lock(mu_);
  auto room_it = rooms_.find(room_id);
  if (room_it == rooms_.end()) return;
  for (const auto& peer_id : room_it->second.voice.peers_with_jti(jti)) {
    if (auto peer = room_it->second.peers.at(peer_id).lock())
      peer->close(close_code::kRevoked, "token revoked");
    leave_locked(room_id, peer_id);
    room_it = rooms_.find(room_id);
    if (room_it == rooms_.end()) return;
  }
}

std::vector<Member> Hub::members(const std::string& room_id) const {
  std::lock_guard lock(mu_);
  auto it = rooms_.find(room_id);
  return it == rooms_.end() ? std::vector<Member>{} : it->second.voice.members();
}

void Hub::leave_locked(const std::string& room_id, const std::string& peer_id) {
  auto room_it = rooms_.find(room_id);
  if (room_it == rooms_.end()) return;
  Room& room = room_it->second;
  if (!room.voice.leave(peer_id)) return;
  room.peers.erase(peer_id);
  const auto now = options_.now_ms();
  broadcast_locked(room, peer_id,
                   proto::make_peer_left({options_.new_event_id(), now, now}, room_id, peer_id));
  if (room.voice.empty()) rooms_.erase(room_it);
}

void Hub::broadcast_locked(Room& room, const std::string& except_peer, const std::string& text) {
  for (auto& [id, weak] : room.peers) {
    if (id == except_peer) continue;
    if (auto peer = weak.lock()) peer->send(text);
  }
}

std::string Hub::error_locked(std::string_view code, const std::string& event_id_ref) {
  const auto now = options_.now_ms();
  return proto::make_error({options_.new_event_id(), now, now}, code, event_id_ref);
}

}  // namespace voice::hub
