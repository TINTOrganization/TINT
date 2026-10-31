#pragma once

#include <chrono>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace voice::ice {

// Credencial TURN efímera (REST API de TURN, la que coturn valida con use-auth-secret):
//   username   = "<expira_en_s>:<user_id>"
//   credential = base64(HMAC-SHA1(TURN_SECRET, username))
struct TurnCredential {
  std::string username;
  std::string credential;
};

TurnCredential make_turn_credential(std::string_view secret, std::string_view user_id,
                                    std::int64_t expires_at_s);

struct IceConfig {
  std::vector<std::string> stun_urls;
  std::vector<std::string> turn_urls;
  std::string turn_secret;
  std::chrono::seconds turn_ttl{3600};
};

// Lista RTCIceServer para un usuario: STUN sin credencial y TURN con una credencial
// propia que caduca en turn_ttl. El navegador prueba primero la ruta directa (host/STUN)
// y usa el relay TURN solo si no hay otra (HU-VOZ-05 AC1/AC2).
nlohmann::json make_ice_servers(const IceConfig& config, std::string_view user_id, std::int64_t now_s);

}  // namespace voice::ice
