#include "sdp/offer_inspect.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>

namespace stream::sdp {
namespace {

std::string lower(std::string_view s) {
  std::string out(s);
  std::ranges::transform(out, out.begin(), [](unsigned char c) { return std::tolower(c); });
  return out;
}

std::optional<int> parse_int(std::string_view s) {
  int value = 0;
  auto [ptr, ec] = std::from_chars(s.data(), s.data() + s.size(), value);
  if (ec != std::errc() || ptr != s.data() + s.size()) return std::nullopt;
  return value;
}

// "<a> <b>" -> (a, b); b puede estar vacío.
std::pair<std::string_view, std::string_view> split_first(std::string_view s, char sep = ' ') {
  auto pos = s.find(sep);
  if (pos == std::string_view::npos) return {s, {}};
  return {s.substr(0, pos), s.substr(pos + 1)};
}

void parse_attribute(std::string_view attr, MediaSection& m) {
  auto [name, value] = split_first(attr, ':');
  if (attr == "sendrecv")
    m.direction = Direction::SendRecv;
  else if (attr == "sendonly")
    m.direction = Direction::SendOnly;
  else if (attr == "recvonly")
    m.direction = Direction::RecvOnly;
  else if (attr == "inactive")
    m.direction = Direction::Inactive;
  else if (name == "mid")
    m.mid = std::string(value);
  else if (name == "rtpmap") {
    // a=rtpmap:<pt> <codec>/<clock>[/<canales>]
    auto [pt, encoding] = split_first(value);
    auto pt_value = parse_int(pt);
    auto codec = split_first(encoding, '/').first;
    if (pt_value && !codec.empty()) m.codecs[*pt_value] = lower(codec);
  } else if (name == "extmap") {
    // a=extmap:<id>[/<dirección>] <uri>
    auto [id, uri] = split_first(value);
    auto id_value = parse_int(split_first(id, '/').first);
    auto uri_only = split_first(uri).first;
    if (id_value && !uri_only.empty()) m.extmaps[std::string(uri_only)] = *id_value;
  } else if (name == "rid") {
    // a=rid:<id> <send|recv> [restricciones]
    auto [id, rest] = split_first(value);
    if (!id.empty() && split_first(rest).first == "send") m.send_rids.emplace_back(id);
  }
}

}  // namespace

std::optional<int> MediaSection::payload_type_of(std::string_view codec) const {
  const std::string wanted = lower(codec);
  for (const auto& [pt, name] : codecs)
    if (name == wanted) return pt;
  return std::nullopt;
}

const MediaSection* Offer::first(std::string_view kind) const {
  for (const auto& m : media)
    if (m.kind == kind) return &m;
  return nullptr;
}

int Offer::count(std::string_view kind) const {
  return static_cast<int>(
      std::ranges::count_if(media, [&](const MediaSection& m) { return m.kind == kind; }));
}

std::optional<Offer> parse_offer(std::string_view sdp) {
  Offer offer;
  bool saw_version = false;
  MediaSection* current = nullptr;
  std::size_t start = 0;
  while (start < sdp.size()) {
    auto end = sdp.find('\n', start);
    if (end == std::string_view::npos) end = sdp.size();
    std::string_view line = sdp.substr(start, end - start);
    if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
    start = end + 1;
    if (line.size() < 2 || line[1] != '=') continue;

    const char type = line[0];
    const std::string_view value = line.substr(2);
    if (!saw_version) {
      if (type != 'v' || value != "0") return std::nullopt;
      saw_version = true;
      continue;
    }
    if (type == 'm') {
      offer.media.push_back(MediaSection{});
      current = &offer.media.back();
      current->kind = std::string(split_first(value).first);
    } else if (type == 'a' && current) {
      parse_attribute(value, *current);
    }
  }
  if (!saw_version || offer.media.empty()) return std::nullopt;
  return offer;
}

}  // namespace stream::sdp
