/**
 * Memoized BFS Result Cache for SYKE.
 *
 * Caches impact analysis results (BFS reverse traversals) so that
 * repeated queries for the same file return instantly.
 *
 * Smart invalidation: when a file changes, only cache entries that
 * could be affected are evicted. A reverse index maps each file to
 * the set of cache keys whose impactSet contains it, making
 * invalidation O(affected) instead of O(cache_size).
 *
 * Uses LRU eviction when the cache exceeds maxSize.
 */

// ── Public Interfaces ──

export interface MemoEntry {
  impactSet: string[];           // list of affected files (direct + transitive)
  directCount: number;
  transitiveCount: number;
  riskLevel: string;
  cascadeLevels?: Map<string, number>;
  computedAt: number;            // timestamp
}

export interface MemoCacheStats {
  size: number;
  hits: number;
  misses: number;
}

export interface MemoCache {
  get(filePath: string): MemoEntry | undefined;
  set(filePath: string, entry: MemoEntry): void;
  invalidate(affectedFiles: string[]): number;  // returns count of invalidated entries
  invalidateAll(): void;
  stats(): MemoCacheStats;
}

// ── Implementation ──

/**
 * Create a new MemoCache with LRU eviction and reverse-index invalidation.
 *
 * @param maxSize Maximum number of cached entries (default 500).
 */
export function createMemoCache(maxSize: number = 500): MemoCache {
  // Main cache: filePath -> MemoEntry
  const cache = new Map<string, MemoEntry>();

  // LRU tracking: most recently accessed key moves to the end
  const accessOrder: string[] = [];

  // Reverse index: maps each file to the set of cache keys whose
  // impactSet contains that file. Used for O(affected) invalidation.
  const reverseIndex = new Map<string, Set<string>>();

  // Stats
  let hits = 0;
  let misses = 0;

  /**
   * Move a key to the end of the access order (most recently used).
   */
  function touchKey(key: string): void {
    const idx = accessOrder.indexOf(key);
    if (idx !== -1) {
      accessOrder.splice(idx, 1);
    }
    accessOrder.push(key);
  }

  /**
   * Remove a single entry from the cache and clean up the reverse index.
   */
  function removeEntry(key: string): void {
    const entry = cache.get(key);
    if (!entry) return;

    // Remove from reverse index
    for (const file of entry.impactSet) {
      const keys = reverseIndex.get(file);
      if (keys) {
        keys.delete(key);
        if (keys.size === 0) {
          reverseIndex.delete(file);
        }
      }
    }
    // Also remove the key itself from the reverse index
    const selfKeys = reverseIndex.get(key);
    if (selfKeys) {
      selfKeys.delete(key);
      if (selfKeys.size === 0) {
        reverseIndex.delete(key);
      }
    }

    cache.delete(key);

    const orderIdx = accessOrder.indexOf(key);
    if (orderIdx !== -1) {
      accessOrder.splice(orderIdx, 1);
    }
  }

  /**
   * Evict the least recently used entry when cache exceeds maxSize.
   */
  function evictLRU(): void {
    while (cache.size > maxSize && accessOrder.length > 0) {
      const lruKey = accessOrder.shift()!;
      removeEntry(lruKey);
    }
  }

  /**
   * Add a file -> cacheKey mapping to the reverse index.
   */
  function addToReverseIndex(file: string, cacheKey: string): void {
    let keys = reverseIndex.get(file);
    if (!keys) {
      keys = new Set();
      reverseIndex.set(file, keys);
    }
    keys.add(cacheKey);
  }

  return {
    get(filePath: string): MemoEntry | undefined {
      const entry = cache.get(filePath);
      if (entry) {
        hits++;
        touchKey(filePath);
        return entry;
      }
      misses++;
      return undefined;
    },

    set(filePath: string, entry: MemoEntry): void {
      // If already cached, remove old reverse index entries first
      if (cache.has(filePath)) {
        removeEntry(filePath);
      }

      // Store the entry
      cache.set(filePath, entry);
      touchKey(filePath);

      // Build reverse index: map each file in impactSet -> this cache key
      for (const file of entry.impactSet) {
        addToReverseIndex(file, filePath);
      }
      // Also index the key itself (if the queried file changes, its own
      // cached result is stale)
      addToReverseIndex(filePath, filePath);

      // Evict LRU if over capacity
      evictLRU();
    },

    invalidate(affectedFiles: string[]): number {
      const keysToInvalidate = new Set<string>();

      for (const file of affectedFiles) {
        // Find all cache keys whose impactSet contains this file
        const keys = reverseIndex.get(file);
        if (keys) {
          for (const key of keys) {
            keysToInvalidate.add(key);
          }
        }
      }

      // Remove all identified entries
      for (const key of keysToInvalidate) {
        removeEntry(key);
      }

      return keysToInvalidate.size;
    },

    invalidateAll(): void {
      cache.clear();
      accessOrder.length = 0;
      reverseIndex.clear();
      // Do NOT reset hits/misses — they are cumulative diagnostics
    },

    stats(): MemoCacheStats {
      return {
        size: cache.size,
        hits,
        misses,
      };
    },
  };
}

// ── Singleton Instance ──

let globalMemoCache: MemoCache | null = null;

/**
 * Get the global memo cache instance (lazy initialization).
 */
export function getMemoCache(): MemoCache {
  if (!globalMemoCache) {
    globalMemoCache = createMemoCache();
  }
  return globalMemoCache;
}

/**
 * Reset the global memo cache (e.g., on full graph rebuild).
 */
export function resetMemoCache(): void {
  if (globalMemoCache) {
    globalMemoCache.invalidateAll();
  }
}
