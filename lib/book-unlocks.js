// lib/book-unlocks.js — BookUnlocksService dispatcher.
//
// Routes between Supabase (lib/book-unlocks-supabase.js — wraps
// wallet-supabase unlock_content + unlock_book_bulk RPCs) and Appwrite
// (lib/book-unlocks-appwrite.js — legacy unlockVideo Cloud Function +
// unlockedVideos collection) via USE_SUPABASE_BOOKS.
//
// Static helpers (isChapterLocked, isBookOwnedByUser) are pure compute
// functions — no backend calls — so they're copied verbatim onto the
// Supabase class for parity. Consumers (book-info.jsx, book-reading.jsx,
// BookChaptersModal, BookLibraryCard — 9+ call sites total) use them as
// static class methods: `BookUnlocksService.isChapterLocked(...)`.

import { USE_SUPABASE_BOOKS } from "./feature-flags";
import * as supabaseImpl from "./book-unlocks-supabase";
import { BookUnlocksService as BookUnlocksServiceAppwrite } from "./book-unlocks-appwrite";
import { INTRODUCTION_ORDER, getBookChapterOrder } from "./books";

// resolveEntityId — accept string IDs OR Appwrite-shaped { $id } /
// Supabase-shaped { id, uid } objects. Mirrors the Appwrite impl.
const resolveEntityId = (value) => {
  if (!value) return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value?.$id || value?.id || value?.uid || null;
};

// Collect EVERY non-empty identifier known for a user/profile object.
// Authors created before the Supabase auth migration carry both a
// legacy Appwrite hex ID (`legacy_appwrite_id` / `$id`) AND a
// Supabase UUID (`id`). The viewer's `user.$id` could be either
// depending on USE_SUPABASE_AUTH, so the owner check has to try them
// all — comparing only one ID drops a chunk of legitimate owners and
// paywalls them on their own work.
const collectEntityIds = (value) => {
  if (!value) return [];
  if (typeof value === "string" || typeof value === "number") {
    const s = String(value);
    return s ? [s] : [];
  }
  return [value?.$id, value?.id, value?.uid, value?.legacy_appwrite_id]
    .map((v) => (v == null ? "" : String(v)))
    .filter((s) => s.length > 0);
};

class BookUnlocksServiceSupabase {
  // Instance methods — backend calls
  async unlockChapter(args) { return supabaseImpl.unlockChapter(args); }
  async unlockBookAllChapters(args) { return supabaseImpl.unlockBookAllChapters(args); }
  async isChapterUnlocked(args) { return supabaseImpl.isChapterUnlocked(args); }
  async isBookFullyUnlocked(args) { return supabaseImpl.isBookFullyUnlocked(args); }
  async getUnlockedChapterIds(args) { return supabaseImpl.getUnlockedChapterIds(args); }
  async getUnlockedBookIds(args) { return supabaseImpl.getUnlockedBookIds(args); }

  // Appwrite-shape compatibility: book-reading.jsx, book-info.jsx,
  // BookChaptersModal, BookLibraryCard all expect the
  // `{ documents: [{ chapters, isFullyUnlocked }] }` envelope. The
  // canonical implementation lives in book-unlocks-supabase.js so the
  // bookId resolution + chapter-id mapping logic stays in one place.
  // Earlier this method was a hand-rolled wrapper here that had three
  // bugs (Set-vs-Array, isFullyLocked inversion, param-name mismatch)
  // — see the supabase impl's comment for the full rationale.
  async getBookUnlockByUser(args) { return supabaseImpl.getBookUnlockByUser(args); }

  // ── Static helpers — pure compute, no backend ──
  // URGENT FIX (May 2026): owner-on-own-book bypass was failing for
  // authors created before the Supabase auth migration. The book's
  // uploader.$id is `legacy_appwrite_id || id`, while the viewer's
  // `user.$id` is the legacy hex under USE_SUPABASE_AUTH=false but
  // the Supabase UUID under =true. When those two pickers landed on
  // different ids for the same person (very common — virtually every
  // author predates the auth flip), the equality check failed and
  // the owner saw their own book as locked.
  //
  // Fix: collect EVERY known id on both sides (legacy hex + UUID +
  // any future identifier) and call the user the owner if ANY of
  // them match. False positives are essentially impossible because
  // the id spaces don't overlap (UUIDs are 36-char hyphenated, hex
  // ids are 24-char unhyphenated).
  static isBookOwnedByUser({ book, currentUserId }) {
    const ownerIds = new Set(collectEntityIds(book?.uploader));
    if (ownerIds.size === 0) return false;
    const viewerIds = collectEntityIds(currentUserId);
    for (const vid of viewerIds) {
      if (ownerIds.has(vid)) return true;
    }
    return false;
  }

  // Display-only lock check: same two-signal logic as isChapterLocked, but
  // WITHOUT the owner-bypass short-circuit. Used by visual surfaces (the
  // lock icon in BookChaptersModal, etc.) where the author should see what
  // readers see — a lock icon on chapters behind their own paywall — even
  // though they themselves can read those chapters for free. Don't use this
  // for paywall enforcement; use isChapterLocked for that (the bypass keeps
  // authors from being paywalled on their own work).
  static isChapterLockedForDisplay({ book, index, chapter, bookChapterLockStart, unlocks }) {
    const chapterOrder = getBookChapterOrder(chapter, index);
    if (chapterOrder === INTRODUCTION_ORDER) return false;

    if (unlocks?.isFullyUnlocked) return false;
    if (unlocks?.chapters?.includes(chapter?.$id)) return false;

    const chapterFlagLocked = !!(chapter?.is_locked || chapter?.isLocked);
    const resolvedLockStart =
      book?.bookChapterLockStart ??
      bookChapterLockStart ??
      (book?.isLocked ? 1 : Number.POSITIVE_INFINITY);
    const bookThresholdLocked = book?.isLocked && chapterOrder >= resolvedLockStart;

    return (bookThresholdLocked || chapterFlagLocked) && !unlocks?.isFullyLocked;
  }

  static isChapterLocked({ book, index, chapter, bookChapterLockStart, unlocks, currentUserId }) {
    if (BookUnlocksServiceSupabase.isBookOwnedByUser({ book, currentUserId })) return false;
    const chapterOrder = getBookChapterOrder(chapter, index);
    if (chapterOrder === INTRODUCTION_ORDER) return false;

    // Already-paid? Same answer regardless of which lock signal flagged
    // the chapter — short-circuit on bulk unlock or per-chapter unlock.
    if (unlocks?.isFullyUnlocked) return false;
    if (unlocks?.chapters?.includes(chapter?.$id)) return false;

    // Two independent lock signals — either one being true means the
    // chapter is paid:
    //
    //  (1) Book-level threshold. `book.lock_from_chapter` (exposed as
    //      `book.bookChapterLockStart`) — every chapter at or past
    //      this number is locked. We resolve the threshold with a
    //      per-book fallback because relying on globalSettings caused
    //      a flicker where chapterOrder >= undefined was always false
    //      and every chapter rendered free during rehydration.
    //
    //  (2) Per-chapter `is_locked` flag. The legacy mechanism — older
    //      books were locked by toggling individual chapters rather
    //      than setting a book-level threshold. Web honors this via
    //      `isLockedDef = isAtOrAfterLockPoint || c.is_locked` (see
    //      Selebox/js/app.js:7834). Mobile previously ignored the flag
    //      entirely and rendered legacy paid books as free. We now
    //      honor it the same way web does.
    //
    // The mobile mapper exposes per-chapter lock under both
    // `chapter.is_locked` (Supabase shape) and `chapter.isLocked`
    // (legacy alias), so we read both for safety.
    const chapterFlagLocked = !!(chapter?.is_locked || chapter?.isLocked);

    const resolvedLockStart =
      book?.bookChapterLockStart ??
      bookChapterLockStart ??
      (book?.isLocked ? 1 : Number.POSITIVE_INFINITY);
    const bookThresholdLocked = book?.isLocked && chapterOrder >= resolvedLockStart;

    return (bookThresholdLocked || chapterFlagLocked) && !unlocks?.isFullyLocked;
  }
}

export const BookUnlocksService = USE_SUPABASE_BOOKS
  ? BookUnlocksServiceSupabase
  : BookUnlocksServiceAppwrite;
