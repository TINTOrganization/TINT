#include "auth/token_verifier.hpp"

#include <array>

#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <nlohmann/json.hpp>

#include "auth/base64url.hpp"

namespace voice::auth {
namespace {

using nlohmann::json;

std::optional<json> decode_object(std::string_view segment) {
  auto raw = base64url_decode(segment);
  if (!raw) return std::nullopt;
  json j = json::parse(*raw, nullptr, /*allow_exceptions=*/false);
  if (!j.is_object()) return std::nullopt;
  return j;
}

bool non_empty_string(const json& j, const char* key) {
  auto it = j.find(key);
  return it != j.end() && it->is_string() && !it->get_ref<const std::string&>().empty();
}

bool audience_matches(const json& aud, const std::string& expected) {
  if (aud.is_string()) return aud.get_ref<const std::string&>() == expected;
  for (const auto& item : aud)
    if (item.is_string() && item.get_ref<const std::string&>() == expected) return true;
  return false;
}

}  // namespace

std::string_view to_string(TokenError error) {
  switch (error) {
    case TokenError::Malformed:
      return "malformed token";
    case TokenError::UnsupportedAlgorithm:
      return "unsupported algorithm";
    case TokenError::BadSignature:
      return "bad signature";
    case TokenError::Expired:
      return "token expired";
    case TokenError::WrongIssuer:
      return "wrong issuer";
    case TokenError::WrongAudience:
      return "wrong audience";
    case TokenError::MissingClaim:
      return "missing claim";
    case TokenError::InvalidRole:
      return "invalid role";
  }
  return "unknown";
}

TokenVerifier::TokenVerifier(std::string secret, std::string issuer, std::string audience)
    : secret_(std::move(secret)), issuer_(std::move(issuer)), audience_(std::move(audience)) {}

std::expected<Claims, TokenError> TokenVerifier::verify(std::string_view token, std::int64_t now_s) const {
  const auto first = token.find('.');
  const auto last = token.rfind('.');
  if (first == std::string_view::npos || first == last || token.find('.', first + 1) != last)
    return std::unexpected(TokenError::Malformed);

  const std::string_view header_b64 = token.substr(0, first);
  const std::string_view payload_b64 = token.substr(first + 1, last - first - 1);
  const std::string_view signature_b64 = token.substr(last + 1);
  if (header_b64.empty() || payload_b64.empty() || signature_b64.empty())
    return std::unexpected(TokenError::Malformed);

  auto header = decode_object(header_b64);
  auto payload = decode_object(payload_b64);
  auto signature = base64url_decode(signature_b64);
  if (!header || !payload || !signature) return std::unexpected(TokenError::Malformed);

  // Solo HS256: rechaza "none" y la confusión de algoritmos.
  auto alg = header->find("alg");
  if (alg == header->end() || !alg->is_string() || alg->get_ref<const std::string&>() != "HS256")
    return std::unexpected(TokenError::UnsupportedAlgorithm);

  const std::string_view signing_input = token.substr(0, last);
  std::array<unsigned char, EVP_MAX_MD_SIZE> mac{};
  unsigned int mac_len = 0;
  HMAC(EVP_sha256(), secret_.data(), static_cast<int>(secret_.size()),
       reinterpret_cast<const unsigned char*>(signing_input.data()), signing_input.size(), mac.data(),
       &mac_len);
  if (signature->size() != mac_len || CRYPTO_memcmp(signature->data(), mac.data(), mac_len) != 0)
    return std::unexpected(TokenError::BadSignature);

  // A partir de aquí la firma es válida.
  const json& p = *payload;
  for (const char* key : {"sub", "room_id", "role", "jti", "iss"})
    if (!non_empty_string(p, key)) return std::unexpected(TokenError::MissingClaim);
  auto aud = p.find("aud");
  auto exp = p.find("exp");
  if (aud == p.end() || !(aud->is_string() || aud->is_array()))
    return std::unexpected(TokenError::MissingClaim);
  if (exp == p.end() || !exp->is_number()) return std::unexpected(TokenError::MissingClaim);

  if (p["iss"].get_ref<const std::string&>() != issuer_) return std::unexpected(TokenError::WrongIssuer);
  if (!audience_matches(*aud, audience_)) return std::unexpected(TokenError::WrongAudience);

  Claims claims;
  claims.exp = exp->get<std::int64_t>();
  if (claims.exp <= now_s) return std::unexpected(TokenError::Expired);

  claims.sub = p["sub"].get<std::string>();
  claims.room_id = p["room_id"].get<std::string>();
  claims.role = p["role"].get<std::string>();
  claims.jti = p["jti"].get<std::string>();
  if (auto nick = p.find("nick"); nick != p.end() && nick->is_string())
    claims.nick = nick->get<std::string>();
  if (claims.role != "host" && claims.role != "cohost" && claims.role != "participant")
    return std::unexpected(TokenError::InvalidRole);
  return claims;
}

}  // namespace voice::auth
