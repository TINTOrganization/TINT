#include "protocol/messages.hpp"

namespace voice::protocol {
namespace {

using nlohmann::json;

constexpr std::size_t kMaxIdLength = 64;

bool valid_id(const json& j, const char* key) {
  auto it = j.find(key);
  if (it == j.end() || !it->is_string()) return false;
  const auto& s = it->get_ref<const std::string&>();
  return !s.empty() && s.size() <= kMaxIdLength;
}

bool valid_time(const json& j) {
  auto it = j.find("occurred_at");
  return it != j.end() && it->is_number_integer();
}

json envelope(std::string_view type, const Envelope& env) {
  return {{"type", type},
          {"event_id", env.event_id},
          {"occurred_at", env.occurred_at},
          {"received_at", env.received_at}};
}

}  // namespace

std::string_view error_code(ProtocolError error) {
  switch (error) {
    case ProtocolError::TooLarge:
      return "MESSAGE_TOO_LARGE";
    case ProtocolError::UnknownType:
      return "UNKNOWN_TYPE";
    case ProtocolError::InvalidJson:
    case ProtocolError::InvalidField:
      return "INVALID_MESSAGE";
  }
  return "INVALID_MESSAGE";
}

std::expected<ClientMessage, ProtocolError> parse_client_message(std::string_view text) {
  if (text.size() > kMaxMessageBytes) return std::unexpected(ProtocolError::TooLarge);
  json j = json::parse(text, nullptr, /*allow_exceptions=*/false);
  if (!j.is_object()) return std::unexpected(ProtocolError::InvalidJson);

  auto type = j.find("type");
  if (type == j.end() || !type->is_string()) return std::unexpected(ProtocolError::UnknownType);
  const auto& t = type->get_ref<const std::string&>();

  if (t == "signal") {
    if (!valid_id(j, "event_id") || !valid_time(j) || !valid_id(j, "to"))
      return std::unexpected(ProtocolError::InvalidField);
    auto data = j.find("data");
    if (data == j.end() || !data->is_object()) return std::unexpected(ProtocolError::InvalidField);
    return SignalIn{j["event_id"], j["occurred_at"], j["to"], std::move(*data)};
  }
  if (t == "self_mute") {
    auto muted = j.find("muted");
    if (!valid_id(j, "event_id") || !valid_time(j) || muted == j.end() || !muted->is_boolean())
      return std::unexpected(ProtocolError::InvalidField);
    return SelfMuteIn{j["event_id"], j["occurred_at"], muted->get<bool>()};
  }
  if (t == "host_mute") {
    auto muted = j.find("muted");
    if (!valid_id(j, "event_id") || !valid_time(j) || !valid_id(j, "user_id") || muted == j.end() ||
        !muted->is_boolean())
      return std::unexpected(ProtocolError::InvalidField);
    return HostMuteIn{j["event_id"], j["occurred_at"], j["user_id"], muted->get<bool>()};
  }
  if (t == "leave") {
    if (!valid_id(j, "event_id") || !valid_time(j)) return std::unexpected(ProtocolError::InvalidField);
    return LeaveIn{j["event_id"], j["occurred_at"]};
  }
  return std::unexpected(ProtocolError::UnknownType);
}

json peer_json(const domain::Member& member) {
  return {{"peer_id", member.peer_id}, {"user_id", member.user_id}, {"nick", member.nick},
          {"role", member.role},       {"muted", member.muted},     {"host_muted", member.host_muted}};
}

std::string make_voice_state(const Envelope& env, const std::string& room_id, const domain::Member& self,
                             const std::vector<domain::Member>& others, const json& ice_servers,
                             std::size_t max_members) {
  json peers = json::array();
  for (const auto& m : others) peers.push_back(peer_json(m));
  json j = envelope("voice_state", env);
  j["room_id"] = room_id;
  j["self"] = peer_json(self);
  j["peers"] = std::move(peers);
  j["ice_servers"] = ice_servers;
  j["max_members"] = max_members;
  return j.dump();
}

std::string make_peer_joined(const Envelope& env, const std::string& room_id, const domain::Member& member) {
  json j = envelope("peer_joined", env);
  j["room_id"] = room_id;
  j["peer"] = peer_json(member);
  return j.dump();
}

std::string make_peer_left(const Envelope& env, const std::string& room_id, const std::string& peer_id) {
  json j = envelope("peer_left", env);
  j["room_id"] = room_id;
  j["peer_id"] = peer_id;
  return j.dump();
}

std::string make_signal(const Envelope& env, const std::string& room_id, const std::string& from,
                        const json& data) {
  json j = envelope("signal", env);
  j["room_id"] = room_id;
  j["from"] = from;
  j["data"] = data;
  return j.dump();
}

std::string make_peer_muted(const Envelope& env, const std::string& room_id, const domain::Member& member) {
  json j = envelope("peer_muted", env);
  j["room_id"] = room_id;
  j["peer_id"] = member.peer_id;
  j["user_id"] = member.user_id;
  j["muted"] = member.muted;
  j["host_muted"] = member.host_muted;
  return j.dump();
}

std::string make_error(const Envelope& env, std::string_view code, const std::string& event_id_ref) {
  json j = envelope("error", env);
  j["code"] = code;
  if (!event_id_ref.empty()) j["event_id_ref"] = event_id_ref;
  return j.dump();
}

}  // namespace voice::protocol
