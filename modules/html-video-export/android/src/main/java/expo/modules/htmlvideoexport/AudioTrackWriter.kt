package expo.modules.htmlvideoexport

import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.util.Base64
import java.util.ArrayDeque

/** Negotiated AAC track parameters, from the page's audio-config message. */
internal data class AudioSpec(val sampleRate: Int, val channels: Int)

/**
 * Owns the MP4 audio track for either recorder session. AAC access units
 * arrive as raw frames (no ADTS headers); the track's codec-specific data is
 * the two-byte AudioSpecificConfig derived from the negotiated format.
 *
 * Samples are queued until the session hands over a started muxer, so audio
 * chunks that arrive before the video track exists (or before the JPEG
 * fallback's muxer starts) are never lost — only reordered behind the video
 * start, which MediaMuxer tolerates as long as each track's own timestamps
 * increase.
 */
internal class AudioTrackWriter(private val spec: AudioSpec) {
  private val format: MediaFormat = aacFormat(spec.sampleRate, spec.channels)
  private val pending: ArrayDeque<Pair<Long, ByteArray>> = ArrayDeque()
  private var trackIndex = -1
  private var lastPtsUs = -1L

  /** Number of audio samples actually muxed. Drives the `hasAudio` result. */
  var samplesWritten = 0L
    private set

  /** Last audio timestamp muxed, in microseconds. Drives coverage checks. */
  val audioDurationUs: Long
    get() = if (samplesWritten == 0L) 0L else lastPtsUs + 1024L * 1_000_000 / spec.sampleRate

  fun addTrack(muxer: MediaMuxer): Int {
    trackIndex = muxer.addTrack(format)
    return trackIndex
  }

  @Synchronized
  fun enqueue(timestampMicros: Long, base64: String) {
    enqueue(timestampMicros, Base64.decode(base64, Base64.DEFAULT))
  }

  @Synchronized
  fun enqueue(timestampMicros: Long, bytes: ByteArray) {
    if (pending.size >= MAX_PENDING_SAMPLES) {
      pending.removeFirst()
    }
    pending.addLast(timestampMicros to bytes)
  }

  /**
   * Writes every queued sample. No-op until [addTrack] ran on a started
   * muxer; callers simply retry on every push.
   */
  @Synchronized
  fun drainTo(muxer: MediaMuxer?) {
    if (muxer == null || trackIndex < 0) return
    while (true) {
      val (pts, bytes) = pending.pollFirst() ?: return
      writeSample(muxer, pts, bytes)
    }
  }

  private fun writeSample(muxer: MediaMuxer, timestampMicros: Long, bytes: ByteArray) {
    if (bytes.isEmpty()) return
    // MediaMuxer requires non-decreasing timestamps per track.
    val pts = maxOf(timestampMicros, lastPtsUs + 1)
    lastPtsUs = pts
    val info = android.media.MediaCodec.BufferInfo()
    info.set(0, bytes.size, pts, 0)
    muxer.writeSampleData(trackIndex, directWrap(bytes), info)
    samplesWritten += 1
  }

  companion object {
    private const val MAX_PENDING_SAMPLES = 4000

    private val SAMPLE_RATE_INDEX = mapOf(
      96000 to 0, 88200 to 1, 64000 to 2, 48000 to 3, 44100 to 4,
      32000 to 5, 24000 to 6, 22050 to 7, 16000 to 8, 12000 to 9,
      11025 to 10, 8000 to 11,
    )

    internal fun aacAudioSpecificConfig(sampleRate: Int, channels: Int): ByteArray {
      val index = SAMPLE_RATE_INDEX[sampleRate]
        ?: throw IllegalArgumentException("Unsupported audio sample rate: $sampleRate")
      require(channels in 1..2) { "Unsupported audio channel count: $channels" }
      // audioObjectType (AAC-LC = 2) in 5 bits, then sampling index in 4 bits,
      // then channel configuration in 4 bits.
      return byteArrayOf(
        ((0x02 shl 3) or (index shr 1)).toByte(),
        (((index and 0x01) shl 7) or (channels shl 3)).toByte(),
      )
    }

    internal fun aacFormat(sampleRate: Int, channels: Int): MediaFormat {
      val format = MediaFormat.createAudioFormat(
        MediaFormat.MIMETYPE_AUDIO_AAC,
        sampleRate,
        channels,
      )
      format.setInteger(
        MediaFormat.KEY_AAC_PROFILE,
        MediaCodecInfo.CodecProfileLevel.AACObjectLC,
      )
      format.setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
      format.setByteBuffer(
        "csd-0",
        directWrap(aacAudioSpecificConfig(sampleRate, channels)),
      )
      return format
    }
  }
}
