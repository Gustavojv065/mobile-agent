package expo.modules.htmlvideoexport

import java.nio.ByteBuffer

/** MediaFormat returns its actual stored buffers, not fresh views. Never
 * consume them while inspecting codec parameters: the reference format is
 * compared against every segment and is also handed to MediaMuxer. */
internal fun copyCodecSpecificData(vararg buffers: ByteBuffer?): ByteArray {
  val views = buffers.map { it?.duplicate() }
  val bytes = ByteArray(views.sumOf { it?.remaining() ?: 0 })
  var offset = 0
  for (view in views) {
    if (view == null) continue
    val length = view.remaining()
    view.get(bytes, offset, length)
    offset += length
  }
  return bytes
}
