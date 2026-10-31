#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace voice::auth {

// Base64url sin relleno (RFC 7515 §2), como lo usan los segmentos de un JWT.
std::string base64url_encode(std::string_view in);

// nullopt si hay caracteres fuera del alfabeto o una longitud imposible.
std::optional<std::string> base64url_decode(std::string_view in);

}  // namespace voice::auth
