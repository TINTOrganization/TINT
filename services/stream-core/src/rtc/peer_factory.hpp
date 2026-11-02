#pragma once

#include <chrono>
#include <cstdint>
#include <string>

#include "service/stream_service.hpp"

namespace stream::rtc_adapter {

struct PeerFactoryConfig {
  std::uint16_t udp_port = 8087;  // ICE UDP mux: todas las PeerConnections en un puerto
  std::string public_ip;          // reescribe el candidato host (Docker, spike S3)
  std::string bind_address;       // vacío = todas las interfaces
  std::chrono::milliseconds gathering_timeout{1500};
  int start_bitrate_kbps = 2500;  // x-google-start-bitrate para el host (spike S1)
};

// PeerFactory sobre libdatachannel (ADR 0017). Es el ÚNICO código que incluye <rtc/rtc.hpp>.
//  - Host (vídeo/audio): recibe la pista remota y entrega el RTP crudo por on_rtp.
//  - Viewer: pistas sendonly por mid con SSRC propios; su RTCP llega por on_rtcp.
//  - DataChannel negociado (id=0, "stream-events") en ambos casos.
class LibDataChannelPeerFactory : public service::PeerFactory {
 public:
  explicit LibDataChannelPeerFactory(PeerFactoryConfig config);
  std::expected<std::shared_ptr<service::Peer>, http::Problem> create(
      const service::PeerRequest& request, service::PeerCallbacks callbacks) override;

 private:
  PeerFactoryConfig config_;
};

}  // namespace stream::rtc_adapter
