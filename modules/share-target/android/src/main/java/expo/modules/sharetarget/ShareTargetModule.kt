package expo.modules.sharetarget

import android.content.Context
import android.content.Intent
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Callable
import java.util.concurrent.Executors

/**
 * Android share-sheet receiver.
 *
 * The manifest filters (see `plugins/with-share-target.js`) route ACTION_SEND
 * and ACTION_SEND_MULTIPLE intents to MainActivity. This module turns them into
 * a queue of `{ text, subject, type, files }` payloads that JS drains with
 * `consumeSharedContent()`.
 *
 * Cold starts deliver the share through `Activity.getIntent()`, so the first
 * consume call reads it directly. Warm starts arrive through `OnNewIntent`, so
 * the module copies them immediately, queues them, and emits `onSharedContent`
 * to tell JS to drain.
 */
class ShareTargetModule : Module() {
  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "share-target-inbox")
  }

  private val context: Context
    get() = appContext.reactContext?.applicationContext
      ?: appContext.currentActivity?.applicationContext
      ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("ShareTarget")

    Events("onSharedContent")

    OnCreate {
      runCatching {
        ShareInbox.prepare(context)
      }
    }

    OnNewIntent { intent: Intent ->
      if (!ShareInbox.isShareIntent(intent)) return@OnNewIntent

      // File copies are I/O bound and this callback runs on the UI thread.
      executor.execute {
        val queued = runCatching {
          ShareInbox.enqueue(context, intent)
        }.getOrDefault(false)

        if (queued) {
          sendEvent("onSharedContent")
        }
      }
    }

    AsyncFunction("consumeSharedContent") {
      val initialIntent = appContext.currentActivity?.intent

      executor.submit(Callable {
        if (initialIntent != null) {
          runCatching {
            ShareInbox.enqueue(context, initialIntent)
          }
        }

        ShareInbox.drain()
      }).get()
    }

    OnDestroy {
      executor.shutdown()
    }
  }
}
