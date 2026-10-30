#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

#include "auth/token_verifier.hpp"
#include "domain/voice_room.hpp"

namespace voice::hub {

namespace close_code {
inline constexpr std::uint16_t kNormal = 1000;
inline constexpr std::uint16_t kRevoked = 4001;
inline constexpr std::uint16_t kExpired = 4003;
inline constexpr std::uint16_t kFull = 4008;
}  // namespace close_code

// Una conexión WebSocket vista desde el Hub. send y close deben ser asíncronos
// (encolar y volver): el Hub los llama con su mutex tomado. El Hub no es dueño
// del peer (guarda weak_ptr): lo mantiene vivo su conexión.
class Peer {
 public:
  virtual ~Peer() = default;
  virtual const std::string& id() const = 0;
  virtual void send(std::string text) = 0;
  virtual void close(std::uint16_t code, std::string reason) = 0;
};

struct HubOptions {
  std::size_t max_members = 8;
  // Genera la lista RTCIceServer que recibe cada cliente al unirse.
  std::function<nlohmann::json(const auth::Claims&)> ice_servers = [](const auth::Claims&) {
    return nlohmann::json::array();
  };
  std::function<std::int64_t()> now_ms;
  std::function<std::string()> new_event_id;
};

// Salas de voz, membresía y reenvío de la señalización WebRTC. Thread-safe.
class Hub {
 public:
  explicit Hub(HubOptions options);

  // Une al peer a la voz de la sala: le envía voice_state y avisa peer_joined a los demás.
  // Con la sala llena le envía error VOICE_FULL, lo cierra con 4008 y devuelve false.
  bool join(const std::string& room_id, const auth::Claims& claims, std::shared_ptr<Peer> peer);

  // Mensaje de texto recibido del peer.
  void handle_message(const std::string& room_id, const std::string& peer_id, std::string_view text);

  // El peer se desconectó (o pidió salir): los demás reciben peer_left. Idempotente.
  void leave(const std::string& room_id, const std::string& peer_id);

  // REVOKED de identity-api: cierra con 4001 las conexiones de ese jti en la sala.
  void revoke(const std::string& room_id, const std::string& jti);

  std::vector<domain::Member> members(const std::string& room_id) const;

 private:
  struct Room {
    explicit Room(std::size_t max) : voice(max) {}
    domain::VoiceRoom voice;
    std::map<std::string, std::weak_ptr<Peer>> peers;
  };

  void leave_locked(const std::string& room_id, const std::string& peer_id);
  void broadcast_locked(Room& room, const std::string& except_peer, const std::string& text);
  std::string error_locked(std::string_view code, const std::string& event_id_ref);

  HubOptions options_;
  mutable std::mutex mu_;
  std::map<std::string, Room> rooms_;
};

}  // namespace voice::hub
