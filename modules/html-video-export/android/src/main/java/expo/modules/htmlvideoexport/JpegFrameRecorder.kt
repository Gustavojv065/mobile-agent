package expo.modules.htmlvideoexport

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Build
import android.util.Base64
import android.view.Surface
import java.io.File

/**
 * Fallback recorder for WebViews without WebCodecs: JPEG frames posted from
 * the page are decoded and drawn onto the hardware encoder's input surface
 * (GPU-accelerated when available via `lockHardwareCanvas`), then muxed into
 * an MP4. Presentation timestamps come from the frame index, so the timeline
 * stays deterministic even if frames are dropped under load.
 */
internal class JpegFrameRecorder(
  private val outputPath: String,
  private val width: Int,
  private val height: Int,
  private val fps: Int,
  private val audioSpec: AudioSpec? = null,
  private val bufferedAudio: List<Pair<Long, ByteArray>> = emptyList(),
) : ExportSession, AudioCapable {
  /** `MediaMuxer`/`File` need a raw path; the page hands us a `file://` URI. */
  private val filePath = fileUriToPath(outputPath)
  private var codec: MediaCodec? = null
  private var surface: Surface? = null
  private var muxer: MediaMuxer? = null
  private var muxerStarted = false
  private var trackIndex = -1
  private var audio: AudioTrackWriter? = null
  private var finished = false
  private val bufferInfo = MediaCodec.BufferInfo()
  private var pendingTimestampUs = 0L

  fun begin() {
    val file = File(filePath)
    file.parentFile?.mkdirs()
    if (file.exists()) file.delete()

    val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
    format.setInteger(MediaFormat.KEY_BIT_RATE, bitrateFor(width, height))
    format.setInteger(MediaFormat.KEY_FRAME_RATE, fps)
    format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    format.setInteger(
      MediaFormat.KEY_COLOR_FORMAT,
      MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface,
    )

    val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    val surface = codec.createInputSurface()
    codec.start()

    this.codec = codec
    this.surface = surface
    if (audioSpec != null) {
      val writer = AudioTrackWriter(audioSpec)
      for ((pts, bytes) in bufferedAudio) {
        writer.enqueue(pts, bytes)
      }
      audio = writer
    }
    muxer = MediaMuxer(filePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
  }

  @Synchronized
  fun pushFrame(index: Int, base64: String) {
    val codec = this.codec ?: throw IllegalStateException("The encoder has not started.")
    val surface = this.surface ?: throw IllegalStateException("The input surface is not ready.")
    if (finished) return

    pendingTimestampUs = index * 1_000_000L / fps

    val bytes = Base64.decode(base64, Base64.DEFAULT)
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
      ?: throw IllegalStateException("A frame could not be decoded from the page.")
    val source = if (decoded.width == width && decoded.height == height) {
      decoded
    } else {
      Bitmap.createScaledBitmap(decoded, width, height, true)
    }

    val canvas = lockCanvas(surface)
    canvas.drawColor(Color.BLACK)
    canvas.drawBitmap(source, null, Rect(0, 0, width, height), null)
    surface.unlockCanvasAndPost(canvas)

    if (source !== decoded) source.recycle()
    decoded.recycle()

    drain(false)
  }

  @Synchronized
  override fun pushAudio(timestampMicros: Long, bytes: ByteArray) {
    if (finished) return
    val writer = audio ?: return
    writer.enqueue(timestampMicros, bytes)
    writer.drainTo(if (muxerStarted) muxer else null)
  }

  @Synchronized
  override fun finish(): Triple<String, Long, Boolean> {
    if (finished) return Triple(outputPath, File(filePath).length(), (audio?.samplesWritten ?: 0) > 0)
    finished = true
    try {
      codec?.signalEndOfInputStream()
    } catch (_: Exception) {
    }
    drainUntilDone()
    release()
    return Triple(outputPath, File(filePath).length(), (audio?.samplesWritten ?: 0) > 0)
  }

  @Synchronized
  override fun cancel() {
    finished = true
    release()
    File(filePath).delete()
  }

  private fun lockCanvas(surface: Surface): Canvas {
    if (Build.VERSION.SDK_INT >= 26) {
      try {
        return surface.lockHardwareCanvas()
      } catch (_: Exception) {
        // Fall back to the software canvas on devices without HW canvas support.
      }
    }
    return surface.lockCanvas(null)
  }

  private fun drain(blocking: Boolean) {
    val codec = this.codec ?: return
    val muxer = this.muxer ?: return
    while (true) {
      val outIndex = codec.dequeueOutputBuffer(bufferInfo, if (blocking) 5_000L else 0L)
      when {
        outIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> if (!blocking) return
        outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          if (!muxerStarted) {
            trackIndex = muxer.addTrack(codec.outputFormat)
            audio?.addTrack(muxer)
            muxer.start()
            muxerStarted = true
            audio?.drainTo(muxer)
          }
        }
        outIndex >= 0 -> if (writeOutput(codec, muxer, outIndex)) return
        else -> return
      }
    }
  }

  private fun drainUntilDone() {
    val deadline = System.currentTimeMillis() + 8_000
    while (System.currentTimeMillis() < deadline) {
      val codec = this.codec ?: return
      val muxer = this.muxer ?: return
      val outIndex = codec.dequeueOutputBuffer(bufferInfo, 100)
      when {
        outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          if (!muxerStarted) {
            trackIndex = muxer.addTrack(codec.outputFormat)
            audio?.addTrack(muxer)
            muxer.start()
            muxerStarted = true
            audio?.drainTo(muxer)
          }
        }
        outIndex >= 0 -> if (writeOutput(codec, muxer, outIndex)) return
        else -> Unit
      }
    }
  }

  /** Writes one encoded buffer; returns true when it was the end-of-stream marker. */
  private fun writeOutput(codec: MediaCodec, muxer: MediaMuxer, outIndex: Int): Boolean {
    val buffer = codec.getOutputBuffer(outIndex) ?: run {
      codec.releaseOutputBuffer(outIndex, false)
      return false
    }
    val endOfStream = bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
    val isCodecConfig = bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
    if (!isCodecConfig && bufferInfo.size > 0 && muxerStarted) {
      bufferInfo.presentationTimeUs = pendingTimestampUs
      buffer.position(bufferInfo.offset)
      buffer.limit(bufferInfo.offset + bufferInfo.size)
      muxer.writeSampleData(trackIndex, buffer, bufferInfo)
    }
    codec.releaseOutputBuffer(outIndex, false)
    return endOfStream
  }

  private fun release() {
    try {
      codec?.stop()
    } catch (_: Exception) {
    }
    try {
      codec?.release()
    } catch (_: Exception) {
    }
    codec = null
    try {
      surface?.release()
    } catch (_: Exception) {
    }
    surface = null
    try {
      if (muxerStarted) muxer?.stop()
    } catch (_: Exception) {
    }
    try {
      muxer?.release()
    } catch (_: Exception) {
    }
    muxer = null
    muxerStarted = false
  }
}