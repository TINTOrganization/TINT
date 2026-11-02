#pragma once

#include <chrono>
#include <optional>
#include <string>

#include "redis/client.hpp"
#include "redis/mute_store.hpp"
#include "redis/redis_url.hpp"
#include "rooms/room_state.hpp"

namespace voice::redis {

// El escenario vive lo mismo que las demás claves de voz de la sala (room:{id}:voice:muted)
// y se renueva en cada invitación: una sala olvidada no deja la clave para siempre.
inline constexpr std::chrono::seconds kStageTtl = kMutedTtl;

std::string closed_key(const std::string& room_id);
std::string kind_key(const std::string& room_id);
std::string stage_key(const std::string& room_id);

// Lee room:{id}:closed y room:{id}:kind (identity-api) y lee/escribe room:{id}:voice:stage.
class RedisRoomStateStore : public rooms::RoomStateStore {
 public:
  RedisRoomStateStore(RedisEndpoint endpoint, std::chrono::milliseconds timeout);

  std::optional<bool> is_closed(const std::string& room_id) override;
  std::optional<bool> is_live(const std::string& room_id) override;
  std::optional<bool> is_on_stage(const std::string& room_id, const std::string& user_id) override;
  bool set_on_stage(const std::string& room_id, const std::string& user_id, bool on_stage) override;

 private:
  BlockingClient client_;
};

}  // namespace voice::redis
