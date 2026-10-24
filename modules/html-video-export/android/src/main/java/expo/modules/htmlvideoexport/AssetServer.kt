package expo.modules.htmlvideoexport

import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Loopback-only static file server for scene assets.
 *
 * Data-URI inlining inflates every clip by ~33% and parks multi-megabyte
 * strings in the JS heap and the WebView bridge. Serving workspace files
 * over `http://127.0.0.1:<port>/` instead removes the inflation entirely,
 * enables byte-range requests (video seeking without full download), and —
 * because scene documents are served from the same origin — keeps canvas
 * readback clean (no taint, so `toDataURL` frame capture keeps working).
 *
 * Security posture: binds 127.0.0.1 only (unreachable off-device), serves
 * allow-listed root directories mapped from URL prefixes, rejects any path
 * containing `..`, and stops when the last consumer releases it. No
 * directory listings.
 */
class AssetServer(private val roots: Map<String, java.io.File>) {
  private var socket: ServerSocket? = null
  private var acceptThread: Thread? = null
  private val running = AtomicBoolean(false)
  private var refCount = 0
  private val lock = Any()

  val port: Int
    get() = socket?.localPort ?: -1

  /** Starts the server (idempotent) and records one consumer. Returns the port. */
  fun acquire(): Int {
    synchronized(lock) {
      if (!running.get()) {
        val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        socket = server
        running.set(true)
        acceptThread = thread(name = "asset-server", isDaemon = true, start = true) {
          serveLoop(server)
        }
      }
      refCount += 1
      return socket?.localPort ?: -1
    }
  }

  /** Releases one consumer; stops the server when none remain. */
  fun release() {
    synchronized(lock) {
      refCount = (refCount - 1).coerceAtLeast(0)
      if (refCount == 0 && running.get()) {
        running.set(false)
        try { socket?.close() } catch (_: Exception) {}
        socket = null
      }
    }
  }

  private fun serveLoop(server: ServerSocket) {
    while (running.get()) {
      try {
        val client = server.accept()
        thread(isDaemon = true, start = true) { handle(client) }
      } catch (_: Exception) {
        // Socket closed on release; exit quietly.
        if (!running.get()) return
      }
    }
  }

  private fun handle(client: Socket) {
    try {
      client.soTimeout = 10_000
      val reader = BufferedReader(InputStreamReader(client.getInputStream()))
      val out = client.getOutputStream()
      val requestLine = reader.readLine() ?: run { client.close(); return }
      val parts = requestLine.split(" ")
      if (parts.size >= 2 && parts[0] == "OPTIONS") {
        // CORS preflight: a page whose origin is not this server (file://
        // documents) must ask before sending a `Range` request header.
        writeCorsPreflight(out)
        client.close()
        return
      }
      if (parts.size < 2 || parts[0] != "GET") {
        writeStatus(out, 405, "Method Not Allowed", "text/plain", 0)
        client.close()
        return
      }
      var headers = mutableMapOf<String, String>()
      while (true) {
        val line = reader.readLine() ?: break
        if (line.isEmpty()) break
        val idx = line.indexOf(':')
        if (idx > 0) {
          headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
        }
      }
      val rawPath = parts[1].substringBefore("?")
      val decoded = try {
        URLDecoder.decode(rawPath, "UTF-8")
      } catch (_: Exception) {
        writeStatus(out, 400, "Bad Request", "text/plain", 0)
        client.close()
        return
      }
      if (decoded.contains("..")) {
        writeStatus(out, 403, "Forbidden", "text/plain", 0)
        client.close()
        return
      }
      // Prefix selects the root (/files/ workspace, /cache/ app cache).
      val prefix = decoded.removePrefix("/").substringBefore("/")
      val root = roots[prefix]
      if (root == null) {
        writeStatus(out, 404, "Not Found", "text/plain", 0)
        client.close()
        return
      }
      val name = decoded.removePrefix("/$prefix/")
      if (name.isEmpty() || name == "/") {
        writeStatus(out, 404, "Not Found", "text/plain", 0)
        client.close()
        return
      }
      // Canonical-path containment: no escapes via symlinks either.
      val target = java.io.File(root, name)
      val rootCanon = try { root.canonicalPath } catch (_: Exception) { root.absolutePath }
      val targetCanon = try { target.canonicalPath } catch (_: Exception) { "" }
      if (!targetCanon.startsWith(rootCanon + java.io.File.separator) || !target.isFile) {
        writeStatus(out, 404, "Not Found", "text/plain", 0)
        client.close()
        return
      }
      serveFile(out, target, headers["range"], headers["if-none-match"])
      client.close()
    } catch (_: Exception) {
      try { client.close() } catch (_: Exception) {}
    }
  }

  private fun serveFile(out: OutputStream, file: java.io.File, range: String?, ifNoneMatch: String?) {
    val total = file.length()
    // mtime+size validator (sub-second precision, so an in-place edit
    // rewrites it). Reuse happens only on an explicit If-None-Match match:
    // Cache-Control no-cache makes the client ask every time, so a match is
    // proof of freshness — never a hoped-for one.
    val etag = "\"${file.lastModified()}-${total}\""
    if (ifNoneMatch != null && etagMatches(ifNoneMatch, etag)) {
      writeNotModified(out, etag)
      return
    }
    var start = 0L
    var end = total - 1
    var partial = false
    if (range != null && range.startsWith("bytes=")) {
      val spec = range.removePrefix("bytes=").split("-")
      try {
        val a = spec.getOrNull(0)?.toLongOrNull()
        var b = spec.getOrNull(1)?.toLongOrNull()
        if (a != null) {
          start = a.coerceIn(0, total - 1)
          end = (b ?: (total - 1)).coerceIn(start, total - 1)
          partial = true
        } else if (b != null) {
          // Suffix range: last N bytes.
          start = (total - b).coerceAtLeast(0)
          partial = true
        }
      } catch (_: Exception) {
        start = 0
        end = total - 1
        partial = false
      }
    }
    val length = (end - start + 1).coerceAtLeast(0)
    val mime = mimeFor(file.name)
    val head = StringBuilder()
    head.append(if (partial) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
    head.append("Content-Type: $mime\r\n")
    head.append("Content-Length: $length\r\n")
    if (partial) head.append("Content-Range: bytes $start-$end/$total\r\n")
    head.append("Accept-Ranges: bytes\r\n")
    head.append("Access-Control-Allow-Origin: *\r\n")
    head.append("Access-Control-Expose-Headers: Content-Range, Accept-Ranges, ETag\r\n")
    // no-cache = store but always revalidate: each segment page re-checks the
    // ETag and gets a bodiless 304 instead of re-transferring the document
    // and its assets — and, unlike max-age, it has no staleness window.
    head.append("Cache-Control: private, no-cache\r\n")
    head.append("ETag: $etag\r\n")
    head.append("Connection: close\r\n\r\n")
    out.write(head.toString().toByteArray(Charsets.UTF_8))
    out.flush()
    if (length == 0L) return
    RandomAccessFile(file, "r").use { raf ->
      raf.seek(start)
      val buf = ByteArray(64 * 1024)
      var remaining = length
      while (remaining > 0) {
        val n = raf.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
        if (n < 0) break
        out.write(buf, 0, n)
        remaining -= n
      }
      out.flush()
    }
  }

  private fun writeStatus(out: OutputStream, code: Int, message: String, mime: String, length: Long) {
    val head = "HTTP/1.1 $code $message\r\nContent-Type: $mime\r\nContent-Length: $length\r\nConnection: close\r\n\r\n"
    out.write(head.toByteArray(Charsets.UTF_8))
    out.flush()
  }

  private fun writeCorsPreflight(out: OutputStream) {
    val head = "HTTP/1.1 204 No Content\r\n" +
      "Access-Control-Allow-Origin: *\r\n" +
      "Access-Control-Allow-Methods: GET, OPTIONS\r\n" +
      "Access-Control-Allow-Headers: Range\r\n" +
      "Access-Control-Max-Age: 86400\r\n" +
      "Content-Length: 0\r\n" +
      "Connection: close\r\n\r\n"
    out.write(head.toByteArray(Charsets.UTF_8))
    out.flush()
  }

  /** RFC 9110 If-None-Match: `*`, a comma list, or weak (`W/`) variants. */
  private fun etagMatches(ifNoneMatch: String, etag: String): Boolean {
    if (ifNoneMatch.trim() == "*") return true
    return ifNoneMatch.split(',').any { it.trim().removePrefix("W/") == etag }
  }

  private fun writeNotModified(out: OutputStream, etag: String) {
    val head = "HTTP/1.1 304 Not Modified\r\n" +
      "ETag: $etag\r\n" +
      "Cache-Control: private, no-cache\r\n" +
      "Access-Control-Allow-Origin: *\r\n" +
      "Access-Control-Expose-Headers: Content-Range, Accept-Ranges, ETag\r\n" +
      "Connection: close\r\n\r\n"
    out.write(head.toByteArray(Charsets.UTF_8))
    out.flush()
  }

  private fun mimeFor(name: String): String {
    val ext = name.substringAfterLast('.', "").lowercase()
    return when (ext) {
      "mp4", "m4v" -> "video/mp4"
      "webm" -> "video/webm"
      "mp3" -> "audio/mpeg"
      "wav" -> "audio/wav"
      "m4a" -> "audio/mp4"
      "aac" -> "audio/aac"
      "ogg", "oga" -> "audio/ogg"
      "jpg", "jpeg" -> "image/jpeg"
      "png" -> "image/png"
      "webp" -> "image/webp"
      "gif" -> "image/gif"
      "html", "htm" -> "text/html"
      else -> "application/octet-stream"
    }
  }
}
