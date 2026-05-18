#pragma once

#include <cstddef>
#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

int player_create();
void player_destroy(int handle);
int player_feed_segment(int handle, const uint8_t* data, size_t size, int is_init_segment);
void player_reset(int handle);
double player_get_current_time(int handle);

#ifdef __cplusplus
}
#endif
