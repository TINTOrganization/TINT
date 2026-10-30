#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

#include "domain/voice_room.hpp"

namespace voice::protocol {

inline constexpr std::size_t kMaxMessageBytes = 64 * 1024;

// Cliente -> servidor. `data` (SDP o candidato ICE) es opaco para el servidor.
struct SignalIn {
  std::string event_id;
  std::int64_t occurred_at = 0;
  std::string to;
  nlohmann::json data;
};

struct LeaveIn {
  std::string event_id;
  std::int64_t occurred_at = 0;
};

using ClientMessage = std::variant<SignalIn, LeaveIn>;

enum class ProtocolError { TooLarge, InvalidJson, UnknownType, InvalidField };

std::string_view error_code(ProtocolError error);

std::expected<ClientMessage, ProtocolError> parse_client_message(std::string_view text);

// Metadatos obligatorios de todo evento (dos relojes, ver Documento General §1.2).
struct Envelope {
  std::string event_id;
  std::int64_t occurred_at = 0;
  std::int64_t received_at = 0;
};

// Lo que los demás ven de un miembro: nunca el jti.
nlohmann::json peer_json(const domain::Member& member);

std::string make_voice_state(const Envelope& env, const std::string& room_id, const domain::Member& self,
                             const std::vector<domain::Member>& others, const nlohmann::json& ice_servers,
                             std::size_t max_members);
std::string make_peer_joined(const Envelope& env, const std::string& room_id, const domain::Member& member);
std::string make_peer_left(const Envelope& env, const std::string& room_id, const std::string& peer_id);
std::string make_signal(const Envelope& env, const std::string& room_id, const std::string& from,
                        const nlohmann::json& data);
std::string make_error(const Envelope& env, std::string_view code, const std::string& event_id_ref);

}  // namespace voice::protocol
