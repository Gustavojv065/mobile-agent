package expo.modules.htmlvideoexport

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
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
  /**
   * Codec name pinned for the whole run (see the module). When set, only this
   * codec may encode this segment: SegmentConcat sample-copies access units
   * of all segments into ONE output track described by the first segment's
   * SPS/PPS, so segments encoded by different codecs corrupt the output
   * (decoder desync). Not nullable after the run's first begin.
   */
  private val pinnedEncoder: String? = null,
) : ExportSession, AudioCapable {
  /** Codec actually opened by `begin()`; surfaced in the export result. */
  var encoderName: String = ""
    private set
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
  // Reused row scratch so the YUV conversion below issues one bulk put per
  // plane row instead of ~500k absolute single-byte puts per frame.
  private val lumaRow = ByteArray(width)
  private val chromaRowU = ByteArray((width + 1) / 2)
  private val chromaRowV = ByteArray((width + 1) / 2)
  // Per-stage cost, logged periodically: JPEG decode, RGB->YUV conversion and
  // waiting on the encoder are three different problems with three different
  // fixes, and the page-side "bridge" timing cannot tell them apart.
  private var statFrames = 0
  private var statDecodeMs = 0L
  private var statConvertMs = 0L
  private var statQueueMs = 0L

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

    val codec = startEncoder(format)

    this.codec = codec
    try {
      if (audioSpec != null) {
        val writer = AudioTrackWriter(audioSpec)
        for ((pts, bytes) in bufferedAudio) {
          writer.enqueue(pts, bytes)
        }
        audio = writer
      }
      muxer = MediaMuxer(filePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    } catch (error: Exception) {
      // The codec is running; do not leak it because the muxer failed.
      try { codec.release() } catch (_: Exception) {}
      this.codec = null
      throw error
    }
  }

  /**
   * Opens and starts an AVC encoder, hardware first with the software encoder
   * as a guaranteed-last fallback. Devices cap concurrent codec instances per
   * process; a WebView holding several clip decoders plus this encoder can
   * exhaust them, and MediaCodec then fails configure/start with
   * CodecException (often error 0xfffffff4 = -12, ENOMEM). A failed configure
   * or start also leaves a half-opened codec, which is released here before
   * the next attempt — without that, every retry starts one instance poorer
   * and the resource error repeats forever.
   *
   * When `pinnedEncoder` is set (every segment after the first of a run), it
   * is the ONLY codec tried, retried with backoff: SegmentConcat muxes all
   * segments' access units under the first segment's SPS/PPS, so switching
   * codecs mid-run would desync the decoder (green macroblock corruption)
   * instead of failing. Consistency is therefore enforced here, loudly.
   *
   * Each attempt releases its codec on failure and backs off briefly before
   * the next candidate. If everything fails, the last codec exception is
   * rethrown with an actionable message.
   */
  private fun startEncoder(format: MediaFormat): MediaCodec {
    var candidates = mutableListOf<String>()
    if (pinnedEncoder != null) {
      // Same codec only: up to three spaced attempts for transient resource
      // exhaustion, then fail the segment with the cause. The run never
      // silently mixes encoders.
      for (attempt in 0 until 3) candidates.add(pinnedEncoder)
    } else {
      val hardware = mutableListOf<String>()
      val software = mutableListOf<String>()
      for (info in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
        if (!info.isEncoder) continue
        if (info.supportedTypes.none { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC, ignoreCase = true) }) continue
        val softwareOnly = try {
          info.isSoftwareOnly
        } catch (_: Exception) {
          info.name.startsWith("OMX.google") || info.name.startsWith("c2.android")
        }
        if (softwareOnly) software.add(info.name) else hardware.add(info.name)
      }
      // Try the primary hardware encoder once more after a backoff before
      // falling back to software: transient resource exhaustion usually clears
      // once the failed attempt's codec is released.
      hardware.firstOrNull()?.let { candidates.add(it); candidates.add(it) }
      hardware.drop(1).forEach { candidates.add(it) }
      software.forEach { candidates.add(it) }
    }
    require(candidates.isNotEmpty()) { "This device has no AVC encoder." }
    val attemptLabel = if (pinnedEncoder != null) "pinned" else "plan"

    var lastError: Exception? = null
    for ((attempt, name) in candidates.withIndex()) {
      val codec: MediaCodec
      try {
        codec = MediaCodec.createByCodecName(name)
      } catch (error: Exception) {
        lastError = error
        continue
      }
      try {
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
        android.util.Log.d("HtmlVideoExport", "encoder started: $name ($attemptLabel attempt $attempt) ${width}x${height}@${fps}")
        encoderName = name
        return codec
      } catch (error: Exception) {
        lastError = error
        try { codec.release() } catch (_: Exception) {}
        // Give the system a beat to reclaim the freed codec slot; long
        // enough to matter, short enough to keep the segment's watchdog calm.
        try { Thread.sleep(300) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
      }
    }
    throw IllegalStateException(
      "The device's video encoder could not start " +
        "(codec resources are exhausted; MediaCodec error ${errorCodeOf(lastError)}). " +
        "Close other apps or reload the scene, then run the export again.",
      lastError,
    )
  }

  private fun errorCodeOf(error: Exception?): String {
    val codecError = error as? MediaCodec.CodecException ?: return "unknown"
    return "0x%08x".format(codecError.errorCode)
  }

  @Synchronized
  fun pushFrame(index: Int, base64: String) {
    val codec = this.codec ?: throw IllegalStateException("The encoder has not started.")
    check(!finished) { "The video encoder has stopped." }
    require(index == submittedFrames) { "Expected frame $submittedFrames, received $index." }

    val bytes = Base64.decode(base64, Base64.DEFAULT)
    val decodeStarted = SystemClock.elapsedRealtime()
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
      ?: throw IllegalStateException("A frame could not be decoded from the page.")
    val source = if (decoded.width == width && decoded.height == height) {
      decoded
    } else {
      Bitmap.createScaledBitmap(decoded, width, height, true)
    }
    statDecodeMs += SystemClock.elapsedRealtime() - decodeStarted

    try {
      // Waiting for an input buffer is encoder backpressure, not conversion
      // work: it is timed as "queue" so a slow encoder cannot masquerade as a
      // slow YUV loop.
      val queueStarted = SystemClock.elapsedRealtime()
      val deadline = SystemClock.elapsedRealtime() + 15_000
      var input = codec.dequeueInputBuffer(10_000)
      while (input < 0 && SystemClock.elapsedRealtime() < deadline) {
        drain(false)
        input = codec.dequeueInputBuffer(10_000)
      }
      check(input >= 0) { "Timed out waiting for a video input buffer." }
      val size = codec.getInputBuffer(input)?.capacity() ?: error("Missing AVC input buffer.")
      val queuedAt = SystemClock.elapsedRealtime()
      statQueueMs += queuedAt - queueStarted

      val convertStarted = queuedAt
      val image = codec.getInputImage(input)
        ?: error("This AVC encoder does not expose flexible YUV input images.")
      try {
        writeYuv(source, image)
      } finally {
        image.close()
      }
      statConvertMs += SystemClock.elapsedRealtime() - convertStarted

      val flushStarted = SystemClock.elapsedRealtime()
      codec.queueInputBuffer(input, 0, size, index * 1_000_000L / fps, 0)
      submittedFrames += 1
      // The codec now owns this input buffer; release the page to render the
      // next image. Some encoders need multiple inputs before emitting output.
      // Waiting for output here would deadlock those encoders. Input-buffer
      // availability above supplies the bounded native backpressure instead.
      drain(false)
      statQueueMs += SystemClock.elapsedRealtime() - flushStarted
      statFrames += 1
      if (statFrames % 300 == 0) logStageStats()
    } finally {
      if (source !== decoded) source.recycle()
      decoded.recycle()
    }
  }

  /** Average cost per frame of each native stage, in the logcat stream. */
  private fun logStageStats() {
    val n = statFrames.coerceAtLeast(1)
    android.util.Log.d(
      "HtmlVideoExport",
      "frameStages n=$statFrames decode=${statDecodeMs / n}ms convert=${statConvertMs / n}ms " +
        "queue=${statQueueMs / n}ms",
    )
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
    return ExportResult(outputPath, File(filePath).length(), (audio?.samplesWritten ?: 0) > 0, audio?.audioDurationUs ?: 0L, encoderName)
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
    // Bulk writes run on duplicates so the codec-facing buffer positions are
    // never disturbed (the old code only ever used absolute puts).
    val yDup = planes[0].buffer.duplicate()
    val yBase = yDup.position()
    val yRowStride = planes[0].rowStride
    val yPixStride = planes[0].pixelStride
    val uDup = planes[1].buffer.duplicate()
    val uBase = uDup.position()
    val uRowStride = planes[1].rowStride
    val uPixStride = planes[1].pixelStride
    val vDup = planes[2].buffer.duplicate()
    val vBase = vDup.position()
    val vRowStride = planes[2].rowStride
    val vPixStride = planes[2].pixelStride
    var y = 0
    while (y < height) {
      var x = 0
      var rowOff = y * width
      while (x < width) {
        val color = pixels[rowOff + x]
        val r = (color shr 16) and 255
        val g = (color shr 8) and 255
        val b = color and 255
        lumaRow[x] = ((((66 * r + 129 * g + 25 * b + 128) shr 8) + 16).coerceIn(0, 255)).toByte()
        x += 1
      }
      if (yPixStride == 1) {
        yDup.position(yBase + y * yRowStride)
        yDup.put(lumaRow, 0, width)
      } else {
        var xx = 0
        while (xx < width) {
          yDup.put(yBase + y * yRowStride + xx * yPixStride, lumaRow[xx])
          xx += 1
        }
      }
      // Average chroma across the 2x2 block rather than subsampling one pixel.
      val y2 = minOf(y + 1, height - 1)
      var cx = 0
      x = 0
      while (x < width) {
        val x2 = minOf(x + 1, width - 1)
        val c00 = pixels[rowOff + x]
        val c01 = pixels[rowOff + x2]
        val c10 = pixels[y2 * width + x]
        val c11 = pixels[y2 * width + x2]
        val rr = (((c00 shr 16) and 255) + ((c01 shr 16) and 255) + ((c10 shr 16) and 255) + ((c11 shr 16) and 255)) / 4
        val gg = (((c00 shr 8) and 255) + ((c01 shr 8) and 255) + ((c10 shr 8) and 255) + ((c11 shr 8) and 255)) / 4
        val bb = ((c00 and 255) + (c01 and 255) + (c10 and 255) + (c11 and 255)) / 4
        chromaRowU[cx] = ((((-38 * rr - 74 * gg + 112 * bb + 128) shr 8) + 128).coerceIn(0, 255)).toByte()
        chromaRowV[cx] = ((((112 * rr - 94 * gg - 18 * bb + 128) shr 8) + 128).coerceIn(0, 255)).toByte()
        cx += 1
        x += 2
      }
      if (y % 2 == 0) {
        val slot = y / 2
        if (uPixStride == 1) {
          uDup.position(uBase + slot * uRowStride)
          uDup.put(chromaRowU, 0, cx)
        } else {
          var xx = 0
          while (xx < cx) {
            uDup.put(uBase + slot * uRowStride + xx * uPixStride, chromaRowU[xx])
            xx += 1
          }
        }
        if (vPixStride == 1) {
          vDup.position(vBase + slot * vRowStride)
          vDup.put(chromaRowV, 0, cx)
        } else {
          var xx = 0
          while (xx < cx) {
            vDup.put(vBase + slot * vRowStride + xx * vPixStride, chromaRowV[xx])
            xx += 1
          }
        }
      }
      y += 1
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
