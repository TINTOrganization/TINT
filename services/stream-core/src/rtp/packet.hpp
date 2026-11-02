#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <span>
#include <vector>

namespace stream::rtp {

using Bytes = std::vector<std::uint8_t>;
using ByteView = std::span<const std::uint8_t>;

// Vista de un paquete RTP (RFC 3550) ya validado. Offsets relativos al inicio del paquete.
struct RtpView {
  std::uint8_t payload_type = 0;
  bool marker = false;
  std::uint16_t seq = 0;
  std::uint32_t timestamp = 0;
  std::uint32_t ssrc = 0;
  std::size_t payload_offset = 0;
  std::size_t payload_size = 0;
  std::size_t extension_offset = 0;  // inicio de los datos de extensión (tras perfil+longitud)
  std::size_t extension_size = 0;
  std::uint16_t extension_profile = 0;  // 0xBEDE (un byte) o 0x100x (dos bytes)
};

// RFC 5761 §4: PT 64–95 en el segundo byte es RTCP (200–207 sin el bit de marca).
bool looks_like_rtcp(ByteView packet);

std::optional<RtpView> parse_rtp(ByteView packet);

// Datos de la extensión de cabecera con ese id (RFC 8285, formatos de uno y dos bytes).
std::optional<ByteView> find_extension(ByteView packet, const RtpView& view, int id);

// Escrituras en sitio (el paquete ya fue validado por parse_rtp).
void set_payload_type(std::span<std::uint8_t> packet, std::uint8_t pt);
void set_sequence(std::span<std::uint8_t> packet, std::uint16_t seq);
void set_timestamp(std::span<std::uint8_t> packet, std::uint32_t ts);
void set_ssrc(std::span<std::uint8_t> packet, std::uint32_t ssrc);

// Copia el paquete dejando solo las extensiones de `keep` (id original -> id del receptor),
// en formato de un byte. Sin extensiones que conservar, el paquete queda sin cabecera de extensión.
Bytes rewrite_extensions(ByteView packet, const RtpView& view, const std::map<int, int>& keep);

}  // namespace stream::rtp
