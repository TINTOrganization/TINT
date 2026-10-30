#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <vector>

namespace voice::domain {

// Una conexión dentro de la voz. peer_id identifica la conexión (un usuario puede
// abrir dos pestañas); user_id es el sub del token.
struct Member {
  std::string peer_id;
  std::string user_id;
  std::string nick;
  std::string role;
  std::string jti;
};

enum class JoinResult { Joined, Full, DuplicatePeer };

// Membresía de la voz de una sala, en orden de llegada y con cupo máximo (mesh P2P).
class VoiceRoom {
 public:
  explicit VoiceRoom(std::size_t max_members);

  JoinResult join(Member member);
  std::optional<Member> leave(const std::string& peer_id);
  const Member* find(const std::string& peer_id) const;
  std::vector<Member> members() const;
  std::vector<std::string> peers_with_jti(const std::string& jti) const;
  std::size_t size() const;
  bool empty() const;
  std::size_t max_members() const;

 private:
  std::size_t max_members_;
  std::vector<Member> members_;
};

}  // namespace voice::domain
