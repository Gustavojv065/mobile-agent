package expo.modules.sharetarget

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.Collections
import java.util.IdentityHashMap
import java.util.UUID

/**
 * Collects files and text delivered through the Android share sheet.
 *
 * Share URIs are `content://` grants that belong to the sending activity, so
 * they are copied into the app's cache immediately instead of being handed to
 * JavaScript. The copied files are later moved into the workspace by the JS
 * importer, which is why a plain `file://` path is enough here.
 *
 * The queue survives JS reloads because it lives in a process-wide object. JS
 * drains it with `consumeSharedContent()`, and may call that method again after
 * a reload without losing a share that arrived before the bundle was ready.
 */
object ShareInbox {
  private const val INBOX_DIR = "share-inbox"
  private const val BUFFER_SIZE = 64 * 1024

  private val lock = Any()
  private val pending = mutableListOf<Map<String, Any?>>()

  /**
   * Intents are compared by identity: two separate shares of the same image are
   * different intents and must both be imported, while the very same intent
   * object (cold start, activity recreation, repeated consume calls) must only
   * be imported once.
   */
  private val processed = Collections.newSetFromMap(
    IdentityHashMap<Intent, Boolean>(),
  )

  private var prepared = false

  /** Deletes leftovers from a previous process, once per process. */
  fun prepare(context: Context) {
    synchronized(lock) {
      if (prepared) return
      prepared = true
    }

    runCatching {
      File(context.cacheDir, INBOX_DIR).deleteRecursively()
    }
  }

  fun isShareIntent(intent: Intent): Boolean =
    intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE

  /**
   * Copies an incoming intent into the cache and queues its payload.
   * Returns true when something new was queued.
   */
  fun enqueue(context: Context, intent: Intent): Boolean {
    if (!isShareIntent(intent)) return false

    synchronized(lock) {
      if (!processed.add(intent)) return false
    }

    val payload = readPayload(context, intent) ?: return false

    synchronized(lock) {
      pending.add(payload)
    }

    return true
  }

  /** Returns everything queued so far and empties the queue. */
  fun drain(): List<Map<String, Any?>> = synchronized(lock) {
    val result = pending.toList()
    pending.clear()
    result
  }

  private fun readPayload(context: Context, intent: Intent): Map<String, Any?>? {
    val text = runCatching {
      intent.getCharSequenceExtra(Intent.EXTRA_TEXT)
    }.getOrNull()
      ?.toString()
      ?.trim()
      ?.takeIf { it.isNotEmpty() }

    val subject = runCatching {
      intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)
        ?: intent.getCharSequenceExtra(Intent.EXTRA_TITLE)
    }.getOrNull()
      ?.toString()
      ?.trim()
      ?.takeIf { it.isNotEmpty() }

    val files = collectUris(intent).mapIndexedNotNull { index, uri ->
      copyUri(context, uri, index)
    }

    if (text == null && files.isEmpty()) return null

    return mapOf(
      "text" to text,
      "subject" to subject,
      "type" to intent.type,
      "files" to files,
    )
  }

  /**
   * Handles every shape apps use for ACTION_SEND extras:
   * a single Uri, a parcelable/typed array, or a ClipData item list.
   */
  private fun collectUris(intent: Intent): List<Uri> {
    val uris = LinkedHashSet<Uri>()

    // `Bundle.get` is deprecated on API 33+, but it is the only overload that
    // accepts every shape apps use here (Uri, Uri[], ArrayList<Uri>) without a
    // ClassCastException on the wrong one.
    val stream = runCatching {
      @Suppress("DEPRECATION")
      intent.extras?.get(Intent.EXTRA_STREAM)
    }.getOrNull()
    when (stream) {
      is Uri -> uris.add(stream)
      is ArrayList<*> -> stream.forEach { if (it is Uri) uris.add(it) }
      is Array<*> -> stream.forEach { if (it is Uri) uris.add(it) }
    }

    runCatching {
      intent.clipData?.let { clip ->
        for (index in 0 until clip.itemCount) {
          clip.getItemAt(index)?.uri?.let(uris::add)
        }
      }
    }

    // Some file managers only set the intent data. Only treat it as a file when
    // it is a local/content URI; text shares use EXTRA_TEXT instead.
    if (uris.isEmpty()) {
      intent.data?.takeIf {
        it.scheme == ContentResolver.SCHEME_CONTENT || it.scheme == ContentResolver.SCHEME_FILE
      }?.let(uris::add)
    }

    return uris.toList()
  }

  private fun copyUri(context: Context, uri: Uri, index: Int): Map<String, Any?>? {
    val resolver = context.contentResolver
    val mimeType = runCatching { resolver.getType(uri) }.getOrNull()
    val metadata = readDisplayMetadata(resolver, uri)
    val fallbackExtension = mimeType
      ?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
    // `file://` senders have no OpenableColumns row, but their path still
    // carries the original file name.
    val rawName = metadata.first
      ?: uri.lastPathSegment?.takeIf { uri.scheme == ContentResolver.SCHEME_FILE }
    val name = sanitizeFileName(rawName, fallbackExtension, index)

    val directory = File(File(context.cacheDir, INBOX_DIR), UUID.randomUUID().toString())
    if (!directory.mkdirs()) return null

    val destination = File(directory, name)
    try {
      val input = when (uri.scheme) {
        ContentResolver.SCHEME_FILE -> uri.path?.let { FileInputStream(it) }
        else -> resolver.openInputStream(uri)
      } ?: run {
        directory.deleteRecursively()
        return null
      }

      input.use { source ->
        FileOutputStream(destination).use { target ->
          source.copyTo(target, BUFFER_SIZE)
        }
      }
    } catch (_: Exception) {
      directory.deleteRecursively()
      return null
    }

    val size = destination.length().takeIf { it > 0 } ?: metadata.second

    return mapOf(
      "uri" to Uri.fromFile(destination).toString(),
      "name" to name,
      "mimeType" to mimeType,
      "size" to size,
    )
  }

  /**
   * Providers are allowed to return nothing for either column, so both lookups
   * stay null-safe. A provider that throws simply falls back to the MIME type.
   */
  private fun readDisplayMetadata(
    resolver: ContentResolver,
    uri: Uri,
  ): Pair<String?, Long?> {
    var name: String? = null
    var size: Long? = null

    runCatching {
      resolver.query(
        uri,
        arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
        null,
        null,
        null,
      )?.use { cursor: Cursor ->
        if (cursor.moveToFirst()) {
          val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
            name = cursor.getString(nameIndex)
          }

          val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
            size = cursor.getLong(sizeIndex)
          }
        }
      }
    }

    return name to size
  }

  private val invalidNameCharacters = Regex("[\\\\/:*?\"<>|\\u0000-\\u001F]")
  private val whitespace = Regex("\\s+")
  private const val MAX_NAME_LENGTH = 120

  private fun sanitizeFileName(
    rawName: String?,
    fallbackExtension: String?,
    index: Int,
  ): String {
    val base = rawName
      ?.substringAfterLast('/')
      ?.substringAfterLast('\\')
      ?.trim()
      .orEmpty()

    var name = base
      .replace(invalidNameCharacters, "-")
      .replace(whitespace, " ")
      .trim(' ', '.', '-')

    if (name.isEmpty()) {
      name = "shared-file-${index + 1}"
    }

    if (name.length > MAX_NAME_LENGTH) {
      val extension = name.substringAfterLast('.', "")
      val suffixLength = if (extension.isEmpty()) 0 else extension.length + 1
      val stem = name
        .substringBeforeLast('.', name)
        .take((MAX_NAME_LENGTH - suffixLength).coerceAtLeast(1))
      name = if (extension.isEmpty()) stem else "$stem.$extension"
    }

    val hasExtension = name.substringAfterLast('.', "").isNotEmpty()
    if (!hasExtension && !fallbackExtension.isNullOrBlank()) {
      name = "$name.$fallbackExtension"
    }

    return name
  }
}
