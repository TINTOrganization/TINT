#include "domain/voice_room.hpp"

#include <algorithm>

namespace voice::domain {

VoiceRoom::VoiceRoom(std::size_t max_members) : max_members_(max_members) {}

JoinResult VoiceRoom::join(Member member) {
  if (find(member.peer_id)) return JoinResult::DuplicatePeer;
  if (members_.size() >= max_members_) return JoinResult::Full;
  members_.push_back(std::move(member));
  return JoinResult::Joined;
}

std::optional<Member> VoiceRoom::leave(const std::string& peer_id) {
  auto it = std::ranges::find(members_, peer_id, &Member::peer_id);
  if (it == members_.end()) return std::nullopt;
  Member left = std::move(*it);
  members_.erase(it);
  return left;
}

const Member* VoiceRoom::find(const std::string& peer_id) const {
  auto it = std::ranges::find(members_, peer_id, &Member::peer_id);
  return it == members_.end() ? nullptr : &*it;
}

std::vector<Member> VoiceRoom::members() const { return members_; }

std::vector<std::string> VoiceRoom::peers_with_jti(const std::string& jti) const {
  std::vector<std::string> out;
  for (const auto& m : members_)
    if (m.jti == jti) out.push_back(m.peer_id);
  return out;
}

std::size_t VoiceRoom::size() const { return members_.size(); }
bool VoiceRoom::empty() const { return members_.empty(); }
std::size_t VoiceRoom::max_members() const { return max_members_; }

}  // namespace voice::domain
