#include "sdp/munge.hpp"

#include <map>
#include <set>
#include <sstream>
#include <vector>

#include "sdp/offer_inspect.hpp"

namespace stream::sdp {
namespace {

std::vector<std::string> lines_of(std::string_view sdp) {
  std::vector<std::string> out;
  std::size_t start = 0;
  while (start < sdp.size()) {
    auto end = sdp.find('\n', start);
    if (end == std::string_view::npos) end = sdp.size();
    std::string_view line = sdp.substr(start, end - start);
    if (!line.empty() && line.back() == '\r') line.remove_suffix(1);
    out.emplace_back(line);
    start = end + 1;
  }
  return out;
}

std::string join(const std::vector<std::string>& lines) {
  std::string out;
  for (const auto& l : lines) out += l + "\r\n";
  return out;
}

// "a=rtpmap:96 ...", "a=fmtp:96 ...", "a=rtcp-fb:96 ..." -> 96
std::optional<int> attribute_pt(const std::string& line) {
  for (std::string_view prefix : {"a=rtpmap:", "a=fmtp:", "a=rtcp-fb:"}) {
    if (!line.starts_with(prefix)) continue;
    auto rest = std::string_view(line).substr(prefix.size());
    auto space = rest.find(' ');
    try {
      return std::stoi(std::string(rest.substr(0, space)));
    } catch (...) {
      return std::nullopt;
    }
  }
  return std::nullopt;
}

std::vector<std::string> split_words(const std::string& s) {
  std::istringstream in(s);
  std::vector<std::string> out;
  for (std::string w; in >> w;) out.push_back(w);
  return out;
}

}  // namespace

std::string sanitize_offer(std::string_view offer) {
  auto parsed = parse_offer(offer);
  auto lines = lines_of(offer);
  if (!parsed) return std::string(offer);

  std::vector<std::string> out;
  std::size_t media_index = 0;
  std::set<int> keep;
  bool in_media = false;
  for (const auto& line : lines) {
    if (line.starts_with("m=")) {
      in_media = true;
      const auto& m = parsed->media[media_index++];
      keep.clear();
      std::optional<int> pt;
      if (m.kind == "video") pt = m.payload_type_of("vp8");
      if (m.kind == "audio") pt = m.payload_type_of("opus");
      if (m.kind == "application" || !pt) {
        out.push_back(line);
        keep.insert(-1);  // sin filtro
        continue;
      }
      keep.insert(*pt);
      auto words = split_words(line);  // m=<kind> <port> <proto> <pts...>
      std::string rebuilt;
      for (std::size_t i = 0; i < words.size() && i < 3; ++i) rebuilt += (i ? " " : "") + words[i];
      out.push_back(rebuilt + " " + std::to_string(*pt));
      continue;
    }
    if (in_media && !keep.contains(-1)) {
      if (auto pt = attribute_pt(line); pt && !keep.contains(*pt)) continue;
      if (line.find("transport-cc") != std::string::npos) continue;
      if (line.starts_with("a=extmap:") && line.find("transport-wide-cc") != std::string::npos) continue;
      if (line.starts_with("a=ssrc-group:FID")) continue;
    }
    out.push_back(line);
  }
  return join(out);
}

std::string fix_simulcast_answer(std::string_view answer) {
  auto lines = lines_of(answer);
  std::vector<std::string> out;
  bool simulcast_seen = false;
  for (auto line : lines) {
    if (line.starts_with("m=")) simulcast_seen = false;
    if (line.starts_with("a=rid:")) {
      auto pos = line.find(" send");
      if (pos != std::string::npos) line.replace(pos, 5, " recv");
    } else if (line.starts_with("a=simulcast:")) {
      if (simulcast_seen) continue;
      simulcast_seen = true;
      if (line.starts_with("a=simulcast:send")) line.replace(0, 16, "a=simulcast:recv");
    }
    out.push_back(line);
  }
  return join(out);
}

std::string rewrite_host_candidates(std::string_view sdp, std::string_view public_ip) {
  if (public_ip.empty()) return std::string(sdp);
  auto lines = lines_of(sdp);
  for (auto& line : lines) {
    const bool candidate = line.starts_with("a=candidate:") || line.starts_with("candidate:");
    if (!candidate || line.find(" typ host") == std::string::npos) continue;
    auto words = split_words(line);  // foundation comp proto prio ADDR port typ host ...
    if (words.size() < 8) continue;
    words[4] = std::string(public_ip);
    std::string rebuilt;
    for (std::size_t i = 0; i < words.size(); ++i) rebuilt += (i ? " " : "") + words[i];
    line = rebuilt;
  }
  return join(lines);
}

std::string add_start_bitrate(std::string_view answer, int kbps) {
  auto lines = lines_of(answer);
  const std::string param = "x-google-start-bitrate=" + std::to_string(kbps);
  std::set<int> vp8;
  for (const auto& l : lines)
    if (l.starts_with("a=rtpmap:") &&
        (l.find(" VP8/") != std::string::npos || l.find(" vp8/") != std::string::npos))
      if (auto pt = attribute_pt(l)) vp8.insert(*pt);
  std::set<int> has_fmtp;
  for (auto& l : lines)
    if (l.starts_with("a=fmtp:"))
      if (auto pt = attribute_pt(l); pt && vp8.contains(*pt)) {
        has_fmtp.insert(*pt);
        if (l.find("x-google-start-bitrate") == std::string::npos) l += ";" + param;
      }
  std::vector<std::string> out;
  for (const auto& l : lines) {
    out.push_back(l);
    if (l.starts_with("a=rtpmap:"))
      if (auto pt = attribute_pt(l); pt && vp8.contains(*pt) && !has_fmtp.contains(*pt))
        out.push_back("a=fmtp:" + std::to_string(*pt) + " " + param);
  }
  return join(out);
}

std::string add_goog_remb(std::string_view answer) {
  auto lines = lines_of(answer);
  std::set<int> vp8;
  std::set<int> has_remb;
  for (const auto& l : lines) {
    if (l.starts_with("a=rtpmap:") &&
        (l.find(" VP8/") != std::string::npos || l.find(" vp8/") != std::string::npos))
      if (auto pt = attribute_pt(l)) vp8.insert(*pt);
    if (l.starts_with("a=rtcp-fb:") && l.ends_with(" goog-remb"))
      if (auto pt = attribute_pt(l)) has_remb.insert(*pt);
  }
  // Va tras la última línea rtpmap/rtcp-fb de su payload type (o tras el rtpmap si no hay feedback).
  std::map<int, std::size_t> last_line;
  for (std::size_t i = 0; i < lines.size(); ++i)
    if (lines[i].starts_with("a=rtpmap:") || lines[i].starts_with("a=rtcp-fb:"))
      if (auto pt = attribute_pt(lines[i]); pt && vp8.contains(*pt) && !has_remb.contains(*pt))
        last_line[*pt] = i;
  std::vector<std::string> out;
  for (std::size_t i = 0; i < lines.size(); ++i) {
    out.push_back(lines[i]);
    for (const auto& [pt, at] : last_line)
      if (at == i) out.push_back("a=rtcp-fb:" + std::to_string(pt) + " goog-remb");
  }
  return join(out);
}

std::string opus_stereo(std::string_view sdp, int max_average_bitrate) {
  auto lines = lines_of(sdp);
  const std::string params =
      "stereo=1;sprop-stereo=1;maxaveragebitrate=" + std::to_string(max_average_bitrate);
  std::set<int> opus;
  for (const auto& l : lines)
    if (l.starts_with("a=rtpmap:") &&
        (l.find(" opus/") != std::string::npos || l.find(" OPUS/") != std::string::npos))
      if (auto pt = attribute_pt(l)) opus.insert(*pt);
  std::set<int> has_fmtp;
  for (auto& l : lines)
    if (l.starts_with("a=fmtp:"))
      if (auto pt = attribute_pt(l); pt && opus.contains(*pt)) {
        has_fmtp.insert(*pt);
        if (l.find("stereo=1") == std::string::npos) l += ";" + params;
      }
  std::vector<std::string> out;
  for (const auto& l : lines) {
    out.push_back(l);
    if (l.starts_with("a=rtpmap:"))
      if (auto pt = attribute_pt(l); pt && opus.contains(*pt) && !has_fmtp.contains(*pt))
        out.push_back("a=fmtp:" + std::to_string(*pt) + " " + params);
  }
  return join(out);
}

}  // namespace stream::sdp
