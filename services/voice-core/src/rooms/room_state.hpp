#pragma once

#include <optional>
#include <string>

namespace voice::rooms {

// Estado de la sala en Redis que voice-core consulta (ADR 0019):
//   room:{id}:closed       la sala se deshabilitó (lo escribe identity-api): upgrade y cierre 4010.
//   room:{id}:kind = live  modo escenario (lo escribe identity-api): solo host/cohost y el escenario.
//   room:{id}:voice:stage  SET de user_id (sub) invitados al escenario (lo escribe voice-core).
// nullopt / false = Redis no respondió (falla cerrado).
class RoomStateStore {
 public:
  virtual ~RoomStateStore() = default;
  virtual std::optional<bool> is_closed(const std::string& room_id) = 0;
  virtual std::optional<bool> is_live(const std::string& room_id) = 0;
  virtual std::optional<bool> is_on_stage(const std::string& room_id, const std::string& user_id) = 0;
  virtual bool set_on_stage(const std::string& room_id, const std::string& user_id, bool on_stage) = 0;
};

}  // namespace voice::rooms
