// Supabase-flavored book reading progress — drop-in for lib/book-reads.js.
// Uses the existing book_reads table (user_id, book_id, last_chapter_id,
// last_chapter_number, progress_pct, last_read_at).

import supabase from "./supabase";
import { resolveSupabaseUserId } from "./posts-supabase";

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

// Upsert reading progress. Replaces the user's prior progress row in place.
export const upsertBookRead = async ({
  userId,
  bookId,
  chapterId = null,
  chapterNumber = null,
  progressPct = null,
}) => {
  const userUuid = await resolveSupabaseUserId(userId);
  const bookUuid = await resolveBookId(bookId);
  const chapterUuid = chapterId ? await resolveChapterId(chapterId) : null;
  if (!userUuid || !bookUuid) return null;

  const payload = {
    user_id: userUuid,
    book_id: bookUuid,
    last_read_at: new Date().toISOString(),
  };
  if (chapterUuid) payload.last_chapter_id = chapterUuid;
  if (chapterNumber != null) payload.last_chapter_number = chapterNumber;
  if (progressPct != null) payload.progress_pct = progressPct;

  const { data, error } = await supabase
    .from("book_reads")
    .upsert(payload, { onConflict: "user_id,book_id" })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
};

export const getBookRead = async ({ userId, bookId }) => {
  const userUuid = await resolveSupabaseUserId(userId);
  const bookUuid = await resolveBookId(bookId);
  if (!userUuid || !bookUuid) return null;
  const { data } = await supabase
    .from("book_reads")
    .select("user_id, book_id, last_chapter_id, last_chapter_number, progress_pct, last_read_at")
    .eq("user_id", userUuid)
    .eq("book_id", bookUuid)
    .maybeSingle();
  return data;
};

// Bulk fetch — used by Continue Reading widget on home/profile to show
// the most recently-read books in one query.
export const fetchBookReadsByIds = async ({ userId, bookIds = [] }) => {
  if (!userId || bookIds.length === 0) return [];
  const userUuid = await resolveSupabaseUserId(userId);
  if (!userUuid) return [];

  const resolvedIds = await Promise.all(
    bookIds.map((id) => (UUID_RE.test(id) ? id : resolveBookId(id))),
  );
  const uuidIds = resolvedIds.filter(Boolean);
  if (uuidIds.length === 0) return [];

  const { data } = await supabase
    .from("book_reads")
    .select("user_id, book_id, last_chapter_id, last_chapter_number, progress_pct, last_read_at")
    .eq("user_id", userUuid)
    .in("book_id", uuidIds);
  return data || [];
};

export const fetchRecentReads = async ({ userId, limit = 20 } = {}) => {
  if (!userId) return [];
  const userUuid = await resolveSupabaseUserId(userId);
  if (!userUuid) return [];
  const { data } = await supabase
    .from("book_reads")
    .select("user_id, book_id, last_chapter_id, last_chapter_number, progress_pct, last_read_at")
    .eq("user_id", userUuid)
    .order("last_read_at", { ascending: false })
    .limit(limit);
  return data || [];
};

// ─────────────────────────────────────────────────────────────────────────
// Appwrite-compat aliases
// ─────────────────────────────────────────────────────────────────────────
// Match the legacy BookReadService method names so consumer screens
// (book-reading.jsx, BookCard, BookCatalogCard, BookInfoStats,
// BookChapterStats, BookLibraryCard) work unchanged when the
// USE_SUPABASE_BOOKS flag flips on.
//
// Two semantic categories:
//   • Per-user progress: readBookChapter (write), getContinueReadingBook
//     (read) — backed by book_reads table.
//   • Aggregate stats: fetchBookRead, fetchChapterRead — backed by the
//     denormalized counter columns on books/chapters (views_count,
//     ratings_avg, etc.) which are kept current by Postgres triggers.

// readBookChapter({ userId, bookId, chapterId }) — Appwrite name. Wraps
// the Supabase upsertBookRead. Server-side trigger increments
// chapters.views_count + books.views_count automatically.
export const readBookChapter = async ({ userId, bookId, chapterId }) => {
  if (!userId || !bookId || !chapterId) {
    console.warn("readBookChapter missing required IDs:", { userId, bookId, chapterId });
    return;
  }
  return upsertBookRead({ userId, bookId, chapterId });
};

// fetchBookRead({ bookId }) — returns aggregate book stats (totalReads,
// averageRating). The Appwrite version queried a separate `bookReads`
// collection that held a single denormalized stats doc per book; the
// Supabase schema keeps these counters as columns on `books` itself,
// updated by Postgres triggers, so we read them directly.
//
// Returns null if the book doesn't exist (consumer treats null as 0).
export const fetchBookRead = async ({ bookId }) => {
  if (!bookId) return null;
  const isUuid = UUID_RE.test(bookId);
  const column = isUuid ? "id" : "legacy_appwrite_id";
  const { data, error } = await supabase
    .from("books")
    .select("id, views_count, ratings_avg, ratings_count, legacy_appwrite_id")
    .eq(column, bookId)
    .maybeSingle();
  if (error) {
    console.error("fetchBookRead error:", error.message);
    return null;
  }
  if (!data) return null;
  return {
    // Appwrite-shaped fields the renderer expects
    $id: data.legacy_appwrite_id || data.id,
    totalReads: data.views_count ?? 0,
    averageRating: data.ratings_avg ?? 0,
    ratingsCount: data.ratings_count ?? 0,
  };
};

// fetchChapterRead({ chapterId }) — returns aggregate chapter read count.
// In Appwrite this was the count of documents in
// booksChaptersReadsCollection filtered by chapter; in Supabase this is
// the views_count column on `chapters`, maintained by triggers.
//
// Returns a number (0 when no record), matching legacy behavior used by
// BookChapterStats.jsx.
export const fetchChapterRead = async ({ chapterId }) => {
  if (!chapterId) return 0;
  const isUuid = UUID_RE.test(chapterId);
  const column = isUuid ? "id" : "legacy_appwrite_id";
  const { data, error } = await supabase
    .from("chapters")
    .select("views_count")
    .eq(column, chapterId)
    .maybeSingle();
  if (error) {
    console.error("fetchChapterRead error:", error.message);
    return 0;
  }
  return data?.views_count ?? 0;
};

// invalidateBookReadCache(bookId) — Appwrite consumers call this after
// recording a read to bust the per-book stats cache. The Supabase path
// reads aggregate stats directly from the books table on every render
// (no client-side cache today), so this is a no-op. Provided for API
// parity so the dispatcher can re-export it without conditional code.
export const invalidateBookReadCache = (_bookId) => {
  // No-op for Supabase. If we add a client-side stats cache later,
  // wire the eviction here.
};
