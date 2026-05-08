// useBookProgress(bookId) — single source of truth for "where did I leave
// off in this book?" Replaces the older Redux state.books.continueReading
// slice + ad-hoc per-screen state, both of which had drift problems
// (different surfaces showing different chapters because they read from
// different caches that updated at different times).
//
// Returns the user's saved progress for one book:
//   {
//     lastChapterId,      — Supabase UUID of the chapter the reader was on
//     lastChapterNumber,  — order column of that chapter (1, 2, 3, …)
//     lastScrollPct,      — 0–1 fraction of contentHeight where they stopped
//     lastReadAt,         — ISO timestamp, used for "Last read 2h ago" labels
//     hasProgress,        — convenience boolean: true if the user has read at least once
//     isLoading,          — false once the first fetch completes (cached or fresh)
//     refresh,            — manual refetch, e.g. on pull-to-refresh
//   }
//
// Caching: stale-while-revalidate. First call paints from cache (if any)
// instantly, then fires a background refetch. TTL is 5 minutes —
// progress doesn't move quickly from outside the device, so anything
// fresher than that is wasted bandwidth on book-info / library card
// re-renders.

import { useCallback, useEffect, useState } from "react";
import { BookReadService } from "../lib/book-reads";

const TTL_MS = 5 * 60 * 1000;

// Module-level cache, keyed by `${userId}:${bookId}`. Survives screen
// remounts (so swiping between book-info and back doesn't refetch) but
// not full app restarts. Good enough — the data is cheap to refetch
// and persisting across restarts would mean another layer of MMKV
// invalidation logic for marginal benefit.
const CACHE = new Map();

const cacheKey = (userId, bookId) => `${userId || "anon"}:${bookId || ""}`;

const readCache = (key) => {
  const entry = CACHE.get(key);
  if (!entry) return { data: null, fresh: false };
  const fresh = Date.now() - entry.cachedAt < TTL_MS;
  return { data: entry.data, fresh };
};

const writeCache = (key, data) => {
  CACHE.set(key, { data, cachedAt: Date.now() });
};

// Public — call from places that mutate progress (e.g. the book-reading
// flush handler) so the next book-info render sees the new last_chapter.
// Without this, the in-memory cache would serve stale data for up to
// TTL_MS after the user finished reading.
export const invalidateBookProgress = ({ userId, bookId } = {}) => {
  if (userId && bookId) {
    CACHE.delete(cacheKey(userId, bookId));
    return;
  }
  // No filters → nuke the lot. Used when auth changes (sign-out / -in).
  CACHE.clear();
};

const shapeProgress = (row) => {
  if (!row) {
    return {
      lastChapterId: null,
      lastChapterNumber: null,
      lastScrollPct: 0,
      lastReadAt: null,
      hasProgress: false,
    };
  }
  return {
    lastChapterId: row.last_chapter_id || null,
    lastChapterNumber: Number.isFinite(Number(row.last_chapter_number)) ? Number(row.last_chapter_number) : null,
    lastScrollPct: Number.isFinite(Number(row.last_scroll_pct)) ? Number(row.last_scroll_pct) : 0,
    lastReadAt: row.last_read_at || null,
    hasProgress: !!(row.last_chapter_id || row.last_read_at),
  };
};

export default function useBookProgress(userId, bookId) {
  const key = cacheKey(userId, bookId);
  const initial = readCache(key);
  const [progress, setProgress] = useState(initial.data ? shapeProgress(initial.data) : shapeProgress(null));
  // isLoading is only true on the very first paint of a key with no
  // cached data. SWR philosophy: don't show a spinner while we have
  // SOMETHING to show — even if it's stale.
  const [isLoading, setIsLoading] = useState(!initial.data);

  const fetchFresh = useCallback(async () => {
    if (!userId || !bookId) {
      setProgress(shapeProgress(null));
      setIsLoading(false);
      return;
    }
    try {
      const row = await BookReadService.getBookRead?.({ userId, bookId });
      writeCache(key, row || null);
      setProgress(shapeProgress(row));
    } catch (error) {
      // Don't blow away cached data on a transient fetch fail — keep
      // serving the stale value. This matters for offline-ish networks
      // where the user opens book-info and the read fails: better to
      // show "Continue: Chapter 5" from cache than fall back to "Start
      // Reading" and lose the resume affordance.
      console.warn("[useBookProgress] fetch failed:", error?.message);
    } finally {
      setIsLoading(false);
    }
  }, [bookId, key, userId]);

  useEffect(() => {
    let cancelled = false;
    // Stale-while-revalidate: paint from cache immediately, then refetch
    // in the background unless the cached entry is still fresh.
    const cached = readCache(key);
    if (cached.data) {
      setProgress(shapeProgress(cached.data));
      setIsLoading(false);
      if (cached.fresh) return; // within TTL, don't bother refetching
    }
    (async () => {
      if (cancelled) return;
      await fetchFresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchFresh, key]);

  return { ...progress, isLoading, refresh: fetchFresh };
}
