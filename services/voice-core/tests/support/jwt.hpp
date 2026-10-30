#pragma once

// Firma tokens HS256 para las pruebas, igual que identity-api.
#include <string>
#include <string_view>

#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <nlohmann/json.hpp>

#include "auth/base64url.hpp"

namespace voice::testing {

inline constexpr const char* kSecret = "test-secret";
inline constexpr const char* kIssuer = "tint-identity";
inline constexpr const char* kAudience = "tint:room";
inline constexpr std::int64_t kNow = 1'800'000'000;

inline std::string sign_jwt(const nlohmann::json& payload, std::string_view secret = kSecret,
                            const nlohmann::json& header = {{"alg", "HS256"}, {"typ", "JWT"}}) {
  const std::string signing_input =
      auth::base64url_encode(header.dump()) + "." + auth::base64url_encode(payload.dump());
  unsigned char mac[EVP_MAX_MD_SIZE];
  unsigned int mac_len = 0;
  HMAC(EVP_sha256(), secret.data(), static_cast<int>(secret.size()),
       reinterpret_cast<const unsigned char*>(signing_input.data()), signing_input.size(), mac, &mac_len);
  return signing_input + "." +
         auth::base64url_encode(std::string_view(reinterpret_cast<const char*>(mac), mac_len));
}

inline nlohmann::json guest_claims(std::string room_id = "room-1", std::string sub = "guest:ana",
                                   std::string jti = "jti-ana", std::string nick = "Ana") {
  return {{"sub", sub},     {"room_id", room_id}, {"role", "participant"}, {"nick", nick},      {"jti", jti},
          {"iss", kIssuer}, {"aud", kAudience},   {"iat", kNow - 10},      {"exp", kNow + 3600}};
}

inline nlohmann::json host_claims(std::string room_id = "room-1") {
  auto c = guest_claims(room_id, "user-host", "jti-host", "Host");
  c["role"] = "host";
  return c;
}

}  // namespace voice::testing
