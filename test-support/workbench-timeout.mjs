// Advance the request budget only after the real queue file is published. A
// short wall clock timeout can expire while preparing the file on a busy host.
export async function timeoutAfterPublication(invoke, options = {}) {
  const timeout = 10_000;
  const now = Date.now;
  let published = false;
  Date.now = () => now() + (published ? timeout + 1 : 0);
  try {
    return await invoke({
      ...options,
      timeout,
      onTiming(event) {
        if (event.phase === 'published') published = true;
        options.onTiming?.(event);
      },
    });
  } finally {
    Date.now = now;
  }
}
