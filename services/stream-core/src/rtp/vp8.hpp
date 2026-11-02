#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>

namespace stream::rtp {

// Descriptor de payload VP8 (RFC 7741 §4.2) y bit P de la cabecera del frame.
struct Vp8Descriptor {
  bool start_of_partition = false;
  std::uint8_t partition_index = 0;
  std::optional<std::uint16_t> picture_id;
  bool picture_id_15bit = false;
  std::size_t picture_id_offset = 0;  // offset dentro del payload
  std::optional<std::uint8_t> tl0picidx;
  std::size_t tl0picidx_offset = 0;
  std::size_t size = 0;   // bytes del descriptor
  bool keyframe = false;  // primer paquete de un keyframe
};

std::optional<Vp8Descriptor> parse_vp8(std::span<const std::uint8_t> payload);

// Escribe el PictureID respetando su ancho (7 bits envuelve en 128, 15 bits en 32768).
void write_picture_id(std::span<std::uint8_t> payload, const Vp8Descriptor& d, std::uint16_t picture_id);
void write_tl0picidx(std::span<std::uint8_t> payload, const Vp8Descriptor& d, std::uint8_t value);

}  // namespace stream::rtp
