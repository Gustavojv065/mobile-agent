package expo.modules.localtts

import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.RandomAccessFile
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * On-device speech synthesis via Android's `TextToSpeech` engine.
 *
 * Powers narration/voiceover without any network call: the JS side sends text
 * plus a BCP-47 language tag, the engine renders it to a WAV file in the app
 * cache, and the caller moves that file into the workspace (see
 * `src/modules/voice/local-tts.ts`). Available voices depend on the device's
 * TTS engine and installed voice data — GMS devices ship Google TTS with
 * dozens of languages, bare AOSP images may only have a few — so language
 * errors name what is actually installed instead of failing vaguely.
 *
 * One synthesis runs at a time (`synthLock`): `TextToSpeech` instances are
 * created per call and shut down in `finally`, so nothing leaks and concurrent
 * calls serialize instead of interleaving utterances.
 */
class LocalTtsModule : Module() {
  private val synthLock = Any()

  override fun definition() = ModuleDefinition {
    Name("LocalTts")

    AsyncFunction("getVoices") {
      synchronized(synthLock) {
        withTts { tts ->
          tts.voices.orEmpty()
            .sortedBy { it.locale.toLanguageTag() }
            .map { voice ->
              mapOf(
                "locale" to voice.locale.toLanguageTag(),
                "name" to voice.name,
                "quality" to voice.quality,
                "latency" to voice.latency,
                "networkRequired" to voice.isNetworkConnectionRequired,
              )
            }
        }
      }
    }

    AsyncFunction("synthesize") { text: String, options: Map<String, Any?>? ->
      val clean = text.trim()
      require(clean.isNotEmpty()) { "Nothing to speak: the text is empty." }
      require(clean.length <= MAX_CHARS) {
        "The text is ${clean.length} characters; synthesize at most $MAX_CHARS at a time and join the parts."
      }
      val language = (options?.get("language") as? String)?.trim().orEmpty()
      val rate = (options?.get("rate") as? Number)?.toFloat()?.coerceIn(MIN_RATE, MAX_RATE) ?: 1f
      val pitch = (options?.get("pitch") as? Number)?.toFloat()?.coerceIn(MIN_RATE, MAX_RATE) ?: 1f

      synchronized(synthLock) {
        withTts { tts ->
          val locale =
            if (language.isEmpty()) Locale.getDefault()
            else Locale.forLanguageTag(language)
          assertVoiceAvailable(tts, locale, language)
          tts.setSpeechRate(rate)
          tts.setPitch(pitch)

          val cache = appContext.cacheDirectory
            ?: throw IllegalStateException("App cache is unavailable.")
          val outFile = File(cache, "tts-${UUID.randomUUID()}.wav")
          val utteranceId = UUID.randomUUID().toString()
          val done = CountDownLatch(1)
          val failure = AtomicReference<Throwable?>(null)
          tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String) = Unit
            override fun onDone(id: String) {
              if (id == utteranceId) done.countDown()
            }
            override fun onError(id: String) {
              if (id == utteranceId) {
                failure.compareAndSet(null, IllegalStateException("The speech engine failed to render the audio."))
                done.countDown()
              }
            }
            override fun onError(id: String, errorCode: Int) {
              if (id == utteranceId) {
                failure.compareAndSet(
                  null,
                  IllegalStateException("The speech engine failed to render the audio (code $errorCode)."),
                )
                done.countDown()
              }
            }
          })

          val queued = tts.synthesizeToFile(clean, Bundle(), outFile, utteranceId)
          if (queued != TextToSpeech.SUCCESS) {
            throw IllegalStateException("The speech engine refused the text.")
          }
          // ~14 chars/sec at 1x; scale the wait with length and floor it high
          // enough for slow rates, so synthesis never trips its own timeout.
          val timeoutMs = minOf(MAX_WAIT_MS, maxOf(MIN_WAIT_MS, clean.length * MS_PER_CHAR))
          if (!done.await(timeoutMs, TimeUnit.MILLISECONDS)) {
            throw IllegalStateException("Timed out waiting for the speech engine.")
          }
          failure.get()?.let { throw it }
          if (!outFile.exists() || outFile.length() == 0L) {
            throw IllegalStateException("The speech engine produced no audio file.")
          }

          val info = readWavInfo(outFile)
          mapOf(
            "uri" to "file://${outFile.absolutePath}",
            "durationMs" to info.durationMs,
            "sampleRate" to info.sampleRate,
            "channels" to info.channels,
          )
        }
      }
    }
  }

  companion object {
    private const val MAX_CHARS = 4000
    private const val MIN_RATE = 0.25f
    private const val MAX_RATE = 4f
    private const val MIN_WAIT_MS = 180_000L
    private const val MAX_WAIT_MS = 600_000L
    private const val MS_PER_CHAR = 500L
  }

  /**
   * Creates a `TextToSpeech` instance, waits for engine init, runs [block],
   * and always shuts the instance down. Init and synthesis both happen off
   * the main thread (Expo runs async functions on a background queue), so the
   * latches below never block the UI.
   */
  private fun <T> withTts(block: (TextToSpeech) -> T): T {
    val context = appContext.reactContext
      ?: throw IllegalStateException("Local TTS is only available while the app is running.")
    val ready = CountDownLatch(1)
    val status = AtomicReference(TextToSpeech.ERROR)
    val tts = TextToSpeech(context.applicationContext) { code ->
      status.set(code)
      ready.countDown()
    }
    try {
      if (!ready.await(15, TimeUnit.SECONDS)) {
        throw IllegalStateException("The on-device speech engine did not start in time.")
      }
      if (status.get() != TextToSpeech.SUCCESS) {
        throw IllegalStateException("The on-device speech engine failed to start.")
      }
      return block(tts)
    } finally {
      try {
        tts.shutdown()
      } catch (_: Exception) {
        // Already torn down; nothing left to release.
      }
    }
  }

  /**
   * Fails with an actionable message when the requested locale has no usable
   * voice, naming a sample of what is actually installed so the caller can
   * pick a real language instead of guessing.
   */
  private fun assertVoiceAvailable(tts: TextToSpeech, locale: Locale, requested: String) {
    val availability = try {
      tts.isLanguageAvailable(locale)
    } catch (_: Exception) {
      TextToSpeech.LANG_NOT_SUPPORTED
    }
    if (availability >= TextToSpeech.LANG_AVAILABLE) return
    val installed = tts.voices.orEmpty()
      .map { it.locale.toLanguageTag() }
      .toSortedSet()
      .take(25)
    val have = if (installed.isEmpty()) "none" else installed.joinToString(", ")
    val label = requested.ifEmpty { locale.toLanguageTag() }
    if (availability == TextToSpeech.LANG_MISSING_DATA) {
      throw IllegalStateException(
        "The on-device voice for \"$label\" is not installed (voice data is missing). " +
          "Install it in the system text-to-speech settings, or synthesize in an installed language: $have.",
      )
    }
    throw IllegalStateException(
      "The on-device engine has no voice for \"$label\". " +
        "Installed languages: $have.",
    )
  }

  private data class WavInfo(val sampleRate: Int, val channels: Int, val durationMs: Long)

  /**
   * Reads sample rate / channels / duration from the WAV the engine wrote, by
   * walking its chunks (the `fmt ` chunk is not guaranteed to sit at a fixed
   * offset). Duration comes from `dataBytes / byteRate`, so it stays exact
   * even when the engine's sample rate varies.
   */
  private fun readWavInfo(file: File): WavInfo {
    RandomAccessFile(file, "r").use { raf ->
      val length = raf.length()
      if (length < 44) {
        throw IllegalStateException("The speech engine produced an unreadable audio file.")
      }
      val riff = ByteArray(12)
      raf.readFully(riff)
      if (riff[0] != 'R'.code.toByte() || riff[1] != 'I'.code.toByte() ||
        riff[2] != 'F'.code.toByte() || riff[3] != 'F'.code.toByte() ||
        riff[8] != 'W'.code.toByte() || riff[9] != 'A'.code.toByte() ||
        riff[10] != 'V'.code.toByte() || riff[11] != 'E'.code.toByte()
      ) {
        throw IllegalStateException("The speech engine produced an unreadable audio file.")
      }
      var offset = 12L
      var sampleRate = 0
      var channels = 0
      var byteRate = 0
      var dataSize = -1L
      val id = ByteArray(4)
      val sizeBytes = ByteArray(4)
      while (offset + 8 <= length) {
        raf.seek(offset)
        raf.readFully(id)
        raf.readFully(sizeBytes)
        val size = leU32(sizeBytes, 0)
        when (String(id, Charsets.US_ASCII)) {
          "fmt " -> {
            val fmt = ByteArray(minOf(size.toInt(), 16))
            raf.readFully(fmt)
            channels = leU16(fmt, 2)
            sampleRate = leU32(fmt, 4).toInt()
            byteRate = leU32(fmt, 8).toInt()
          }
          "data" -> dataSize = size
        }
        offset += 8 + size + (size and 1)
      }
      if (byteRate <= 0 || dataSize < 0) {
        throw IllegalStateException("The speech engine produced an unreadable audio file.")
      }
      return WavInfo(sampleRate, channels, dataSize * 1000 / byteRate)
    }
  }

  private fun leU16(bytes: ByteArray, offset: Int): Int =
    ((bytes[offset + 1].toInt() and 0xff) shl 8) or (bytes[offset].toInt() and 0xff)

  private fun leU32(bytes: ByteArray, offset: Int): Long =
    ((bytes[offset + 3].toLong() and 0xff) shl 24) or
      ((bytes[offset + 2].toLong() and 0xff) shl 16) or
      ((bytes[offset + 1].toLong() and 0xff) shl 8) or
      (bytes[offset].toLong() and 0xff)
}
