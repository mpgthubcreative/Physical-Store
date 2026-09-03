/*
 * A minimal in-memory TTL (time-to-live) cache.
 *
 * Lives ONLY in this Lambda instance's process memory: never written to
 * Firestore, never persisted to disk or any browser storage, and disappears
 * the moment the container is recycled. There is no cross-instance sharing
 * — a different warm container (or the same one after a cold restart)
 * starts with an empty cache.
 *
 * Deliberately generic and dependency-free so its correctness (expiry
 * timing, per-key isolation, and — importantly — that a cached `false`
 * value is never confused with "not cached") can be unit-tested in
 * isolation, without mocking Firebase Auth or Firestore.
 */
class TTLCache {
  constructor() {
    this.store = new Map();
  }

  /** Returns the cached value, or `undefined` if missing or expired. Expired entries are evicted on read. */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Stores `value` (any type, including `false`/`0`/`null`) under `key` for `ttlMs` milliseconds. */
  set(key, value, ttlMs) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}

module.exports = { TTLCache };
