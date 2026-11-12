#include "ice/ice_servers.hpp"

#include <openssl/evp.h>
#include <openssl/hmac.h>

namespace voice::ice {

TurnCredential make_turn_credential(std::string_view secret, std::string_view user_id,
                                    std::int64_t expires_at_s) {
  std::string username = std::to_string(expires_at_s) + ":" + std::string(user_id);
  unsigned char mac[EVP_MAX_MD_SIZE];
  unsigned int mac_len = 0;
  HMAC(EVP_sha1(), secret.data(), static_cast<int>(secret.size()),
       reinterpret_cast<const unsigned char*>(username.data()), username.size(), mac, &mac_len);
  // base64 estándar (con relleno), no base64url: es lo que espera coturn.
  std::string credential(4 * ((mac_len + 2) / 3), '\0');
  const int written =
      EVP_EncodeBlock(reinterpret_cast<unsigned char*>(credential.data()), mac, static_cast<int>(mac_len));
  credential.resize(static_cast<std::size_t>(written));
  return {std::move(username), std::move(credential)};
}

nlohmann::json make_ice_servers(const IceConfig& config, std::string_view user_id, std::int64_t now_s) {
  nlohmann::json servers = nlohmann::json::array();
  if (!config.stun_urls.empty()) servers.push_back({{"urls", config.stun_urls}});
  if (!config.turn_urls.empty() && !config.turn_secret.empty()) {
    auto cred = make_turn_credential(config.turn_secret, user_id, now_s + config.turn_ttl.count());
    servers.push_back(
        {{"urls", config.turn_urls}, {"username", cred.username}, {"credential", cred.credential}});
  }
  return servers;
}

}  // namespace voice::ice
