package expo.modules.htmlvideoexport

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.nio.ByteBuffer

/**
 * Shrinks over-cap scene clips so they fit the inline budget.
 *
 * Decodes the source with MediaCodec, renders frames into the encoder's
 * input Surface (no CPU pixel copies), re-encodes AVC at a bitrate sized
 * from the byte budget, and muxes MP4. The audio track is dropped on
 * purpose: scene clips always play muted and scene-driven.
 *
 * Runs a dimension ladder (1280 → 854 → 640, aspect-kept and even) with the
 * bitrate derived from [maxBytes] and the probed duration, returning the
 * first attempt that fits. Throws when nothing fits or the source cannot
 * be decoded — callers fall back to their oversize error.
 */
object ClipTranscoder {
  private const val MIME_AVC = "video/avc"
  private const val TAG = "HtmlVideoExport"
  private const val DEQUEUE_TIMEOUT_US = 10_000L
  private const val MIN_BITRATE = 400_000
  private const val MAX_BITRATE = 10_000_000
  /**
   * Share of written samples that must carry the sync flag for a seek proxy
   * to be trusted. A 6 s-GOP source decodes ~90 frames per seek; a proxy at
   * 99.9% intra still seeks in one frame for all but a handful of samples.
   */
  private const val MIN_INTRA_RATIO = 0.999

  data class ProbedTrack(
    val index: Int,
    val mime: String,
    val width: Int,
    val height: Int,
    val durationUs: Long,
    val rotation: Int,
  )

  data class TranscodeResult(
    val path: String,
    val width: Int,
    val height: Int,
    val sizeBytes: Long,
  )

  data class SeekProxyResult(
    val path: String,
    val width: Int,
    val height: Int,
    val sizeBytes: Long,
    /** True when EVERY written sample is a sync sample — one-frame seeks. */
    val allIntra: Boolean,
  )

  /** Written samples of one pass, used to verify the all-intra contract. */
  private data class PassCounts(val frames: Int, val keyframes: Int)

  /**
   * All-intra seek proxy for frame-accurate export.
   *
   * Chromium resets the demuxer and decoder to the previous keyframe on EVERY
   * `currentTime` seek, so exporting one frame from a normal-GOP source
   * decodes up to a whole GOP (dozens of frames) per output frame. Re-encoding
   * the clip as a stream of keyframes makes each of those seeks decode exactly
   * one frame. AOSP MediaFormat documents `KEY_I_FRAME_INTERVAL = 0` as "a
   * stream containing all key frames is requested" — requested, not
   * guaranteed — so the written output is verified: every sample must carry
   * the sync flag. When the device encoder refuses, the file is deleted and
   * `allIntra` comes back false; callers keep serving the original clip,
   * which renders correctly at today's speed.
   *
   * Audio is dropped (scene clips play muted; soundtrack scheduling reads the
   * original file) and display rotation is preserved by the muxer hint,
   * exactly like [transcode].
   */
  fun seekProxy(inputPath: String, outputPath: String, maxDimension: Int): SeekProxyResult {
    val track = probe(inputPath)
    val rotated = track.rotation == 90 || track.rotation == 270
    val srcW = if (rotated) track.height else track.width
    val srcH = if (rotated) track.width else track.height
    val scale = minOf(1.0, maxDimension.coerceAtLeast(160) / maxOf(srcW, srcH).toDouble())
    var w = ((srcW * scale).toInt() / 2) * 2
    var h = ((srcH * scale).toInt() / 2) * 2
    w = w.coerceAtLeast(16)
    h = h.coerceAtLeast(16)
    // Intra frames cost several times a predicted frame at equal quality:
    // size the proxy from its pixels so quality tracks resolution, bounded so
    // absurd sources cannot produce absurd proxies.
    val bitrate = (w.toLong() * h * 8).coerceIn(2_000_000L, 16_000_000L)
    val startedAt = SystemClock.elapsedRealtime()
    val counts = runPass(inputPath, track.index, outputPath, w, h, bitrate, track.rotation, iFrameInterval = 0)
    val elapsedMs = SystemClock.elapsedRealtime() - startedAt
    // A single encoder slip in a long pass used to throw away the whole
    // proxy (10k+ frames for a minute-long clip). One stray predicted frame
    // only costs one GOP decode for the output frames in that 1/30 s, so the
    // contract is "at most a handful of non-sync samples", not "zero".
    val intraRatio = if (counts.frames > 0) counts.keyframes.toDouble() / counts.frames else 0.0
    val allIntra = counts.frames > 0 && intraRatio >= MIN_INTRA_RATIO
    val bytes = File(outputPath).length()
    Log.i(
      TAG,
      "seekProxy ${w}x${h} frames=${counts.frames} keyframes=${counts.keyframes} " +
        "intra=${"%.4f".format(intraRatio)} allIntra=$allIntra bytes=$bytes ms=$elapsedMs",
    )
    if (!allIntra) {
      Log.w(TAG, "seekProxy rejected (needs intra >= $MIN_INTRA_RATIO): $inputPath")
      try { File(outputPath).delete() } catch (_: Exception) {}
    }
    return SeekProxyResult(outputPath, w, h, bytes, allIntra)
  }

  fun transcode(
    inputPath: String,
    outputPath: String,
    maxBytes: Long,
    maxDimension: Int,
  ): TranscodeResult {
    val track = probe(inputPath)
    val rotated = track.rotation == 90 || track.rotation == 270
    val srcW = if (rotated) track.height else track.width
    val srcH = if (rotated) track.width else track.height
    val durationS = (track.durationUs / 1_000_000.0).coerceAtLeast(1.0)
    // ~85% of the budget goes to video; the rest is muxer overhead margin.
    val bitrate = ((maxBytes * 8 * 0.85) / durationS).toLong()
      .coerceIn(MIN_BITRATE.toLong(), MAX_BITRATE.toLong())

    val ladders = intArrayOf(maxDimension, 854, 640).distinct()
    var lastError: Exception? = null
    for (cap in ladders) {
      val scale = minOf(1.0, cap / maxOf(srcW, srcH).toDouble())
      var w = ((srcW * scale).toInt() / 2) * 2
      var h = ((srcH * scale).toInt() / 2) * 2
      w = w.coerceAtLeast(160)
      h = h.coerceAtLeast(160)
      try {
        runPass(inputPath, track.index, outputPath, w, h, bitrate, track.rotation, iFrameInterval = 1)
        val size = File(outputPath).length()
        if (size in 1..maxBytes) {
          return TranscodeResult(outputPath, w, h, size)
        }
        lastError = IllegalStateException("Transcoded clip is still too large (${size} bytes).")
      } catch (e: Exception) {
        lastError = e
      }
    }
    try { File(outputPath).delete() } catch (_: Exception) {}
    throw lastError ?: IllegalStateException("The clip could not be transcoded.")
  }

  private fun probe(inputPath: String): ProbedTrack {
    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(inputPath)
      for (i in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(i)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
        if (!mime.startsWith("video/")) continue
        val width = format.getInteger(MediaFormat.KEY_WIDTH)
        val height = format.getInteger(MediaFormat.KEY_HEIGHT)
        val durationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) {
          format.getLong(MediaFormat.KEY_DURATION)
        } else 0L
        val rotation = if (format.containsKey("rotation-degrees")) {
          format.getInteger("rotation-degrees")
        } else 0
        if (width <= 0 || height <= 0) continue
        return ProbedTrack(i, mime, width, height, durationUs, rotation)
      }
      throw IllegalStateException("No video track found in the clip.")
    } finally {
      try { extractor.release() } catch (_: Exception) {}
    }
  }

  private fun runPass(
    inputPath: String,
    trackIndex: Int,
    outputPath: String,
    width: Int,
    height: Int,
    bitrate: Long,
    rotation: Int,
    iFrameInterval: Int,
  ): PassCounts {
    val extractor = MediaExtractor()
    var decoder: MediaCodec? = null
    var encoder: MediaCodec? = null
    var muxer: MediaMuxer? = null
    var frames = 0
    var keyframes = 0
    try {
      extractor.setDataSource(inputPath)
      extractor.selectTrack(trackIndex)
      val inputFormat = extractor.getTrackFormat(trackIndex)
      val mime = inputFormat.getString(MediaFormat.KEY_MIME)
        ?: throw IllegalStateException("The clip has no decodable video.")

      val outputFormat = MediaFormat.createVideoFormat(MIME_AVC, width, height).apply {
        setInteger(
          MediaFormat.KEY_COLOR_FORMAT,
          MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface,
        )
        setInteger(MediaFormat.KEY_BIT_RATE, bitrate.toInt())
        setInteger(MediaFormat.KEY_FRAME_RATE, 30)
        // 0 = "a stream containing all key frames is requested" (AOSP
        // MediaFormat). Verified after the pass: see PassCounts usage.
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, iFrameInterval)
      }
      encoder = MediaCodec.createEncoderByType(MIME_AVC)
      encoder.configure(outputFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      val inputSurface = encoder.createInputSurface()
      encoder.start()

      decoder = MediaCodec.createDecoderByType(mime)
      decoder.configure(inputFormat, inputSurface, null, 0)
      decoder.start()

      muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      if (rotation != 0) {
        try { muxer.setOrientationHint(rotation) } catch (_: Exception) {}
      }
      var trackOut = -1
      var muxerStarted = false
      val bufferInfo = MediaCodec.BufferInfo()
      var decoderEos = false
      var encoderEos = false
      // Progress-counted bound, not a wall clock: every iteration advances
      // either side or counts idle; corrupt inputs terminate instead of
      // spinning on TRY_AGAIN forever.
      var idleSpins = 0
      val maxIdleSpins = 4_000

      while (!encoderEos) {
        if (!decoderEos) {
          val inIndex = decoder.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
          if (inIndex >= 0) {
            val input = decoder.getInputBuffer(inIndex)!!
            val sampleSize = extractor.readSampleData(input, 0)
            if (sampleSize < 0) {
              decoder.queueInputBuffer(
                inIndex, 0, 0, 0L,
                MediaCodec.BUFFER_FLAG_END_OF_STREAM,
              )
              decoderEos = true
            } else {
              decoder.queueInputBuffer(
                inIndex, 0, sampleSize,
                extractor.sampleTime, 0,
              )
              extractor.advance()
            }
            idleSpins = 0
          } else {
            idleSpins += 1
          }
        }
        val decIndex = decoder.dequeueOutputBuffer(bufferInfo, DEQUEUE_TIMEOUT_US)
        if (decIndex >= 0) {
          val decEos = bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
          decoder.releaseOutputBuffer(decIndex, true)
          if (decEos) {
            decoderEos = true
            // Surface input has no buffers to flag: terminate the encoder
            // explicitly once the decoder drains.
            try { encoder.signalEndOfInputStream() } catch (_: Exception) {}
          }
          idleSpins = 0
        } else if (decIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          idleSpins = 0
        } else {
          idleSpins += 1
        }

        val encIndex = encoder.dequeueOutputBuffer(bufferInfo, DEQUEUE_TIMEOUT_US)
        if (encIndex >= 0) {
          val encoded = encoder.getOutputBuffer(encIndex)!!
          if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
            bufferInfo.size = 0
          }
          if (bufferInfo.size > 0 && muxerStarted) {
            muxer.writeSampleData(trackOut, encoded, bufferInfo)
            frames += 1
            if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0) keyframes += 1
          }
          encoder.releaseOutputBuffer(encIndex, false)
          if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
            encoderEos = true
          }
          idleSpins = 0
        } else if (encIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          if (muxerStarted) throw IllegalStateException("Encoder format changed twice.")
          trackOut = muxer.addTrack(encoder.outputFormat)
          muxer.start()
          muxerStarted = true
          idleSpins = 0
        } else {
          idleSpins += 1
        }

        if (idleSpins > maxIdleSpins) {
          throw IllegalStateException("Transcoding stalled on an unreadable clip.")
        }
      }
      // Drain decoder EOS into the encoder: queue an empty EOS frame if the
      // decoder never produced one downstream (some codecs hold the last frame).
      if (!muxerStarted) {
        throw IllegalStateException("The encoder produced no output.")
      }
    } finally {
      try { extractor.release() } catch (_: Exception) {}
      try { decoder?.stop() } catch (_: Exception) {}
      try { decoder?.release() } catch (_: Exception) {}
      try { encoder?.stop() } catch (_: Exception) {}
      try { encoder?.release() } catch (_: Exception) {}
      try { muxer?.stop() } catch (_: Exception) {}
      try { muxer?.release() } catch (_: Exception) {}
    }
    return PassCounts(frames, keyframes)
  }
}
