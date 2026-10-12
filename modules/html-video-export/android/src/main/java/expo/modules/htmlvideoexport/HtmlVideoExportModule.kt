package expo.modules.htmlvideoexport

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Turns frames rendered inside the HTML preview WebView into an MP4.
 *
 * Two input modes, chosen by the page depending on whether WebCodecs is
 * available:
 *
 *  - `beginH264`/`pushH264Chunk` remuxes already-compressed H.264 chunks (the
 *    GPU path — the WebView's hardware `VideoEncoder` did the encoding, this
 *    module only writes the MP4 container).
 *  - `beginFrames`/`pushJpegFrame` decodes JPEG frames and re-encodes them on
 *    the hardware MediaCodec encoder via an input surface (fallback path).
 */
class HtmlVideoExportModule : Module() {
  private var session: ExportSession? = null
  private val audioLock = Any()
  private var pcmEncoder: PcmAudioEncoder? = null

  /** Audio format declared by the page; consumed when the video session begins. */
  private var pendingAudioFormat: AudioSpec? = null

  /**
   * Audio chunks that arrive before the video session exists (the page starts
   * capturing sound before the first video frame is encoded). Replayed into
   * the session at begin; dropped oldest-first past the cap.
   */
  private val pendingAudio = ArrayDeque<Pair<Long, ByteArray>>()

  override fun definition() = ModuleDefinition {
    Name("HtmlVideoExport")

    AsyncFunction("beginH264") { outputPath: String, width: Int, height: Int, fps: Int, frameCount: Int, spsHex: String, ppsHex: String ->
      require(spsHex.isNotBlank() && ppsHex.isNotBlank()) {
        "Missing H.264 codec configuration (SPS/PPS)."
      }
      synchronized(audioLock) {
        session?.cancel()
        session = null
        val (audioSpec, buffered) = takePendingAudio()
        val next = H264RemuxSession(outputPath, width, height, fps, spsHex, ppsHex, audioSpec, buffered)
        next.begin()
        session = next
      }
      mapOf("ok" to true)
    }

    AsyncFunction("pushH264Chunk") { keyFrame: Boolean, timestampMicros: Long, base64: String ->
      val active = session as? H264RemuxSession
        ?: throw IllegalStateException("The H.264 export has not started.")
      active.pushChunk(keyFrame, timestampMicros, base64)
    }

    AsyncFunction("setAudioFormat") { sampleRate: Int, channels: Int ->
      require(sampleRate in 8000..96000) { "Unsupported audio sample rate: $sampleRate" }
      require(channels == 1 || channels == 2) { "Unsupported audio channel count: $channels" }
      synchronized(audioLock) {
        pcmEncoder?.close()
        pcmEncoder = null
        pendingAudioFormat = AudioSpec(sampleRate, channels)
      }
    }

    AsyncFunction("setAudioPcmFormat") { sampleRate: Int, channels: Int ->
      // Validate the exact rates supported by the MP4 AAC track up front.
      AudioTrackWriter.aacAudioSpecificConfig(sampleRate, channels)
      synchronized(audioLock) {
        pcmEncoder?.close()
        pcmEncoder = null
        pendingAudio.clear()
        val spec = AudioSpec(sampleRate, channels)
        pcmEncoder = PcmAudioEncoder(spec) { pts, bytes -> deliverAudio(pts, bytes) }
        pendingAudioFormat = spec
      }
    }

    AsyncFunction("pushPcmChunk") { timestampMicros: Long, base64: String ->
      val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
      synchronized(audioLock) {
        val encoder = pcmEncoder ?: error("The PCM audio encoder has not started.")
        encoder.push(timestampMicros, bytes)
      }
    }

    AsyncFunction("pushAudioChunk") { timestampMicros: Long, base64: String ->
      val bytes = try {
        android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
      } catch (_: Exception) {
        throw IllegalArgumentException("An audio chunk could not be decoded.")
      }
      synchronized(audioLock) {
        deliverAudio(timestampMicros, bytes)
      }
    }

    AsyncFunction("beginFrames") { outputPath: String, width: Int, height: Int, fps: Int, frameCount: Int ->
      synchronized(audioLock) {
        session?.cancel()
        session = null
        val (audioSpec, buffered) = takePendingAudio()
        val next = JpegFrameRecorder(outputPath, width, height, fps, audioSpec, buffered)
        next.begin()
        session = next
      }
      mapOf("ok" to true)
    }

    AsyncFunction("pushJpegFrame") { index: Int, base64: String ->
      val active = session as? JpegFrameRecorder
        ?: throw IllegalStateException("The frame export has not started.")
      active.pushFrame(index, base64)
    }

    AsyncFunction("finish") {
      val active = session ?: throw IllegalStateException("No video export is in progress.")
      synchronized(audioLock) {
        try { pcmEncoder?.finish() } finally { pcmEncoder = null }
      }
      session = null
      val (uri, sizeBytes, hasAudio) = active.finish()
      mapOf("uri" to uri, "sizeBytes" to sizeBytes, "hasAudio" to hasAudio)
    }

    AsyncFunction("cancel") {
      synchronized(audioLock) {
        session?.cancel()
        session = null
        try { pcmEncoder?.close() } catch (_: Exception) {} finally { pcmEncoder = null }
        pendingAudioFormat = null
        pendingAudio.clear()
      }
    }
  }

  /** Called under audioLock; AAC may arrive before the video track exists. */
  private fun deliverAudio(timestampMicros: Long, bytes: ByteArray) {
    val active = session as? AudioCapable
    if (active != null) {
      active.pushAudio(timestampMicros, bytes)
    } else {
      check(pendingAudio.size < MAX_PENDING_AUDIO_SAMPLES) { "Too much audio arrived before video started." }
      pendingAudio.addLast(timestampMicros to bytes)
    }
  }

  private fun takePendingAudio(): Pair<AudioSpec?, List<Pair<Long, ByteArray>>> {
    synchronized(audioLock) {
      val spec = pendingAudioFormat
      val buffered = pendingAudio.toList()
      pendingAudioFormat = null
      pendingAudio.clear()
      return spec to buffered
    }
  }

  companion object {
    private const val MAX_PENDING_AUDIO_SAMPLES = 4000
  }
}

/** Common teardown surface so the module can switch or abort either recorder. */
internal interface ExportSession {
  fun finish(): Triple<String, Long, Boolean>
  fun cancel()
}

/** Sessions that mux an AAC track implement audio delivery. */
internal interface AudioCapable {
  fun pushAudio(timestampMicros: Long, bytes: ByteArray)
}
