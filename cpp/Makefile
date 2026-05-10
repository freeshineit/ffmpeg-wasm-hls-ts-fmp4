SHELL := /bin/bash

ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
BUILD_DIR := $(ROOT_DIR)/build
FFMPEG_PREFIX := $(ROOT_DIR)/third_party/ffmpeg-wasm
FFMPEG_VERSION ?= 7.1
BUILD_DATE_UTC := $(shell date -u +%Y-%m-%d)
BANNER_TEXT := /*! hls-wasm2 player_wasm | ffmpeg $(FFMPEG_VERSION) | build-date $(BUILD_DATE_UTC) */
OUT_JS := $(BUILD_DIR)/player_wasm.js
OUT_WASM := $(BUILD_DIR)/player_wasm.wasm

CXX := em++
CXXFLAGS := -std=c++17 -Oz -flto -ffunction-sections -fdata-sections -fno-exceptions -fno-rtti
INCLUDES := -I$(ROOT_DIR)/include -I$(FFMPEG_PREFIX)/include
LIBS := -L$(FFMPEG_PREFIX)/lib -lavformat -lavcodec -lavutil -lswresample -lswscale

EM_FLAGS := \
	-Oz \
	-flto \
	-Wl,--gc-sections \
	-sALLOW_MEMORY_GROWTH=1 \
	-sINITIAL_MEMORY=134217728 \
	-sMAXIMUM_MEMORY=1073741824 \
	-sMODULARIZE=1 \
	-sEXPORT_NAME=createPlayerModule \
	-sENVIRONMENT=web \
	-sWASM=1 \
	-sFILESYSTEM=0 \
	-sASSERTIONS=0 \
	-sSAFE_HEAP=0 \
	-sSTACK_OVERFLOW_CHECK=0 \
	-sDEMANGLE_SUPPORT=0 \
	-sSUPPORT_ERRNO=0 \
	-sMALLOC=emmalloc \
	-sINCOMING_MODULE_JS_API="['locateFile']" \
	-sEXPORTED_FUNCTIONS="['_malloc','_free','_player_create','_player_destroy','_player_feed_segment','_player_reset']" \
	-sEXPORTED_RUNTIME_METHODS="['HEAPU8']"

.PHONY: all ffmpeg wasm clean install-web

all: ffmpeg wasm

ffmpeg:
	@chmod +x $(ROOT_DIR)/build_ffmpeg_wasm.sh
	@$(ROOT_DIR)/build_ffmpeg_wasm.sh

wasm: $(OUT_JS)

$(OUT_JS): $(ROOT_DIR)/src/player_wasm.cpp $(ROOT_DIR)/include/player_wasm.h
	@mkdir -p $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) $(INCLUDES) $(ROOT_DIR)/src/player_wasm.cpp -o $(OUT_JS) $(LIBS) $(EM_FLAGS)
	@{ \
		echo "$(BANNER_TEXT)"; \
		cat "$(OUT_JS)"; \
	} > "$(OUT_JS).tmp" && mv "$(OUT_JS).tmp" "$(OUT_JS)"

clean:
	rm -f $(OUT_JS) $(OUT_WASM)

install-web: wasm
	mkdir -p $(ROOT_DIR)/../web/public/wasm
	cp $(OUT_JS) $(ROOT_DIR)/../web/public/wasm/
	cp $(OUT_WASM) $(ROOT_DIR)/../web/public/wasm/
