#pragma once

#include <string>

namespace stream::util {

// UUID v4 aleatorio (event_id y peer_id). Thread-safe.
std::string new_uuid();

}  // namespace stream::util
