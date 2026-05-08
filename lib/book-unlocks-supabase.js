// Supabase-flavored book unlocks — thin wrapper over wallet-supabase.
// The wallet schema's `unlocks` table already supports book/chapter
// targets (see lib/wallet-supabase.js). This file just exposes the
// book-specific helpers the legacy lib/book-unlocks.js consumers expect.

import supabase from "./supabase";
import { resolveSupabaseUserId } from "./posts-supabase";
import { unlockContent, unlockBookBulk, getUnlocks } from "./wallet-supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resolveBookId = async (bookId) => {
  if (!bookId) return null;
  if (UUID_RE.test(bookId)) return bookId;
  const { data } = await supabase.from("books").select("id").eq("legacy_appwrite_id", bookId).maybeSingle();
  return data?.id || null;
};

const resolveChapterId = async (chapterId) => {
  if (!chapterId) return null;
  if (UUID_RE.test(chapterId)) return chapterId;
  const { data } = await supabase.from("chapters").select("id").eq("legacy_appwrite_id", chapterId).maybeSingle();
  return data?.id || null;
};

// Unlock one chapter atomically via the unlock_content RPC.
// Returns { ok, balance_after, cost, already_unlocked, error? }.
export const unlockChapter = async ({ chapterId, currency }) => {
  const chapterUuid = await resolveChapterId(chapterId);
  if (!chapterUuid) throw new Error("unlockChapter: cannot resolve chapter id");
  const result = await unlockContent({ targetType: "chapter", targetId: chapterUuid, currency });
  // ABUSE DEFENSE: dedup by chapter UUID. Re-tapping unlock on an
  // already-unlocked chapter (server returns already_unlocked=true)
  // doesn't tick a second time because the unlock cost is 0 and we
  // only count fresh unlocks. Defensive guard: even if the server
  // double-counts somehow, the per-day dedup keeps the goal honest.
  if (result?.ok && !result?.already_unlocked) {
    const { tickGoalUnique } = await import("./goals-store");
    tickGoalUnique("unlock", `unlock:chapter:${chapterUuid}`);
  }
  return result;
};

// Bulk-unlock all locked chapters of a book at the discount price.
export const unlockBookAllChapters = async ({ bookId, currency }) => {
  const bookUuid = await resolveBookId(bookId);
  if (!bookUuid) throw new Error("unlockBookAllChapters: cannot resolve book id");
  const result = await unlockBookBulk({ bookId: bookUuid, currency });
  // Bulk-unlock counts as ONE unlock event toward the goal (regardless
  // of how many chapters it covered). Dedup by bookId + day so re-
  // bulking a book during one session doesn't double-count.
  if (result?.ok) {
    const { tickGoalUnique } = await import("./goals-store");
    tickGoalUnique("unlock", `unlock:book:${bookUuid}`);
  }
  return result;
};

// Returns `true` if the user has unlocked a specific chapter.
export const isChapterUnlocked = async ({ chapterId, userId }) => {
  const chapterUuid = await resolveChapterId(chapterId);
  if (!chapterUuid) return false;
  // The wallet getUnlocks() reads the current user's unlocks set by RLS.
  // For other users' unlock checks, we'd need a SECURITY DEFINER RPC —
  // not used in the legacy code paths here.
  const unlocks = await getUnlocks();
  return unlocks.has(`chapter:${chapterUuid}`);
};

// Appwrite-shaped unlocks document for a (book, user) pair. Replaces the
// broken dispatcher wrapper that:
//   1. inverted `isFullyLocked` semantics (wrote `!isFullyUnlocked`,
//      which made every consumer using `!unlocks?.isFullyLocked` short-
//      circuit and treat all chapters as unlocked once the user had
//      ANY unlock row); and
//   2. dropped the chapter list because `Array.isArray(Set) === false`
//      (so per-chapter unlocks never made it into `unlocks.chapters`,
//      keeping legitimately-paid chapters locked); and
//   3. mismatched param names (`{book, unlockBy}` vs `{bookId, userId}`)
//      so `isBookFullyUnlocked` always returned false anyway.
//
// This implementation:
//   - resolves legacy_appwrite_id → uuid for the book up front;
//   - reads the user's full unlocks Set (one round trip, RLS-scoped);
//   - checks `book:<uuid>` for full-book unlocks;
//   - joins against the book's chapters and emits chapter $ids in the
//     same shape the consumer's `chapter?.$id` lookup uses
//     (legacy_appwrite_id || uuid), so `chapters.includes(chapter.$id)`
//     actually matches;
//   - returns the legacy `{ documents: [...], total }` envelope so
//     book-info.jsx / book-reading.jsx / BookChaptersModal don't need
//     any changes.
export const getBookUnlockByUser = async ({ book, unlockBy }) => {
  if (!book || !unlockBy) return { documents: [], total: 0 };
  try {
    const bookUuid = await resolveBookId(book);
    if (!bookUuid) return { documents: [], total: 0 };

    const unlocks = await getUnlocks();
    const isFullyUnlocked = unlocks.has(`book:${bookUuid}`);

    // Pull every chapter for this book in one round trip so we can map
    // chapter UUIDs back to legacy ids for the .includes() comparison
    // the consumer does on chapter.$id (which is legacy_appwrite_id ||
    // id per books-supabase.mapChapterRow).
    const { data: bookChapters } = await supabase
      .from("chapters")
      .select("id, legacy_appwrite_id")
      .eq("book_id", bookUuid);

    const unlockedIds = [];
    for (const c of bookChapters || []) {
      // The unlocks table can store a chapter target_id in three
      // forms depending on its provenance:
      //   1. Current Supabase UUID (the canonical form).
      //   2. Bare Appwrite hex (20 chars) — written by older Appwrite-
      //      flow inserts.
      //   3. `aw_` prefixed Appwrite hex (23 chars) — written by the
      //      Appwrite → Supabase migration of the unlocks table. The
      //      2026-05-09 backfill normalizes these to (1), but we keep
      //      the prefixed lookup here as defense-in-depth so any
      //      future stragglers (mid-deploy writes, partial restores)
      //      still resolve.
      const legacyKey = c.legacy_appwrite_id ? `chapter:${c.legacy_appwrite_id}` : null;
      const prefixedKey = c.legacy_appwrite_id ? `chapter:aw_${c.legacy_appwrite_id}` : null;
      if (
        unlocks.has(`chapter:${c.id}`) ||
        (legacyKey && unlocks.has(legacyKey)) ||
        (prefixedKey && unlocks.has(prefixedKey))
      ) {
        unlockedIds.push(c.legacy_appwrite_id || c.id);
        // Also include the raw UUID — defensive in case the consumer
        // ever passes a $id that resolves to the uuid form.
        if (c.legacy_appwrite_id) unlockedIds.push(c.id);
      }
    }

    if (unlockedIds.length === 0 && !isFullyUnlocked) {
      return { documents: [], total: 0 };
    }

    return {
      documents: [
        {
          $id: `${book}::${unlockBy}`,
          book,
          unlockBy,
          chapters: unlockedIds,
          isFullyUnlocked,
          // NOTE: deliberately do NOT set isFullyLocked. The consumer's
          // `!unlocks?.isFullyLocked` gate then evaluates to !undefined
          // === true, which is the original Appwrite behavior (the
          // Appwrite documents never wrote that field either).
        },
      ],
      total: 1,
    };
  } catch (e) {
    console.error("[book-unlocks-supabase] getBookUnlockByUser:", e?.message);
    return { documents: [], total: 0 };
  }
};

export const isBookFullyUnlocked = async ({ bookId, userId }) => {
  const bookUuid = await resolveBookId(bookId);
  if (!bookUuid) return false;
  // Get all chapters in the book + check that every locked chapter has an
  // unlock row. Cheaper than per-chapter checks if we already cache unlocks.
  const [{ data: chapters }, unlocks] = await Promise.all([
    supabase.from("chapters").select("id, is_locked").eq("book_id", bookUuid),
    getUnlocks(),
  ]);
  const lockedChapters = (chapters || []).filter((c) => c.is_locked);
  if (lockedChapters.length === 0) return true; // no locks means fully accessible
  return lockedChapters.every((c) => unlocks.has(`chapter:${c.id}`));
};

// List of unlocked chapter ids for the current user — used to show the
// "unlocked" badge in the chapter list. Returns Set for fast .has lookups.
export const getUnlockedChapterIds = async ({ userId }) => {
  const unlocks = await getUnlocks();
  const ids = new Set();
  for (const key of unlocks) {
    const [type, id] = key.split(":");
    if (type === "chapter" && id) ids.add(id);
  }
  return ids;
};

export const getUnlockedBookIds = async ({ userId }) => {
  const unlocks = await getUnlocks();
  const ids = new Set();
  for (const key of unlocks) {
    const [type, id] = key.split(":");
    if (type === "book" && id) ids.add(id);
  }
  return ids;
};
