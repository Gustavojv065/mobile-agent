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

  override fun definition() = ModuleDefinition {
    Name("HtmlVideoExport")

    AsyncFunction("beginH264") { outputPath: String, width: Int, height: Int, fps: Int, frameCount: Int, spsHex: String, ppsHex: String ->
      require(spsHex.isNotBlank() && ppsHex.isNotBlank()) {
        "Missing H.264 codec configuration (SPS/PPS)."
      }
      session?.cancel()
      val next = H264RemuxSession(outputPath, width, height, fps, spsHex, ppsHex)
      next.begin()
      session = next
      mapOf("ok" to true)
    }

    AsyncFunction("pushH264Chunk") { keyFrame: Boolean, timestampMicros: Long, base64: String ->
      val active = session as? H264RemuxSession
        ?: throw IllegalStateException("The H.264 export has not started.")
      active.pushChunk(keyFrame, timestampMicros, base64)
    }

    AsyncFunction("beginFrames") { outputPath: String, width: Int, height: Int, fps: Int, frameCount: Int ->
      session?.cancel()
      val next = JpegFrameRecorder(outputPath, width, height, fps)
      next.begin()
      session = next
      mapOf("ok" to true)
    }

    AsyncFunction("pushJpegFrame") { index: Int, base64: String ->
      val active = session as? JpegFrameRecorder
        ?: throw IllegalStateException("The frame export has not started.")
      active.pushFrame(index, base64)
    }

    AsyncFunction("finish") {
      val active = session ?: throw IllegalStateException("No video export is in progress.")
      session = null
      val result = active.finish()
      mapOf("uri" to result.first, "sizeBytes" to result.second)
    }

    AsyncFunction("cancel") {
      session?.cancel()
      session = null
    }
  }
}

/** Common teardown surface so the module can switch or abort either recorder. */
internal interface ExportSession {
  fun finish(): Pair<String, Long>
  fun cancel()
}