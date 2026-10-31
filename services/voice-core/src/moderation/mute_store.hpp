#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace voice::moderation {

// Silencios del host por sala (room:{id}:voice:muted). Siguen vigentes aunque el
// participante salga de la voz y vuelva a entrar.
class MuteStore {
 public:
  virtual ~MuteStore() = default;
  // nullopt = no se pudo consultar (falla cerrado).
  virtual std::optional<bool> is_muted(const std::string& room_id, const std::string& user_id) = 0;
  // false = no se pudo guardar.
  virtual bool set_muted(const std::string& room_id, const std::string& user_id, bool muted) = 0;
};

// Host y cohost moderan (igual que en el Canal Social); un participante no.
inline bool can_moderate(std::string_view role) { return role == "host" || role == "cohost"; }

}  // namespace voice::moderation
