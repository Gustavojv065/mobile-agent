package expo.modules.htmlvideoexport

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.SystemClock
import android.util.Base64
import java.io.File

/**
 * Native export: one JPEG at a time becomes a flexible YUV420 input image.
 * MediaCodec owns codec configuration and access-unit framing. Input PTS is
 * frame-index based, so exports may run slower than realtime without changing
 * their playback timing. No input frames are silently discarded.
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
  private var muxer: MediaMuxer? = null
  private var muxerStarted = false
  private var trackIndex = -1
  private var audio: AudioTrackWriter? = null
  private var finished = false
  private val bufferInfo = MediaCodec.BufferInfo()
  private var submittedFrames = 0
  private var writtenFrames = 0
  private var eosReceived = false
  private val pixels = IntArray(width * height)

  fun begin() {
    android.util.Log.d("HtmlVideoExport", "beginFrames ${width}x${height}@${fps} build=native-yuv-v1")
    val file = File(filePath)
    file.parentFile?.mkdirs()
    if (file.exists()) file.delete()

    val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
    format.setInteger(MediaFormat.KEY_BIT_RATE, bitrateFor(width, height))
    format.setInteger(MediaFormat.KEY_FRAME_RATE, fps)
    format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    format.setInteger(
      MediaFormat.KEY_COLOR_FORMAT,
      MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible,
    )
    // No frame reordering: one submitted image maps to one output access unit.
    format.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)

    val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    codec.start()

    this.codec = codec
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
    check(!finished) { "The video encoder has stopped." }
    require(index == submittedFrames) { "Expected frame $submittedFrames, received $index." }

    val bytes = Base64.decode(base64, Base64.DEFAULT)
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
      ?: throw IllegalStateException("A frame could not be decoded from the page.")
    val source = if (decoded.width == width && decoded.height == height) {
      decoded
    } else {
      Bitmap.createScaledBitmap(decoded, width, height, true)
    }

    try {
      val deadline = SystemClock.elapsedRealtime() + 15_000
      var input = codec.dequeueInputBuffer(10_000)
      while (input < 0 && SystemClock.elapsedRealtime() < deadline) {
        drain(false)
        input = codec.dequeueInputBuffer(10_000)
      }
      check(input >= 0) { "Timed out waiting for a video input buffer." }
      val size = codec.getInputBuffer(input)?.capacity() ?: error("Missing AVC input buffer.")
      val image = codec.getInputImage(input)
        ?: error("This AVC encoder does not expose flexible YUV input images.")
      try {
        writeYuv(source, image)
      } finally {
        image.close()
      }
      codec.queueInputBuffer(input, 0, size, index * 1_000_000L / fps, 0)
      submittedFrames += 1
      // The codec now owns this input buffer; release the page to render the
      // next image. Some encoders need multiple inputs before emitting output.
      // Waiting for output here would deadlock those encoders. Input-buffer
      // availability above supplies the bounded native backpressure instead.
      drain(false)
    } finally {
      if (source !== decoded) source.recycle()
      decoded.recycle()
    }
  }

  @Synchronized
  override fun pushAudio(timestampMicros: Long, bytes: ByteArray) {
    if (finished) return
    val writer = audio ?: return
    writer.enqueue(timestampMicros, bytes)
    writer.drainTo(if (muxerStarted) muxer else null)
  }

  @Synchronized
  override fun finish(): ExportResult {
    if (finished) return ExportResult(outputPath, File(filePath).length(), (audio?.samplesWritten ?: 0) > 0, audio?.audioDurationUs ?: 0L)
    finished = true
    try {
      val codec = this.codec ?: error("The video encoder has stopped.")
      val input = codec.dequeueInputBuffer(1_000_000)
      check(input >= 0) { "Timed out submitting video end-of-stream." }
      codec.queueInputBuffer(input, 0, 0, submittedFrames * 1_000_000L / fps, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
      drainUntilDone()
      check(eosReceived) { "Timed out finishing the video encoder." }
      check(writtenFrames == submittedFrames && writtenFrames > 0) { "Video encoder did not write every frame." }
    } finally {
      release(finalizing = true)
    }
    return ExportResult(outputPath, File(filePath).length(), (audio?.samplesWritten ?: 0) > 0, audio?.audioDurationUs ?: 0L)
  }

  @Synchronized
  override fun cancel() {
    finished = true
    release()
    File(filePath).delete()
  }

  /** Respect each vendor's row/pixel strides; never assume I420 or NV12. */
  private fun writeYuv(bitmap: Bitmap, image: android.media.Image) {
    bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
    val planes = image.planes
    val origins = planes.map { it.buffer.position() }
    for (y in 0 until height) {
      for (x in 0 until width) {
        val color = pixels[y * width + x]
        val r = (color shr 16) and 255
        val g = (color shr 8) and 255
        val b = color and 255
        val luma = (((66 * r + 129 * g + 25 * b + 128) shr 8) + 16).coerceIn(0, 255)
        planes[0].buffer.put(origins[0] + y * planes[0].rowStride + x * planes[0].pixelStride, luma.toByte())
        if (x % 2 == 0 && y % 2 == 0) {
          // Average chroma across the 2x2 block rather than subsampling one pixel.
          var rr = 0; var gg = 0; var bb = 0
          for (dy in 0..1) for (dx in 0..1) {
            val c = pixels[(y + dy) * width + x + dx]
            rr += (c shr 16) and 255; gg += (c shr 8) and 255; bb += c and 255
          }
          rr /= 4; gg /= 4; bb /= 4
          val u = (((-38 * rr - 74 * gg + 112 * bb + 128) shr 8) + 128).coerceIn(0, 255)
          val v = (((112 * rr - 94 * gg - 18 * bb + 128) shr 8) + 128).coerceIn(0, 255)
          planes[1].buffer.put(origins[1] + (y / 2) * planes[1].rowStride + (x / 2) * planes[1].pixelStride, u.toByte())
          planes[2].buffer.put(origins[2] + (y / 2) * planes[2].rowStride + (x / 2) * planes[2].pixelStride, v.toByte())
        }
      }
    }
  }

  private fun drain(blocking: Boolean) {
    val codec = this.codec ?: return
    val muxer = this.muxer ?: return
    while (true) {
      val outIndex = codec.dequeueOutputBuffer(bufferInfo, if (blocking) 5_000L else 1_000L)
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
      buffer.position(bufferInfo.offset)
      buffer.limit(bufferInfo.offset + bufferInfo.size)
      muxer.writeSampleData(trackIndex, buffer, bufferInfo)
      writtenFrames += 1
    }
    codec.releaseOutputBuffer(outIndex, false)
    if (endOfStream) eosReceived = true
    return endOfStream
  }

  private fun release(finalizing: Boolean = false) {
    try {
      codec?.stop()
    } catch (_: Exception) {
    }
    try {
      codec?.release()
    } catch (_: Exception) {
    }
    codec = null
    var muxerError: Exception? = null
    try {
      if (muxerStarted) muxer?.stop()
    } catch (error: Exception) {
      muxerError = error
    }
    try {
      muxer?.release()
    } catch (_: Exception) {
    }
    muxer = null
    muxerStarted = false
    if (finalizing && muxerError != null) throw muxerError
    if (finalizing) android.util.Log.d("HtmlVideoExport", "finishFrames submitted=$submittedFrames written=$writtenFrames")
  }
}
