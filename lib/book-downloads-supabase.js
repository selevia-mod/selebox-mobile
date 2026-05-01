// Supabase-flavored book downloads — drop-in for lib/book-downloads.js.
// Uses book_downloads table from migration_books_engagement.sql.
// Composite PK (user_id, book_id) — re-downloading bumps downloaded_at
// in place, no duplicate rows.

import supabase from "./supabase";
import { resolveSupabaseUserId } from "./posts-supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resolveBookId = async (bookId) => {
  if (!bookId) return null;
  if (UUID_RE.test(bookId)) return bookId;
  const { data } = await supabase.from("books").select("id").eq("legacy_appwrite_id", bookId).maybeSingle();
  return data?.id || null;
};

// Mark a book as downloaded by the user. Idempotent — re-downloading
// updates downloaded_at to the current time without creating duplicates.
export const markBookDownloaded = async ({ userId, bookId }) => {
  const userUuid = await resolveSupabaseUserId(userId);
  const bookUuid = await resolveBookId(bookId);
  if (!userUuid || !bookUuid) return null;
  const { error } = await supabase
    .from("book_downloads")
    .upsert(
      { user_id: userUuid, book_id: bookUuid, downloaded_at: new Date().toISOString() },
      { onConflict: "user_id,book_id" },
    );
  if (error) throw error;
  return { ok: true };
};

export const removeBookDownload = async ({ userId, bookId }) => {
  const userUuid = await resolveSupabaseUserId(userId);
  const bookUuid = await resolveBookId(bookId);
  if (!userUuid || !bookUuid) return;
  const { error } = await supabase
    .from("book_downloads")
    .delete()
    .eq("user_id", userUuid)
    .eq("book_id", bookUuid);
  if (error) throw error;
};

export const isBookDownloaded = async ({ userId, bookId }) => {
  const userUuid = await resolveSupabaseUserId(userId);
  const bookUuid = await resolveBookId(bookId);
  if (!userUuid || !bookUuid) return false;
  const { data } = await supabase
    .from("book_downloads")
    .select("user_id")
    .eq("user_id", userUuid)
    .eq("book_id", bookUuid)
    .maybeSingle();
  return !!data;
};

// List of books the current user has downloaded — used on the
// "Downloaded books" section.
export const fetchDownloadedBooks = async ({ userId, limit = 50 }) => {
  const userUuid = await resolveSupabaseUserId(userId);
  if (!userUuid) return [];
  const { data, error } = await supabase
    .from("book_downloads")
    .select(`
      book_id, downloaded_at,
      books ( id, title, description, cover_url, author_id, legacy_appwrite_id,
              profiles!books_author_id_fkey ( id, username, avatar_url ) )
    `)
    .eq("user_id", userUuid)
    .order("downloaded_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || [])
    .filter((row) => row.books)
    .map((row) => ({
      bookId: row.book_id,
      downloadedAt: row.downloaded_at,
      book: row.books,
    }));
};

// Count of downloads on a book — used as a public engagement metric.
export const getBookDownloadCount = async ({ bookId }) => {
  const bookUuid = await resolveBookId(bookId);
  if (!bookUuid) return 0;
  const { count } = await supabase
    .from("book_downloads")
    .select("user_id", { count: "exact", head: true })
    .eq("book_id", bookUuid);
  return count || 0;
};
