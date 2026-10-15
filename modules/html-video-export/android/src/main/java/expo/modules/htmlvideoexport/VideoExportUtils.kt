package expo.modules.htmlvideoexport

import android.net.Uri
import java.nio.ByteBuffer

/** Copies bytes to a direct buffer with position/limit ready for native use. */
internal fun directWrap(bytes: ByteArray): ByteBuffer =
  ByteBuffer.allocateDirect(bytes.size).apply {
    put(bytes)
    flip()
  }

/** Target encoder bitrate in bits per second, by output resolution. */
internal fun bitrateFor(width: Int, height: Int): Int {
  val pixels = width * height
  return when {
    pixels <= 640 * 360 -> 3_000_000
    pixels <= 1280 * 720 -> 6_000_000
    pixels <= 1920 * 1080 -> 12_000_000
    else -> 20_000_000
  }
}

/** MediaMuxer takes a filesystem path, not the File API's file:// URI. */
internal fun fileUriToPath(uriOrPath: String): String {
  if (!uriOrPath.startsWith("file:")) return uriOrPath
  return Uri.parse(uriOrPath).path
    ?: throw IllegalArgumentException("Video output URI has no filesystem path.")
}
