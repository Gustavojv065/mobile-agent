package expo.modules.htmlvideoexport

import android.media.MediaCodec
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.util.Base64
import java.io.File
import java.nio.ByteBuffer

/**
 * Wraps a hardware H.264 elementary stream (encoded by WebCodecs inside the
 * WebView) into an MP4 container. No re-encoding happens here — the compressed
 * payload is written straight into MediaMuxer, so this is near-zero work.
 *
 * The page sends Annex-B NAL units with start codes. SPS/PPS are delivered
 * separately (as hex, from the first key frame) and attached to the track via
 * the csd-0/csd-1 media format keys.
 */
internal class H264RemuxSession(
  private val outputPath: String,
  private val width: Int,
  private val height: Int,
  private val fps: Int,
  private val spsHex: String,
  private val ppsHex: String,
  private val audioSpec: AudioSpec? = null,
  private val bufferedAudio: List<Pair<Long, ByteArray>> = emptyList(),
) : ExportSession, AudioCapable {
  /** `MediaMuxer`/`File` need a raw path; the page hands us a `file://` URI. */
  private val filePath = fileUriToPath(outputPath)
  private var muxer: MediaMuxer? = null
  private var trackIndex = -1
  private var audio: AudioTrackWriter? = null
  private var finished = false

  fun begin() {
    val file = File(filePath)
    file.parentFile?.mkdirs()
    if (file.exists()) file.delete()

    val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
    format.setString("csd-0", spsHex)
    format.setString("csd-1", ppsHex)
    format.setInteger(MediaFormat.KEY_BIT_RATE, bitrateFor(width, height))
    format.setInteger(MediaFormat.KEY_FRAME_RATE, fps)

    val muxer = MediaMuxer(filePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    trackIndex = muxer.addTrack(format)
    val audioSpec = this.audioSpec
    if (audioSpec != null) {
      val writer = AudioTrackWriter(audioSpec)
      writer.addTrack(muxer)
      audio = writer
      for ((pts, bytes) in bufferedAudio) {
        writer.enqueue(pts, bytes)
      }
    }
    muxer.start()
    this.muxer = muxer
    // Samples may only be written once the muxer has started; replay the audio
    // that arrived before the video track existed.
    audio?.drainTo(muxer)
  }

  @Synchronized
  fun pushChunk(keyFrame: Boolean, timestampMicros: Long, base64: String) {
    val muxer = this.muxer ?: throw IllegalStateException("The muxer has not started.")
    if (finished) return
    val bytes = Base64.decode(base64, Base64.DEFAULT)
    val buffer = ByteBuffer.wrap(bytes)
    val info = MediaCodec.BufferInfo()
    info.set(
      0,
      bytes.size,
      timestampMicros,
      if (keyFrame) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0,
    )
    muxer.writeSampleData(trackIndex, buffer, info)
  }

  @Synchronized
  override fun pushAudio(timestampMicros: Long, bytes: ByteArray) {
    if (finished) return
    val writer = audio ?: return
    writer.enqueue(timestampMicros, bytes)
    writer.drainTo(muxer)
  }

  @Synchronized
  override fun finish(): Triple<String, Long, Boolean> {
    if (!finished) {
      finished = true
      val muxer = this.muxer
      this.muxer = null
      if (muxer != null) {
        try {
          muxer.stop()
        } catch (_: Exception) {
          // No samples were written; nothing to finalize.
        }
        muxer.release()
      }
    }
    return Triple(outputPath, File(filePath).length(), (audio?.samplesWritten ?: 0) > 0)
  }

  @Synchronized
  override fun cancel() {
    finished = true
    val muxer = this.muxer
    this.muxer = null
    if (muxer != null) {
      try {
        muxer.stop()
      } catch (_: Exception) {
      }
      muxer.release()
    }
    File(filePath).delete()
  }
}

/** Rough VBR target in bits per second, by output resolution. */
internal fun bitrateFor(width: Int, height: Int): Int {
  val pixels = width * height
  return when {
    pixels <= 640 * 360 -> 2_000_000
    pixels <= 1280 * 720 -> 6_000_000
    pixels <= 1920 * 1080 -> 12_000_000
    else -> 16_000_000
  }
}

/**
 * `MediaMuxer` and `java.io.File` take a filesystem path, but the JS layer hands
 * us the `file://` URI from `expo-file-system`'s `File`. Passing that URI through
 * makes the encoder try to open a path literally beginning with `file:` and fail
 * with `ENOENT`, so strip the scheme (and decode any percent-escapes).
 */
internal fun fileUriToPath(uriOrPath: String): String {
  if (!uriOrPath.startsWith("file:")) {
    return uriOrPath
  }
  return try {
    Uri.parse(uriOrPath).path ?: uriOrPath.removePrefix("file:")
  } catch (_: Exception) {
    uriOrPath.removePrefix("file:")
  }
}