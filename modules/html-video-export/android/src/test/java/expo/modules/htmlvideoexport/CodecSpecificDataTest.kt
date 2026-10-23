package expo.modules.htmlvideoexport

import java.nio.ByteBuffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class CodecSpecificDataTest {
  @Test
  fun repeatedSegmentComparisonsDoNotConsumeReferenceBuffers() {
    val sps = ByteBuffer.wrap(byteArrayOf(0, 0, 0, 1, 103, 66))
    val pps = ByteBuffer.wrap(byteArrayOf(0, 0, 0, 1, 104, 15))
    val expected = byteArrayOf(0, 0, 0, 1, 103, 66, 0, 0, 0, 1, 104, 15)
    repeat(12) {
      assertArrayEquals(expected, copyCodecSpecificData(sps, pps))
      assertEquals(0, sps.position())
      assertEquals(0, pps.position())
    }
  }

  @Test
  fun respectsPositionAndLimitWithoutChangingEither() {
    val buffer = ByteBuffer.wrap(byteArrayOf(9, 1, 2, 3, 9))
    buffer.position(1)
    buffer.limit(4)
    assertArrayEquals(byteArrayOf(1, 2, 3), copyCodecSpecificData(buffer, null))
    assertEquals(1, buffer.position())
    assertEquals(4, buffer.limit())
    assertArrayEquals(byteArrayOf(), copyCodecSpecificData(null, null))
  }
}
