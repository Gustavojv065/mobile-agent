package expo.modules.htmlvideoexport

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Turns frames rendered inside the HTML preview WebView into an MP4.
 *
 * `beginFrames`/`pushJpegFrame` sends decoded images through MediaCodec.
 * MediaCodec owns codec configuration, framing, and presentation timestamps.
 */
class HtmlVideoExportModule : Module() {
  private var session: ExportSession? = null
  private val audioLock = Any()
  private var pcmEncoder: PcmAudioEncoder? = null
  private var assetServer: AssetServer? = null
  private val assetServerLock = Any()

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

    AsyncFunction("beginH264") { _: String, _: Int, _: Int, _: Int, _: Int, _: String, _: String ->
      // Keep a rejecting endpoint for old cached documents, never remux their
      // chunks. A stale WebView must fail safely rather than abort the process.
      rejectLegacyRemux()
    }

    AsyncFunction("pushH264Chunk") { _: Boolean, _: Long, _: String ->
      rejectLegacyRemux()
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
      val result = active.finish()
      mapOf(
        "uri" to result.uri,
        "sizeBytes" to result.sizeBytes,
        "hasAudio" to result.hasAudio,
        "audioDurationUs" to result.audioDurationUs,
      )
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

    AsyncFunction("transcodeClip") { inputPath: String, outputPath: String, maxBytes: Double, maxDimension: Int ->
      val result = ClipTranscoder.transcode(inputPath, outputPath, maxBytes.toLong(), maxDimension)
      mapOf(
        "path" to result.path,
        "width" to result.width,
        "height" to result.height,
        "sizeBytes" to result.sizeBytes.toDouble(),
      )
    }

    AsyncFunction("startAssetServer") { workspaceDir: String, cacheDir: String ->
      synchronized(assetServerLock) {
        var server = assetServer
        if (server == null) {
          server = AssetServer(
            mapOf(
              "files" to java.io.File(workspaceDir),
              "cache" to java.io.File(cacheDir),
            ),
          )
          assetServer = server
        }
        val port = server.acquire()
        if (port <= 0) throw IllegalStateException("The asset server failed to start.")
        mapOf("port" to port)
      }
    }

    AsyncFunction("stopAssetServer") {
      synchronized(assetServerLock) {
        try { assetServer?.release() } catch (_: Exception) {}
      }
    }
  }

  private fun rejectLegacyRemux() {
    throw IllegalStateException("WebCodecs remux export is no longer supported. Reload the scene to use native frame export.")
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

/** Export lifecycle used by the module for finish/cancel. */
internal interface ExportSession {
  fun finish(): ExportResult
  fun cancel()
}

/** What a finished session hands back: file, size, and audio coverage. */
internal data class ExportResult(
  val uri: String,
  val sizeBytes: Long,
  val hasAudio: Boolean,
  /** Last muxed audio timestamp in microseconds (0 when silent). */
  val audioDurationUs: Long,
)

/** Sessions that mux an AAC track implement audio delivery. */
internal interface AudioCapable {
  fun pushAudio(timestampMicros: Long, bytes: ByteArray)
}
