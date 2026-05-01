// Supabase-flavored book ratings — drop-in for lib/book-rating.js.
// Uses book_ratings table from migration_books_engagement.sql.
// Composite PK (book_id, user_id) → upsert replaces user's existing rating.

import supabase from "./supabase";
import { resolveSupabaseUserId } from "./posts-supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resolveBookId = async (bookId) => {
  if (!bookId) return null;
  if (UUID_RE.test(bookId)) return bookId;
  const { data } = await supabase.from("books").select("id").eq("legacy_appwrite_id", bookId).maybeSingle();
  return data?.id || null;
};

// Submit/update a rating. Returns the new aggregate state.
export const rateBook = async ({ bookId, userId, rating, review = null }) => {
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new Error("rating must be 1-5");
  }
  const bookUuid = await resolveBookId(bookId);
  const userUuid = await resolveSupabaseUserId(userId);
  if (!bookUuid || !userUuid) throw new Error("rateBook: missing book or user");

  const { error } = await supabase
    .from("book_ratings")
    .upsert(
      { book_id: bookUuid, user_id: userUuid, rating, review, updated_at: new Date().toISOString() },
      { onConflict: "book_id,user_id" },
    );
  if (error) throw error;

  // Trigger handles aggregate update; just return the user's row.
  const { data } = await supabase
    .from("book_ratings")
    .select("*")
    .eq("book_id", bookUuid)
    .eq("user_id", userUuid)
    .maybeSingle();
  return data;
};

export const getMyRating = async ({ bookId, userId }) => {
  const bookUuid = await resolveBookId(bookId);
  const userUuid = await resolveSupabaseUserId(userId);
  if (!bookUuid || !userUuid) return null;
  const { data } = await supabase
    .from("book_ratings")
    .select("rating, review, created_at, updated_at")
    .eq("book_id", bookUuid)
    .eq("user_id", userUuid)
    .maybeSingle();
  return data;
};

// Aggregate stats — comes from books.ratings_count + books.ratings_avg
// (kept by trigger). Avoids count(*) per render.
export const getBookRatingStats = async ({ bookId }) => {
  const bookUuid = await resolveBookId(bookId);
  if (!bookUuid) return { count: 0, avg: 0 };
  const { data } = await supabase
    .from("books")
    .select("ratings_count, ratings_avg")
    .eq("id", bookUuid)
    .maybeSingle();
  return { count: data?.ratings_count ?? 0, avg: Number(data?.ratings_avg) || 0 };
};

export const removeMyRating = async ({ bookId, userId }) => {
  const bookUuid = await resolveBookId(bookId);
  const userUuid = await resolveSupabaseUserId(userId);
  if (!bookUuid || !userUuid) return;
  const { error } = await supabase
    .from("book_ratings")
    .delete()
    .eq("book_id", bookUuid)
    .eq("user_id", userUuid);
  if (error) throw error;
};

// List recent reviews — used on book detail page.
export const fetchRecentReviews = async ({ bookId, limit = 20, lastId = null } = {}) => {
  const bookUuid = await resolveBookId(bookId);
  if (!bookUuid) return [];
  let q = supabase
    .from("book_ratings")
    .select(`
      book_id, user_id, rating, review, created_at,
      profiles!book_ratings_user_id_fkey ( id, username, avatar_url, legacy_appwrite_id )
    `)
    .eq("book_id", bookUuid)
    .not("review", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (lastId) {
    const { data: cursor } = await supabase
      .from("book_ratings")
      .select("created_at")
      .eq("book_id", bookUuid)
      .eq("user_id", lastId)
      .maybeSingle();
    if (cursor?.created_at) q = q.lt("created_at", cursor.created_at);
  }
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((row) => ({
    bookId: row.book_id,
    userId: row.user_id,
    rating: row.rating,
    review: row.review,
    createdAt: row.created_at,
    user: row.profiles,
  }));
};
