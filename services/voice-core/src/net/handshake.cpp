#include "net/handshake.hpp"

#include <algorithm>
#include <cctype>

namespace voice::net {
namespace {

int hex_value(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

std::string url_decode(std::string_view in) {
  std::string out;
  out.reserve(in.size());
  for (std::size_t i = 0; i < in.size(); ++i) {
    if (in[i] == '+') {
      out.push_back(' ');
    } else if (in[i] == '%' && i + 2 < in.size() && hex_value(in[i + 1]) >= 0 && hex_value(in[i + 2]) >= 0) {
      out.push_back(static_cast<char>(hex_value(in[i + 1]) * 16 + hex_value(in[i + 2])));
      i += 2;
    } else {
      out.push_back(in[i]);
    }
  }
  return out;
}

std::string lower(std::string_view s) {
  std::string out(s);
  std::ranges::transform(out, out.begin(),
                         [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return out;
}

}  // namespace

std::string_view target_path(std::string_view target) { return target.substr(0, target.find('?')); }

std::map<std::string, std::string> parse_query(std::string_view target) {
  std::map<std::string, std::string> out;
  auto q = target.find('?');
  if (q == std::string_view::npos) return out;
  std::string_view query = target.substr(q + 1);
  while (!query.empty()) {
    auto amp = query.find('&');
    std::string_view pair = query.substr(0, amp);
    auto eq = pair.find('=');
    if (!pair.empty())
      out[url_decode(pair.substr(0, eq))] =
          eq == std::string_view::npos ? "" : url_decode(pair.substr(eq + 1));
    if (amp == std::string_view::npos) break;
    query.remove_prefix(amp + 1);
  }
  return out;
}

bool origin_allowed(std::string_view origin, const std::vector<std::string>& allowed) {
  auto scheme = origin.find("://");
  if (scheme == std::string_view::npos) return false;
  const std::string host = lower(origin.substr(scheme + 3));
  if (host.empty()) return false;
  return std::ranges::any_of(allowed, [&](const std::string& a) { return lower(a) == host; });
}

HandshakeDecision decide_handshake(const HandshakeRequest& request, const auth::TokenVerifier& verifier,
                                   RevocationChecker& revocation,
                                   const std::vector<std::string>& allowed_origins, std::int64_t now_s) {
  if (target_path(request.target) != kVoicePath) return Reject{404, "not found"};
  // Sin Origin no es un navegador (no hay CSWSH posible); con Origin debe estar permitido.
  if (request.origin && !origin_allowed(*request.origin, allowed_origins))
    return Reject{403, "origin not allowed"};

  auto query = parse_query(request.target);
  auto room = query.find("room_id");
  auto token = query.find("token");
  if (room == query.end() || room->second.empty() || token == query.end() || token->second.empty())
    return Reject{400, "room_id and token are required"};

  auto claims = verifier.verify(token->second, now_s);
  if (!claims) {
    if (claims.error() == auth::TokenError::Expired) return AcceptThenClose{4003, "token expired"};
    return Reject{401, "invalid token"};
  }
  if (claims->room_id != room->second) return Reject{403, "token is for another room"};

  auto revoked = revocation.is_revoked(claims->jti);
  if (!revoked) return Reject{503, "revocation store unavailable"};
  if (*revoked) return AcceptThenClose{4001, "token revoked"};
  return Accept{room->second, std::move(*claims)};
}

}  // namespace voice::net
