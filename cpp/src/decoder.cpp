#include "decoder.h"

#include <emscripten.h>

#include <cstdint>
#include <cstring>
#include <cerrno>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavformat/avformat.h>
#include <libavutil/avutil.h>
#include <libavutil/frame.h>
#include <libavutil/imgutils.h>
#include <libavutil/mem.h>
#include <libavutil/opt.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

EM_JS(void, js_on_video_frame,
      (int width,
       int height,
       int y_ptr,
       int y_stride,
       int u_ptr,
       int u_stride,
       int v_ptr,
       int v_stride,
       double pts_ms,
       int is_key_frame,
       const char* codec_name),
      {
        if (Module.onVideoFrame) {
          Module.onVideoFrame(width, height, y_ptr, y_stride, u_ptr, u_stride, v_ptr, v_stride, pts_ms, is_key_frame, UTF8ToString(codec_name));
        }
      });

EM_JS(void, js_on_audio_frame,
      (int channels, int sample_rate, int sample_count, int data_ptr, double pts_ms, const char* codec_name),
      {
        if (Module.onAudioFrame) {
          Module.onAudioFrame(channels, sample_rate, sample_count, data_ptr, pts_ms, UTF8ToString(codec_name));
        }
      });

EM_JS(void, js_on_log, (int level, const char* msg), {
  if (Module.onLog) {
    Module.onLog(level, UTF8ToString(msg));
  }
});

static void custom_av_log_callback(void* ptr, int level, const char* fmt, va_list vl) {
  if (level > AV_LOG_WARNING) return;
  char line[1024];
  vsnprintf(line, sizeof(line), fmt, vl);
  
  // Filter out recoverable demux/decode noise that is common on fragmented LL-HLS input.
  if (strstr(line, "Failed to parse header of NALU") ||
      strstr(line, "Invalid data found when processing input") ||
      strstr(line, "Packet corrupt") ||
      strstr(line, "DTS discontinuity") ||
      strstr(line, "Could not find ref with POC") ||
      strstr(line, "Error constructing the frame RPS") ||
      strstr(line, "Skipping invalid undecodable NALU")) {
    return;
  }
  
  js_on_log(level, line);
}

namespace {

struct MemoryData {
  const uint8_t* data = nullptr;
  size_t size = 0;
  size_t pos = 0;
};

static int read_packet(void* opaque, uint8_t* buf, int buf_size) {
  auto* mem = static_cast<MemoryData*>(opaque);
  if (mem->pos >= mem->size) {
    return AVERROR_EOF;
  }

  const size_t left = mem->size - mem->pos;
  const size_t n = left < static_cast<size_t>(buf_size) ? left : static_cast<size_t>(buf_size);
  std::memcpy(buf, mem->data + mem->pos, n);
  mem->pos += n;
  return static_cast<int>(n);
}

static AVPixelFormat normalizePixelFormat(AVPixelFormat pix_fmt) {
  switch (pix_fmt) {
    case AV_PIX_FMT_YUVJ420P:
      return AV_PIX_FMT_YUV420P;
    case AV_PIX_FMT_YUVJ422P:
      return AV_PIX_FMT_YUV422P;
    case AV_PIX_FMT_YUVJ444P:
      return AV_PIX_FMT_YUV444P;
    case AV_PIX_FMT_YUVJ440P:
      return AV_PIX_FMT_YUV440P;
    default:
      return pix_fmt;
  }
}

static bool isFullRangePixelFormat(AVPixelFormat pix_fmt, AVColorRange color_range) {
  if (color_range == AVCOL_RANGE_JPEG) {
    return true;
  }

  switch (pix_fmt) {
    case AV_PIX_FMT_YUVJ420P:
    case AV_PIX_FMT_YUVJ422P:
    case AV_PIX_FMT_YUVJ444P:
    case AV_PIX_FMT_YUVJ440P:
      return true;
    default:
      return false;
  }
}

static bool isTimestampDiscontinuity(int64_t previous_dts_us, int64_t current_dts_us) {
  if (previous_dts_us == AV_NOPTS_VALUE || current_dts_us == AV_NOPTS_VALUE) {
    return false;
  }

  constexpr int64_t kBackwardToleranceUs = 500 * 1000;
  constexpr int64_t kForwardToleranceUs = 30 * 1000 * 1000;
  return current_dts_us + kBackwardToleranceUs < previous_dts_us ||
         current_dts_us - previous_dts_us > kForwardToleranceUs;
}

class Player {
 public:
  ~Player() { reset(); }

  int feedSegment(const uint8_t* data, size_t size, bool is_init_segment) {
    if (data == nullptr || size == 0) {
      return AVERROR(EINVAL);
    }

    if (is_init_segment) {
      // fMP4 playlists provide codec metadata in EXT-X-MAP. Cache it so
      // subsequent media segments can be demuxed/decoded with full context.
      init_segment_.assign(data, data + size);
      return 0;
    }

    if (!init_segment_.empty()) {
      segment_buffer_.clear();
      segment_buffer_.reserve(init_segment_.size() + size);
      segment_buffer_.insert(segment_buffer_.end(), init_segment_.begin(), init_segment_.end());
      segment_buffer_.insert(segment_buffer_.end(), data, data + size);
      return decodeBuffer(segment_buffer_.data(), segment_buffer_.size());
    }

    return decodeBuffer(data, size);
  }

  double getCurrentTime() const {
    return current_time_ms_;
  }

  void reset() {
    current_time_ms_ = 0.0;
    if (video_bsf_ctx_) {
      av_bsf_free(&video_bsf_ctx_);
      video_bsf_ctx_ = nullptr;
    }
    if (video_dec_ctx_) {
      avcodec_free_context(&video_dec_ctx_);
    }
    if (audio_dec_ctx_) {
      avcodec_free_context(&audio_dec_ctx_);
    }
    if (sws_ctx_) {
      sws_freeContext(sws_ctx_);
      sws_ctx_ = nullptr;
    }
    if (swr_ctx_) {
      swr_free(&swr_ctx_);
    }
    if (video_frame_yuv_) {
      av_frame_free(&video_frame_yuv_);
    }
    if (video_buffer_) {
      av_free(video_buffer_);
      video_buffer_ = nullptr;
    }
    audio_f32_.clear();
    init_segment_.clear();
    segment_buffer_.clear();
    video_stream_index_ = -1;
    audio_stream_index_ = -1;
    last_video_dts_us_ = AV_NOPTS_VALUE;
    last_audio_dts_us_ = AV_NOPTS_VALUE;
    waiting_for_video_keyframe_ = true;
  }

 private:
  int decodeBuffer(const uint8_t* data, size_t size) {
    MemoryData mem;
    mem.data = data;
    mem.size = size;

    constexpr int io_buffer_size = 64 * 1024;
    uint8_t* io_buffer = static_cast<uint8_t*>(av_malloc(io_buffer_size));
    if (!io_buffer) {
      return AVERROR(ENOMEM);
    }

    AVIOContext* avio = avio_alloc_context(io_buffer, io_buffer_size, 0, &mem, read_packet, nullptr, nullptr);
    if (!avio) {
      av_free(io_buffer);
      return AVERROR(ENOMEM);
    }

    AVFormatContext* fmt = avformat_alloc_context();
    if (!fmt) {
      avio_context_free(&avio);
      return AVERROR(ENOMEM);
    }

    fmt->pb = avio;
    fmt->flags |= AVFMT_FLAG_CUSTOM_IO | AVFMT_FLAG_DISCARD_CORRUPT;
    fmt->probesize = 8 * 1024 * 1024;
    fmt->max_analyze_duration = 2 * AV_TIME_BASE;
    fmt->fps_probe_size = 0;

    int ret = avformat_open_input(&fmt, nullptr, nullptr, nullptr);
    if (ret < 0) {
      logError("avformat_open_input failed", ret);
      cleanupInput(fmt);
      return ret;
    }

    ret = avformat_find_stream_info(fmt, nullptr);
    if (ret < 0) {
      logError("avformat_find_stream_info failed", ret);
      cleanupInput(fmt);
      return ret;
    }

    ret = ensureStreams(fmt);
    if (ret < 0) {
      cleanupInput(fmt);
      return ret;
    }

    AVPacket* pkt = av_packet_alloc();
    AVFrame* frame = av_frame_alloc();
    if (!pkt || !frame) {
      av_packet_free(&pkt);
      av_frame_free(&frame);
      cleanupInput(fmt);
      return AVERROR(ENOMEM);
    }

    while (true) {
      ret = av_read_frame(fmt, pkt);
      if (ret == AVERROR_EOF) {
        break;
      }
      if (ret < 0) {
        if (ret == AVERROR_INVALIDDATA) {
          continue;
        }
        logError("av_read_frame failed", ret);
        break;
      }

      maybeHandleTimestampDiscontinuity(pkt, fmt->streams[pkt->stream_index]->time_base);

      if (pkt->stream_index == video_stream_index_ && video_dec_ctx_) {
        if (video_bsf_ctx_) {
          ret = av_bsf_send_packet(video_bsf_ctx_, pkt);
          if (ret >= 0) {
            while (true) {
              AVPacket* bsf_pkt = av_packet_alloc();
              ret = av_bsf_receive_packet(video_bsf_ctx_, bsf_pkt);
              if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
                av_packet_free(&bsf_pkt);
                break;
              }
              if (ret >= 0) {
                if (shouldDecodeVideoPacket(bsf_pkt)) {
                  decodePacket(video_dec_ctx_, bsf_pkt, frame, true, fmt->streams[video_stream_index_]->time_base);
                }
              }
              av_packet_free(&bsf_pkt);
            }
          }
        } else {
          if (shouldDecodeVideoPacket(pkt)) {
            decodePacket(video_dec_ctx_, pkt, frame, true, fmt->streams[video_stream_index_]->time_base);
          }
        }
      } else if (pkt->stream_index == audio_stream_index_ && audio_dec_ctx_) {
        decodePacket(audio_dec_ctx_, pkt, frame, false, fmt->streams[audio_stream_index_]->time_base);
      }
      av_packet_unref(pkt);
    }

    av_packet_free(&pkt);
    av_frame_free(&frame);
    cleanupInput(fmt);
    return 0;
  }
  int ensureStreams(AVFormatContext* fmt) {
    if (video_stream_index_ < 0) {
      video_stream_index_ = av_find_best_stream(fmt, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
      if (video_stream_index_ >= 0) {
        const int ret = openVideoDecoder(fmt->streams[video_stream_index_]);
        if (ret == AVERROR_DECODER_NOT_FOUND) {
          video_stream_index_ = -1;
        } else if (ret < 0) {
          return ret;
        }
      }
    }

    if (audio_stream_index_ < 0) {
      audio_stream_index_ = av_find_best_stream(fmt, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
      if (audio_stream_index_ >= 0) {
        const int ret = openAudioDecoder(fmt->streams[audio_stream_index_]);
        if (ret == AVERROR_DECODER_NOT_FOUND) {
          audio_stream_index_ = -1;
        } else if (ret < 0) {
          return ret;
        }
      }
    }

    if (video_stream_index_ < 0 && audio_stream_index_ < 0) {
      js_on_log(3, "No supported audio or video stream found in segment.");
      return AVERROR_STREAM_NOT_FOUND;
    }

    return 0;
  }

  int openVideoDecoder(AVStream* stream) {
    const AVCodec* codec = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!codec) {
      js_on_log(3, "Video codec not supported by current FFmpeg build.");
      return AVERROR_DECODER_NOT_FOUND;
    }

    video_dec_ctx_ = avcodec_alloc_context3(codec);
    if (!video_dec_ctx_) {
      return AVERROR(ENOMEM);
    }

    AVCodecParameters* par = stream->codecpar;

    if (stream->codecpar->codec_id == AV_CODEC_ID_HEVC || stream->codecpar->codec_id == AV_CODEC_ID_H264) {
      const char* bsf_name = (stream->codecpar->codec_id == AV_CODEC_ID_HEVC) ? "hevc_mp4toannexb" : "h264_mp4toannexb";
      const AVBitStreamFilter* bsf = av_bsf_get_by_name(bsf_name);
      if (bsf) {
        if (av_bsf_alloc(bsf, &video_bsf_ctx_) >= 0) {
          if (avcodec_parameters_copy(video_bsf_ctx_->par_in, stream->codecpar) >= 0) {
            video_bsf_ctx_->time_base_in = stream->time_base;
            if (av_bsf_init(video_bsf_ctx_) == 0) {
              par = video_bsf_ctx_->par_out;
            } else {
              av_bsf_free(&video_bsf_ctx_);
            }
          } else {
            av_bsf_free(&video_bsf_ctx_);
          }
        }
      }
    }

    int ret = avcodec_parameters_to_context(video_dec_ctx_, par);
    if (ret < 0) {
      logError("avcodec_parameters_to_context(video) failed", ret);
      return ret;
    }

    if (stream->codecpar->codec_id == AV_CODEC_ID_HEVC || stream->codecpar->codec_id == AV_CODEC_ID_H264) {
      // LL-HLS/fMP4 fragments may provide non frame-complete access units.
      video_dec_ctx_->flags2 |= AV_CODEC_FLAG2_CHUNKS;
    }

    if (stream->codecpar->codec_id == AV_CODEC_ID_HEVC) {
      // Keep decoding through damaged HEVC NAL units when possible.
      video_dec_ctx_->err_recognition |= AV_EF_IGNORE_ERR;
    }

    video_dec_ctx_->flags |= AV_CODEC_FLAG_OUTPUT_CORRUPT;

    ret = avcodec_open2(video_dec_ctx_, codec, nullptr);
    if (ret < 0) {
      logError("avcodec_open2(video) failed", ret);
      return ret;
    }

    return 0;
  }

  int openAudioDecoder(AVStream* stream) {
    const AVCodec* codec = avcodec_find_decoder(stream->codecpar->codec_id);
    if (!codec) {
      js_on_log(3, "Audio codec not supported by current FFmpeg build.");
      return AVERROR_DECODER_NOT_FOUND;
    }

    audio_dec_ctx_ = avcodec_alloc_context3(codec);
    if (!audio_dec_ctx_) {
      return AVERROR(ENOMEM);
    }

    int ret = avcodec_parameters_to_context(audio_dec_ctx_, stream->codecpar);
    if (ret < 0) {
      logError("avcodec_parameters_to_context(audio) failed", ret);
      return ret;
    }

    ret = avcodec_open2(audio_dec_ctx_, codec, nullptr);
    if (ret < 0) {
      logError("avcodec_open2(audio) failed", ret);
      return ret;
    }

    swr_ctx_ = swr_alloc();
    if (!swr_ctx_) {
      return AVERROR(ENOMEM);
    }

    AVChannelLayout out_layout;
    av_channel_layout_default(&out_layout, audio_dec_ctx_->ch_layout.nb_channels > 0 ? audio_dec_ctx_->ch_layout.nb_channels : 2);

    av_opt_set_chlayout(swr_ctx_, "in_chlayout", &audio_dec_ctx_->ch_layout, 0);
    av_opt_set_int(swr_ctx_, "in_sample_rate", audio_dec_ctx_->sample_rate, 0);
    av_opt_set_sample_fmt(swr_ctx_, "in_sample_fmt", audio_dec_ctx_->sample_fmt, 0);

    av_opt_set_chlayout(swr_ctx_, "out_chlayout", &out_layout, 0);
    av_opt_set_int(swr_ctx_, "out_sample_rate", audio_dec_ctx_->sample_rate, 0);
    av_opt_set_sample_fmt(swr_ctx_, "out_sample_fmt", AV_SAMPLE_FMT_FLT, 0);

    av_channel_layout_uninit(&out_layout);

    ret = swr_init(swr_ctx_);
    if (ret < 0) {
      logError("swr_init failed", ret);
      return ret;
    }

    return 0;
  }

  void maybeHandleTimestampDiscontinuity(AVPacket* pkt, AVRational time_base) {
    if (!pkt || pkt->dts == AV_NOPTS_VALUE) {
      return;
    }

    const int64_t current_dts_us = av_rescale_q(pkt->dts, time_base, AV_TIME_BASE_Q);

    if (pkt->stream_index == video_stream_index_) {
      if (isTimestampDiscontinuity(last_video_dts_us_, current_dts_us)) {
        flushVideoPipeline();
      }
      last_video_dts_us_ = current_dts_us;
      return;
    }

    if (pkt->stream_index == audio_stream_index_) {
      if (isTimestampDiscontinuity(last_audio_dts_us_, current_dts_us) && audio_dec_ctx_) {
        avcodec_flush_buffers(audio_dec_ctx_);
      }
      last_audio_dts_us_ = current_dts_us;
    }
  }

  bool shouldDecodeVideoPacket(const AVPacket* pkt) {
    if (!pkt) {
      return false;
    }

    if (!waiting_for_video_keyframe_) {
      return true;
    }

    if ((pkt->flags & AV_PKT_FLAG_KEY) == 0) {
      return false;
    }

    waiting_for_video_keyframe_ = false;
    return true;
  }

  void flushVideoPipeline() {
    waiting_for_video_keyframe_ = true;
    if (video_bsf_ctx_) {
      av_bsf_flush(video_bsf_ctx_);
    }
    if (video_dec_ctx_) {
      avcodec_flush_buffers(video_dec_ctx_);
    }
  }

  void decodePacket(AVCodecContext* dec_ctx, AVPacket* pkt, AVFrame* frame, bool is_video, AVRational time_base) {
    int ret = avcodec_send_packet(dec_ctx, pkt);
    if (ret < 0) {
      if (ret == AVERROR_INVALIDDATA && is_video) {
        // Skip malformed video packets and continue with subsequent packets.
        return;
      }
      logError("avcodec_send_packet failed", ret);
      return;
    }

    while (ret >= 0) {
      ret = avcodec_receive_frame(dec_ctx, frame);
      if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
        break;
      }
      if (ret < 0) {
        if (ret == AVERROR_INVALIDDATA && is_video) {
          break;
        }
        logError("avcodec_receive_frame failed", ret);
        break;
      }

      const int64_t pts = frame->best_effort_timestamp == AV_NOPTS_VALUE ? 0 : frame->best_effort_timestamp;
      const double pts_ms = av_q2d(time_base) * static_cast<double>(pts) * 1000.0;

      if (is_video) {
        outputVideoFrame(frame, pts_ms);
      } else {
        outputAudioFrame(frame, pts_ms);
      }

      av_frame_unref(frame);
    }
  }

  void outputVideoFrame(AVFrame* src, double pts_ms) {
    if (!video_dec_ctx_) {
      return;
    }

    if (!sws_ctx_ || src->width != video_width_ || src->height != video_height_ || src->format != video_src_pix_fmt_) {
      const AVPixelFormat src_pix_fmt = normalizePixelFormat(static_cast<AVPixelFormat>(src->format));
      const int src_full_range = isFullRangePixelFormat(static_cast<AVPixelFormat>(src->format), src->color_range) ? 1 : 0;
      if (sws_ctx_) {
        sws_freeContext(sws_ctx_);
      }
      sws_ctx_ = sws_getContext(src->width,
                               src->height,
                               src_pix_fmt,
                               src->width,
                               src->height,
                               AV_PIX_FMT_YUV420P,
                               SWS_BILINEAR,
                               nullptr,
                               nullptr,
                               nullptr);
      if (!sws_ctx_) {
        js_on_log(3, "sws_getContext failed for video frame conversion.");
        return;
      }

      const int* coeffs = sws_getCoefficients(SWS_CS_DEFAULT);
      sws_setColorspaceDetails(sws_ctx_, coeffs, src_full_range, coeffs, 0, 0, 1 << 16, 1 << 16);

      if (video_frame_yuv_) {
        av_frame_free(&video_frame_yuv_);
      }
      if (video_buffer_) {
        av_free(video_buffer_);
        video_buffer_ = nullptr;
      }

      video_frame_yuv_ = av_frame_alloc();
      video_frame_yuv_->format = AV_PIX_FMT_YUV420P;
      video_frame_yuv_->width = src->width;
      video_frame_yuv_->height = src->height;

      const int num_bytes = av_image_get_buffer_size(AV_PIX_FMT_YUV420P, src->width, src->height, 1);
      video_buffer_ = static_cast<uint8_t*>(av_malloc(num_bytes));
      av_image_fill_arrays(video_frame_yuv_->data,
                           video_frame_yuv_->linesize,
                           video_buffer_,
                           AV_PIX_FMT_YUV420P,
                           src->width,
                           src->height,
                           1);

      video_width_ = src->width;
      video_height_ = src->height;
      video_src_pix_fmt_ = src->format;
    }

    sws_scale(sws_ctx_, src->data, src->linesize, 0, src->height, video_frame_yuv_->data, video_frame_yuv_->linesize);

    current_time_ms_ = pts_ms;
    js_on_video_frame(video_width_,
                      video_height_,
                      reinterpret_cast<intptr_t>(video_frame_yuv_->data[0]),
                      video_frame_yuv_->linesize[0],
                      reinterpret_cast<intptr_t>(video_frame_yuv_->data[1]),
                      video_frame_yuv_->linesize[1],
                      reinterpret_cast<intptr_t>(video_frame_yuv_->data[2]),
                      video_frame_yuv_->linesize[2],
                      pts_ms,
                      (src->flags & AV_FRAME_FLAG_KEY) || src->pict_type == AV_PICTURE_TYPE_I ? 1 : 0,
                      video_dec_ctx_->codec && video_dec_ctx_->codec->name ? video_dec_ctx_->codec->name : "unknown");
  }

  void outputAudioFrame(AVFrame* src, double pts_ms) {
    if (!swr_ctx_ || !audio_dec_ctx_) {
      return;
    }

    const int channels = audio_dec_ctx_->ch_layout.nb_channels > 0 ? audio_dec_ctx_->ch_layout.nb_channels : 2;

    const int dst_samples = av_rescale_rnd(
      swr_get_delay(swr_ctx_, audio_dec_ctx_->sample_rate) + src->nb_samples,
      audio_dec_ctx_->sample_rate,
      audio_dec_ctx_->sample_rate,
      AV_ROUND_UP);

    audio_f32_.resize(static_cast<size_t>(dst_samples) * static_cast<size_t>(channels));

    uint8_t* out_data[1] = {reinterpret_cast<uint8_t*>(audio_f32_.data())};
    const int converted = swr_convert(
      swr_ctx_,
      out_data,
      dst_samples,
      const_cast<const uint8_t**>(src->extended_data),
      src->nb_samples);

    if (converted <= 0) {
      return;
    }

    if (video_stream_index_ < 0) {
      current_time_ms_ = pts_ms;
    }
    js_on_audio_frame(channels,
                      audio_dec_ctx_->sample_rate,
                      converted,
                      reinterpret_cast<intptr_t>(audio_f32_.data()),
                      pts_ms,
                      audio_dec_ctx_->codec && audio_dec_ctx_->codec->name ? audio_dec_ctx_->codec->name : "unknown");
  }

  void cleanupInput(AVFormatContext* fmt) {
    if (!fmt) {
      return;
    }

    if (fmt->pb) {
      AVIOContext* pb = fmt->pb;
      avformat_close_input(&fmt);
      if (pb) {
        av_freep(&pb->buffer);
        avio_context_free(&pb);
      }
    } else {
      avformat_close_input(&fmt);
    }
  }

  void logError(const char* prefix, int err) {
    char buf[256];
    av_strerror(err, buf, sizeof(buf));
    std::string msg = std::string(prefix) + ": " + buf;
    js_on_log(3, msg.c_str());
  }

  AVCodecContext* video_dec_ctx_ = nullptr;
  AVCodecContext* audio_dec_ctx_ = nullptr;
  AVBSFContext* video_bsf_ctx_ = nullptr;

  SwsContext* sws_ctx_ = nullptr;
  SwrContext* swr_ctx_ = nullptr;

  AVFrame* video_frame_yuv_ = nullptr;
  uint8_t* video_buffer_ = nullptr;
  int video_width_ = 0;
  int video_height_ = 0;
  int video_src_pix_fmt_ = AV_PIX_FMT_NONE;

  double current_time_ms_ = 0.0;
  int video_stream_index_ = -1;
  int audio_stream_index_ = -1;
  int64_t last_video_dts_us_ = AV_NOPTS_VALUE;
  int64_t last_audio_dts_us_ = AV_NOPTS_VALUE;
  bool waiting_for_video_keyframe_ = true;

  std::vector<uint8_t> init_segment_;
  std::vector<uint8_t> segment_buffer_;
  std::vector<float> audio_f32_;
};

std::unordered_map<int, std::unique_ptr<Player>> g_players;
int g_next_handle = 1;

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
int player_create() {
  static bool log_initialized = false;
  if (!log_initialized) {
    av_log_set_callback(custom_av_log_callback);
    log_initialized = true;
  }
  const int handle = g_next_handle++;
  g_players.emplace(handle, std::make_unique<Player>());
  return handle;
}

EMSCRIPTEN_KEEPALIVE
void player_destroy(int handle) {
  auto it = g_players.find(handle);
  if (it != g_players.end()) {
    g_players.erase(it);
  }
}

EMSCRIPTEN_KEEPALIVE
int player_feed_segment(int handle, const uint8_t* data, size_t size, int is_init_segment) {
  auto it = g_players.find(handle);
  if (it == g_players.end()) {
    return AVERROR(EINVAL);
  }
  return it->second->feedSegment(data, size, is_init_segment != 0);
}

EMSCRIPTEN_KEEPALIVE
void player_reset(int handle) {
  auto it = g_players.find(handle);
  if (it == g_players.end()) {
    return;
  }
  it->second->reset();
}

EMSCRIPTEN_KEEPALIVE
double player_get_current_time(int handle) {
  auto it = g_players.find(handle);
  if (it == g_players.end()) {
    return 0.0;
  }
  return it->second->getCurrentTime();
}

}  // extern "C"
