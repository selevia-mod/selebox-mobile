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
