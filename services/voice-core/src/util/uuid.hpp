#pragma once

#include <string>

namespace voice::util {

// UUID v4 aleatorio (event_id y peer_id). Thread-safe.
std::string new_uuid();

}  // namespace voice::util
