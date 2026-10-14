/** Small cancellable queue: rapid scrolling must not start hundreds of decodes. */
export function createThumbnailQueue(concurrency = 2) {
  let active = 0;
  const pending: (() => void)[] = [];
  const drain = () => {
    while (active < concurrency && pending.length > 0) pending.shift()!();
  };

  return function enqueue<T>(load: () => Promise<T>, signal: AbortSignal): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) {
          resolve(null);
          return;
        }
        active += 1;
        void Promise.resolve().then(load).then(resolve, reject).finally(() => {
          active -= 1;
          drain();
        });
      };
      const cancel = () => {
        const index = pending.indexOf(start);
        if (index >= 0) pending.splice(index, 1);
        signal.removeEventListener("abort", cancel);
        resolve(null);
      };
      if (signal.aborted) {
        resolve(null);
        return;
      }
      pending.push(start);
      signal.addEventListener("abort", cancel, { once: true });
      drain();
    });
  };
}
