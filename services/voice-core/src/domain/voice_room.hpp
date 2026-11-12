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
  bool muted = false;       // silencio propio (o impuesto por el host)
  bool host_muted = false;  // silencio del host: no puede quitárselo
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
  // Silencio propio de una conexión. nullptr si no está en la voz.
  const Member* set_muted(const std::string& peer_id, bool muted);
  // Silencio del host sobre todas las conexiones del usuario; devuelve las que cambiaron.
  // Silenciar también pone muted; levantarlo no lo quita (el participante decide cuándo hablar).
  std::vector<Member> set_host_muted(const std::string& user_id, bool host_muted);
  std::size_t size() const;
  bool empty() const;
  std::size_t max_members() const;

 private:
  std::size_t max_members_;
  std::vector<Member> members_;
};

}  // namespace voice::domain
