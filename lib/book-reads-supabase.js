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
//
// Wattpad-style fields:
//   • lastScrollPct — fraction of the current chapter's contentHeight
//     (0-1) where the reader stopped. Persisted on scroll-stop / blur
//     and replayed on chapter remount so the reader picks up at the
//     exact paragraph, not just the start of the chapter. Stored as a
//     percentage rather than a pixel offset because font-size and
//     viewport changes between sessions invalidate raw pixel offsets.
//   • progressPct — book-level overall progress (kept for backward
//     compat with the legacy column; not currently written by the
//     mobile reader, but selecting it keeps the API surface consistent).
export const upsertBookRead = async ({
  userId,
  bookId,
  chapterId = null,
  chapterNumber = null,
  progressPct = null,
  lastScrollPct = null,
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
  if (lastScrollPct != null) {
    // Defensive clamp — the column has a CHECK constraint, but better
    // to land cleanly than reject the upsert if a caller mis-handles
    // a contentHeight=0 division and produces NaN/Infinity.
    const n = Number(lastScrollPct);
    if (Number.isFinite(n)) payload.last_scroll_pct = Math.max(0, Math.min(1, n));
  } else if (chapterUuid) {
    // Caller didn't pass a scroll pct, but IS writing a chapter_id.
    // Decide whether to reset pct to 0 based on whether this is a
    // chapter CHANGE or a re-write of the SAME chapter:
    //   • Same chapter (resume case): leave last_scroll_pct alone so
    //     the scroll restore on remount has something to seek to.
    //   • Different chapter (navigation case): reset to 0 — the saved
    //     pct belonged to the old chapter and would scroll the new
    //     one to a meaningless offset otherwise.
    // This costs one extra SELECT per readBookChapter call but keeps
    // the resume semantics correct without forcing every caller to
    // know whether they're resuming or navigating.
    const { data: existing } = await supabase
      .from("book_reads")
      .select("last_chapter_id")
      .eq("user_id", userUuid)
      .eq("book_id", bookUuid)
      .maybeSingle();
    if (existing?.last_chapter_id && existing.last_chapter_id !== chapterUuid) {
      payload.last_scroll_pct = 0;
    }
  }

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
    .select("user_id, book_id, last_chapter_id, last_chapter_number, progress_pct, last_scroll_pct, last_read_at")
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
    .select("user_id, book_id, last_chapter_id, last_chapter_number, progress_pct, last_scroll_pct, last_read_at")
    .eq("user_id", userUuid)
    .in("book_id", uuidIds);
  return data || [];
};

// fetchRecentReads — one query that returns the user's most recently
// read books along with the metadata each card needs to render. Used by
// the home "Continue Reading" shelf and any other surface that wants to
// list resume targets without hitting per-book stat fetchers.
//
// The embedded `books(...)` join pulls the columns BookCard / Book card
// shells consume (title, thumbnail, status, lock fields, view counts).
// Without the join the shelf would have to issue an N+1 fetchBook call
// per row, which made Continue Reading the slowest scroll on the home
// tab in May 2026 profiling.
export const fetchRecentReads = async ({ userId, limit = 20 } = {}) => {
  if (!userId) return [];
  const userUuid = await resolveSupabaseUserId(userId);
  if (!userUuid) return [];
  const { data, error } = await supabase
    .from("book_reads")
    .select(`
      user_id,
      book_id,
      last_chapter_id,
      last_chapter_number,
      progress_pct,
      last_scroll_pct,
      last_read_at,
      book:books(
        id,
        legacy_appwrite_id,
        title,
        thumbnail,
        status,
        is_locked,
        lock_from_chapter,
        views_count,
        ratings_avg,
        ratings_count
      )
    `)
    .eq("user_id", userUuid)
    .order("last_read_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[book-reads-supabase] fetchRecentReads error:", error.message);
    return [];
  }
  // Filter out rows whose book got deleted (book === null after the
  // join) — they'd render as empty cards with no thumbnail/title.
  return (data || []).filter((row) => row.book);
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

// readBookChapter({ userId, bookId, chapterId }) — Appwrite name kept for
// dispatcher-shape compatibility. Two jobs on every chapter open:
//
//   1. Upsert `book_reads` — per-user reading PROGRESS row, used by the
//      "Continue Reading" rail to remember where each user left off in
//      each book. Composite PK (user_id, book_id) → one row per user
//      per book, ever. (Wattpad-style resume — see upsertBookRead.)
//
//   2. Bump aggregate view counters via the `record_chapter_view` RPC.
//      The RPC is SECURITY DEFINER and unconditionally adds +1 to BOTH
//      chapters.views_count and books.views_count for the parent book.
//      No cooldown, no dedup — every chapter open counts (per the
//      May 9, 2026 simplification, see migration
//      2026-05-09_simple_views_no_cooldown.sql for the rationale).
//
// Replaces the older record_chapter_read RPC + chapter_reads trigger
// pipeline that gated re-reads on a 24h cooldown. That cooldown was
// silently eating most of the writers' actual reader engagement, since
// in a small-reader-base scenario the dominant pattern is the same
// users re-opening the same chapters multiple times in a session.
//
// View bump intentionally swallows errors — a stats write must never
// block the user from reading the chapter.
export const readBookChapter = async ({ userId, bookId, chapterId }) => {
  if (!userId || !bookId || !chapterId) {
    console.warn("readBookChapter missing required IDs:", { userId, bookId, chapterId });
    return;
  }

  // 1) Reading-progress upsert — must succeed so "Continue Reading" works.
  //
  // Scroll-position handling: upsertBookRead's server-side logic decides
  // whether to reset last_scroll_pct based on whether this is the SAME
  // chapter as the previously-saved one (resume → keep the pct so the
  // restore-on-mount has something to seek to) or a DIFFERENT chapter
  // (navigation → reset pct to 0). We don't pass an explicit pct here.
  const progressResult = await upsertBookRead({ userId, bookId, chapterId });

  // 2) Chapter-view bump — best-effort, never throws.
  try {
    const chapterUuid = await resolveChapterId(chapterId);
    if (!chapterUuid) return progressResult;

    const { error: rpcErr } = await supabase.rpc("record_chapter_view", {
      p_chapter_id: chapterUuid,
    });
    if (rpcErr) {
      console.warn("[book-reads-supabase] record_chapter_view failed:", rpcErr.message);
    }
  } catch (e) {
    console.warn("[book-reads-supabase] record_chapter_view threw:", e?.message);
  }

  return progressResult;
};

// recordBookView({ bookId }) — fires once per book-info screen open.
// Bumps books.views_count by 1 unconditionally. Mirrors the
// record_chapter_view semantics on the book level: no per-user dedup,
// no cooldown, every open counts. Best-effort like the chapter version
// — if the RPC fails the user shouldn't notice, just the writer's
// metric is +0 instead of +1 for that open.
export const recordBookView = async ({ bookId }) => {
  if (!bookId) return;
  try {
    const bookUuid = await resolveBookId(bookId);
    if (!bookUuid) return;

    const { error: rpcErr } = await supabase.rpc("record_book_view", {
      p_book_id: bookUuid,
    });
    if (rpcErr) {
      console.warn("[book-reads-supabase] record_book_view failed:", rpcErr.message);
    }
  } catch (e) {
    console.warn("[book-reads-supabase] record_book_view threw:", e?.message);
  }
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
