const inFlight = new Map<string, Promise<unknown>>();

/**
 * Coalesce concurrent calls sharing a `key` onto one in-flight promise, so two
 * `.rs` imports from the same crate never race two cargo processes. The entry
 * is removed once the promise settles, so a failed compile can be retried.
 */
export function dedupeInFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
