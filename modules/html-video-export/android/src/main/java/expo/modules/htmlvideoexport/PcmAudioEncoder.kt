package expo.modules.htmlvideoexport

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.os.SystemClock

/** Encodes interleaved PCM16 from WebAudio without depending on WebCodecs. */
internal class PcmAudioEncoder(
  private val spec: AudioSpec,
  private val onSample: (Long, ByteArray) -> Unit,
) {
  private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
  private val info = MediaCodec.BufferInfo()
  private var nextPtsUs = 0L
  private var closed = false
  private var ended = false

  init {
    try {
      val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, spec.sampleRate, spec.channels)
      format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      format.setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
      codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      codec.start()
    } catch (error: Exception) {
      codec.release()
      throw error
    }
  }

  fun push(timestampMicros: Long, bytes: ByteArray) {
    check(!closed && !ended) { "The PCM audio encoder has stopped." }
    val frameBytes = spec.channels * 2
    require(bytes.size % frameBytes == 0) { "PCM audio must contain complete interleaved frames." }
    var offset = 0
    val basePts = maxOf(0L, timestampMicros, nextPtsUs)
    while (offset < bytes.size) {
      val index = inputBuffer()
      val buffer = codec.getInputBuffer(index) ?: error("Missing AAC encoder input buffer.")
      buffer.clear()
      val length = minOf(bytes.size - offset, buffer.remaining()) / frameBytes * frameBytes
      check(length > 0) { "The AAC encoder input buffer is too small." }
      buffer.put(bytes, offset, length)
      val pts = basePts + (offset / frameBytes) * 1_000_000L / spec.sampleRate
      codec.queueInputBuffer(index, 0, length, pts, 0)
      offset += length
      drain(0L)
    }
    nextPtsUs = basePts + (bytes.size / frameBytes) * 1_000_000L / spec.sampleRate
  }

  /** EOS must be drained before the MP4 muxer is stopped. */
  fun finish() {
    if (closed) return
    try {
      val index = inputBuffer()
      codec.queueInputBuffer(index, 0, 0, nextPtsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
      val deadline = SystemClock.elapsedRealtime() + 8_000
      while (!ended && SystemClock.elapsedRealtime() < deadline) drain(10_000L)
      check(ended) { "Timed out finishing AAC audio." }
    } finally {
      close()
    }
  }

  fun close() {
    if (closed) return
    closed = true
    try { codec.stop() } catch (_: Exception) {} finally { codec.release() }
  }

  private fun inputBuffer(): Int {
    val deadline = SystemClock.elapsedRealtime() + 8_000
    while (SystemClock.elapsedRealtime() < deadline) {
      val index = codec.dequeueInputBuffer(10_000L)
      if (index >= 0) return index
      drain(0L)
    }
    error("Timed out waiting for an AAC encoder input buffer.")
  }

  private fun drain(timeoutUs: Long) {
    var wait = timeoutUs
    while (true) {
      val index = codec.dequeueOutputBuffer(info, wait)
      wait = 0L
      when {
        index == MediaCodec.INFO_TRY_AGAIN_LATER -> return
        index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          // AAC-LC's AudioSpecificConfig is supplied by AudioTrackWriter.
        }
        index >= 0 -> {
          try {
            if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
              val buffer = codec.getOutputBuffer(index) ?: error("Missing AAC encoder output buffer.")
              buffer.position(info.offset)
              buffer.limit(info.offset + info.size)
              val bytes = ByteArray(info.size)
              buffer.get(bytes)
              onSample(maxOf(0L, info.presentationTimeUs), bytes)
            }
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) ended = true
          } finally {
            codec.releaseOutputBuffer(index, false)
          }
          if (ended) return
        }
        else -> return
      }
    }
  }
}
