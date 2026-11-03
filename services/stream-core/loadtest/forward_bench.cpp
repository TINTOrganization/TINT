// Microbenchmark del camino caliente del SFU (sin red ni SRTP): 1 host con 3 capas -> N viewers.
// Uso: ./build-rel/stream_core_bench [viewers=50] [paquetes_por_capa=20000]
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <vector>

#include "sfu/room.hpp"
#include "support/rtp_builder.hpp"

using namespace stream;

namespace {
struct CountingSink : sfu::ViewerSink {
  std::size_t packets = 0, bytes = 0;
  void send_video(rtp::Bytes p) override { ++packets, bytes += p.size(); }
  void send_audio(rtp::Bytes p) override { ++packets, bytes += p.size(); }
  void send_event(std::string) override {}
  void close() override {}
};
struct NullHost : sfu::HostSink {
  void send_video_rtcp(rtp::Bytes) override {}
};
}  // namespace

int main(int argc, char** argv) {
  const int viewers = argc > 1 ? std::atoi(argv[1]) : 50;
  const int per_layer = argc > 2 ? std::atoi(argv[2]) : 20000;
  sfu::Room room("bench", {.max_viewers = 1000});
  room.set_host_video(std::make_shared<NullHost>(), 4, {"h", "m", "l"});
  std::vector<std::shared_ptr<CountingSink>> sinks;
  for (int i = 0; i < viewers; ++i) {
    auto sink = std::make_shared<CountingSink>();
    sinks.push_back(sink);
    auto v = std::make_shared<sfu::Viewer>("v" + std::to_string(i), "s",
                                           sfu::ViewerOptions{.video_ssrc = 1000u + i, .video_payload_type = 100},
                                           sink);
    v->set_desired_layer(i % 3);  // reparto realista entre capas
    room.add_viewer(v, 0);
  }
  const char* rid[3] = {"l", "m", "h"};
  std::vector<rtp::Bytes> packets;  // paquetes de ~1200 B como los de vídeo real
  for (int l = 0; l < 3; ++l)
    for (int s = 0; s < 64; ++s) {
      std::vector<std::uint8_t> payload = testing::build_vp8_payload({.keyframe = s == 0});
      payload.resize(1150, 0x5A);
      packets.push_back(testing::build_rtp({.pt = 96, .seq = static_cast<std::uint16_t>(s), .ts = s * 3000u,
                                            .ssrc = 0x10u + l, .extensions = {{4, rid[l]}}, .payload = payload}));
    }
  // Calentamiento: anclar a cada viewer con un keyframe de su capa.
  for (int l = 0; l < 3; ++l) room.on_host_video(packets[l * 64], 0);

  const auto start = std::chrono::steady_clock::now();
  std::uint16_t seq = 64;
  for (int i = 0; i < per_layer; ++i, ++seq)
    for (int l = 0; l < 3; ++l) {
      auto p = packets[l * 64 + 1 + (i % 63)];
      rtp::set_sequence(p, seq);
      room.on_host_video(p, i);
    }
  const auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now() - start).count();
  std::size_t out = 0;
  for (auto& s : sinks) out += s->packets;
  const double in = 3.0 * per_layer;
  std::printf("viewers=%d entrantes=%.0f salientes=%zu\n", viewers, in, out);
  std::printf("ns por paquete entrante=%.0f  ns por paquete saliente=%.0f\n", ns / in, ns / static_cast<double>(out));
  // Tasa real a 2.5+0.8+0.25 Mbps con paquetes de 1200 B: ~370 paquetes/s entrantes.
  const double cpu = (ns / in) * 370.0 / 1e9 * 100.0;
  std::printf("CPU estimada del reenvío a ~370 paq/s entrantes: %.2f %% de un núcleo (sin SRTP)\n", cpu);
  return 0;
}
