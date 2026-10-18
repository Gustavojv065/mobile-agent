package expo.modules.htmlvideoexport

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer

/**
 * Extracts the audio track of an audio (or video) file into whisper-ready
 * raw PCM on a cache file, for `transcribeAudio`'s long-recording lane.
 *
 * The native side deliberately does not touch samples: it writes whatever
 * blocks the platform decoder produces (typically interleaved 16-bit PCM at
 * the track's native rate) straight to disk. All mono downmixing, sample-rate
 * conversion, and int16 handling happen in the JS voice module
 * (`prepareWhisperAudio`), where that code is unit-tested and shared with the
 * live voice-input path. Keeping decode dumb keeps this lane verifiable.
 *
 * Decode time and memory are bounded by `maxSeconds`, never by the source
 * file: a two-hour soundtrack costs a few MB of RAM, never stalls the JS
 * thread, and never decodes its tail. Throws loudly on missing audio tracks,
 * unsupported decoder output encodings, and decode failures — a partial file
 * is always deleted, never returned.
 */
object AudioPcmDecoder {
  private const val MIN_DECODE_SECONDS = 1.0
  private const val MAX_DECODE_SECONDS = 36_000.0
  private const val IO_BUFFER_BYTES = 512 * 1024
  private const val DEQUEUE_TIMEOUT_US = 5_000L

  data class DecodeResult(
    val path: String,
    /** Bytes of interleaved PCM written to `path`. */
    val bytes: Long,
    /** Native sample rate reported by the decoder. */
    val sampleRate: Int,
    /** Native channel count reported by the decoder. */
    val channels: Int,
    /** Decoder-reported total duration in seconds (track, not the window). */
    val durationSeconds: Double,
  )

  data class Segment(val base64: String, val bytes: Int)

  /**
   * Decodes at most [maxSeconds] seconds of the audio track into a raw PCM
   * file. Plain filesystem paths (no file:// scheme).
   */
  fun decode(inputPath: String, outputPath: String, maxSeconds: Double): DecodeResult {
    val cap = maxSeconds.coerceIn(MIN_DECODE_SECONDS, MAX_DECODE_SECONDS)
    val maxOutputUs = (cap * 1_000_000.0).toLong()
    val out = File(outputPath)
    var decoder: MediaCodec? = null
    var sink: BufferedOutputStream? = null
    try {
      val extractor = MediaExtractor()
      try {
        extractor.setDataSource(inputPath)
        val trackIndex = selectAudioTrack(extractor)
        extractor.selectTrack(trackIndex)
        val codecFormat = extractor.getTrackFormat(trackIndex)
        val mime = requireNotNull(codecFormat.getString(MediaFormat.KEY_MIME)) {
          "The audio track has no codec type."
        }
        val codec = MediaCodec.createDecoderByType(mime).also { d -> decoder = d }
        // Request 16-bit PCM explicitly; decoders default to it, but a
        // silent float output would otherwise feed whisper noise — the
        // guard below turns that into a loud failure instead.
        codecFormat.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
        codec.configure(codecFormat, null, null, 0)
        codec.start()

        val writer = BufferedOutputStream(FileOutputStream(out), IO_BUFFER_BYTES)
        sink = writer
        var bytesWritten = 0L
        var outRate = -1
        var outChannels = -1
        var trackDurationUs = if (codecFormat.containsKey(MediaFormat.KEY_DURATION)) {
          codecFormat.getLong(MediaFormat.KEY_DURATION)
        } else {
          0L
        }

        val info = MediaCodec.BufferInfo()
        var sawInputEos = false
        var sawOutputEos = false
        while (!sawOutputEos) {
          if (!sawInputEos) {
            val inputIndex = codec.dequeueInputBuffer(DEQUEUE_TIMEOUT_US)
            if (inputIndex >= 0) {
              val inputBuffer = codec.getInputBuffer(inputIndex)
              if (inputBuffer == null) {
                codec.queueInputBuffer(inputIndex, 0, 0, 0L, 0)
              } else {
                val size = extractor.readSampleData(inputBuffer, 0)
                // Input beyond the requested window is never fed: a long
                // source must not be decoded just because it is long.
                if (size < 0 || extractor.sampleTime >= maxOutputUs) {
                  codec.queueInputBuffer(
                    inputIndex, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                  )
                  sawInputEos = true
                } else {
                  codec.queueInputBuffer(inputIndex, 0, size, extractor.sampleTime, extractor.sampleFlags)
                  extractor.advance()
                }
              }
            }
          }
          when (val index = codec.dequeueOutputBuffer(info, DEQUEUE_TIMEOUT_US)) {
            MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
              val format = codec.outputFormat
              outRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
              outChannels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
              val encoding = if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
                format.getInteger(MediaFormat.KEY_PCM_ENCODING)
              } else {
                AudioFormat.ENCODING_PCM_16BIT
              }
              if (encoding != AudioFormat.ENCODING_PCM_16BIT) {
                throw IllegalStateException(
                  "This device's decoder produced non-16-bit PCM (encoding $encoding); " +
                    "transcription needs a different decode path.",
                )
              }
            }
            MediaCodec.INFO_TRY_AGAIN_LATER -> {}
            else -> {
              if (index >= 0) {
                val buffer = codec.getOutputBuffer(index)
                if (buffer != null && info.size > 0 && info.presentationTimeUs < maxOutputUs) {
                  buffer.position(info.offset)
                  buffer.limit(info.offset + info.size)
                  val chunk = ByteArray(info.size)
                  buffer.get(chunk)
                  writer.write(chunk)
                  bytesWritten += info.size
                }
                codec.releaseOutputBuffer(index, false)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                  sawOutputEos = true
                }
              }
            }
          }
        }
        sink!!.flush()
        if (bytesWritten <= 0) {
          throw IllegalStateException("The audio track decoded to no samples.")
        }
        if (outRate <= 0 || outChannels <= 0) {
          throw IllegalStateException("The decoder never reported its output format.")
        }
        return DecodeResult(
          path = outputPath,
          bytes = bytesWritten,
          sampleRate = outRate,
          channels = outChannels,
          durationSeconds = trackDurationUs / 1_000_000.0,
        )
      } finally {
        try { extractor.release() } catch (_: Exception) {}
      }
    } catch (error: Exception) {
      try { out.delete() } catch (_: Exception) {}
      throw error
    } finally {
      try { sink?.close() } catch (_: Exception) {}
      try { decoder?.stop() } catch (_: Exception) {}
      try { decoder?.release() } catch (_: Exception) {}
    }
  }

  /**
   * Reads up to [byteCount] bytes starting at [byteOffset] from a
   * decoder-produced PCM file, base64-encoded. A short read at EOF is normal
   * for the trailing window; an empty segment means the caller consumed the
   * whole file.
   */
  fun readSegment(pcmPath: String, byteOffset: Long, byteCount: Int): Segment {
    require(byteOffset >= 0) { "A negative PCM offset is invalid." }
    require(byteCount > 0) { "A PCM window must request at least one byte." }
    RandomAccessFile(pcmPath, "r").use { file ->
      val length = file.length()
      if (byteOffset >= length) return Segment(base64 = "", bytes = 0)
      file.seek(byteOffset)
      val toRead = minOf(byteCount.toLong(), length - byteOffset).toInt()
      val chunk = ByteArray(toRead)
      var read = 0
      while (read < toRead) {
        val got = file.read(chunk, read, toRead - read)
        if (got < 0) break
        read += got
      }
      if (read <= 0) return Segment(base64 = "", bytes = 0)
      val payload = if (read == toRead) chunk else chunk.copyOf(read)
      return Segment(
        base64 = android.util.Base64.encodeToString(payload, android.util.Base64.NO_WRAP),
        bytes = payload.size,
      )
    }
  }

  private fun selectAudioTrack(extractor: MediaExtractor): Int {
    for (i in 0 until extractor.trackCount) {
      val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
      if (mime.startsWith("audio/")) return i
    }
    throw IllegalStateException("The file has no audio track to decode.")
  }
}
