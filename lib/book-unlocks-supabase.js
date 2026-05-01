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
  return unlockContent({ targetType: "chapter", targetId: chapterUuid, currency });
};

// Bulk-unlock all locked chapters of a book at the discount price.
export const unlockBookAllChapters = async ({ bookId, currency }) => {
  const bookUuid = await resolveBookId(bookId);
  if (!bookUuid) throw new Error("unlockBookAllChapters: cannot resolve book id");
  return unlockBookBulk({ bookId: bookUuid, currency });
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
