#pragma once

#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace stream::sdp {

enum class Direction { SendRecv, SendOnly, RecvOnly, Inactive };

// Una sección m= de la oferta, con lo que el SFU necesita para validarla y responderla.
struct MediaSection {
  std::string kind;  // "video" | "audio" | "application"
  std::string mid;
  Direction direction = Direction::SendRecv;
  std::map<int, std::string> codecs;   // payload type -> nombre en minúsculas ("vp8", "opus")
  std::map<std::string, int> extmaps;  // URI -> id
  std::vector<std::string> send_rids;  // a=rid:<id> send
  std::optional<int> payload_type_of(std::string_view codec) const;
};

struct Offer {
  std::vector<MediaSection> media;

  const MediaSection* first(std::string_view kind) const;
  int count(std::string_view kind) const;
};

// Parseo defensivo de una oferta SDP. nullopt si no empieza por "v=0" o no tiene ninguna m=.
std::optional<Offer> parse_offer(std::string_view sdp);

inline constexpr std::string_view kRidExtension = "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id";
inline constexpr std::string_view kMidExtension = "urn:ietf:params:rtp-hdrext:sdes:mid";
inline constexpr std::string_view kAbsSendTimeExtension =
    "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time";

}  // namespace stream::sdp
