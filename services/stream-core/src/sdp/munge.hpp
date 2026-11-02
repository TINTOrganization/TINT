#pragma once

#include <string>
#include <string_view>

namespace stream::sdp {

// Deja en la oferta solo VP8 (vídeo) y Opus (audio): sin RTX/RED/ULPFEC/H.264 ni transport-cc
// (libdatachannel no genera ese feedback). El SFU reenvía tal cual y no transcodifica.
std::string sanitize_offer(std::string_view offer);

// libdatachannel responde "a=rid:X send" y "a=simulcast:send" (dirección sin implementar): en un
// SFU que recibe deben ser "recv". Además quita líneas a=simulcast duplicadas.
std::string fix_simulcast_answer(std::string_view answer);

// Cambia la dirección de los candidatos "typ host" por la IP pública (ICE UDP mux en Docker).
std::string rewrite_host_candidates(std::string_view sdp, std::string_view public_ip);

// x-google-start-bitrate en el fmtp de VP8: Chrome arranca alto y sube las capas antes (spike S1).
std::string add_start_bitrate(std::string_view answer, int kbps);

// Opus estéreo a 128 kbps para el audio del PC (HU-LIVE-01b AC3).
std::string opus_stereo(std::string_view sdp, int max_average_bitrate = 128000);

}  // namespace stream::sdp
