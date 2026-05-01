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

class BookUnlocksServiceSupabase {
  // Instance methods — backend calls
  async unlockChapter(args) { return supabaseImpl.unlockChapter(args); }
  async unlockBookAllChapters(args) { return supabaseImpl.unlockBookAllChapters(args); }
  async isChapterUnlocked(args) { return supabaseImpl.isChapterUnlocked(args); }
  async isBookFullyUnlocked(args) { return supabaseImpl.isBookFullyUnlocked(args); }
  async getUnlockedChapterIds(args) { return supabaseImpl.getUnlockedChapterIds(args); }
  async getUnlockedBookIds(args) { return supabaseImpl.getUnlockedBookIds(args); }

  // ── Static helpers — pure compute, no backend ──
  // Copied verbatim from BookUnlocksServiceAppwrite so behavior is
  // byte-for-byte identical regardless of which flag is active.
  static isBookOwnedByUser({ book, currentUserId }) {
    const ownerId = resolveEntityId(book?.uploader);
    const viewerId = resolveEntityId(currentUserId);
    return Boolean(ownerId && viewerId && ownerId === viewerId);
  }

  static isChapterLocked({ book, index, chapter, bookChapterLockStart, unlocks, currentUserId }) {
    if (BookUnlocksServiceSupabase.isBookOwnedByUser({ book, currentUserId })) return false;
    const chapterOrder = getBookChapterOrder(chapter, index);
    if (chapterOrder === INTRODUCTION_ORDER) return false;

    return book?.isLocked && chapterOrder >= bookChapterLockStart && !unlocks?.isFullyLocked && !unlocks?.chapters?.includes(chapter?.$id);
  }
}

export const BookUnlocksService = USE_SUPABASE_BOOKS
  ? BookUnlocksServiceSupabase
  : BookUnlocksServiceAppwrite;
