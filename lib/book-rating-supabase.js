// Supabase-flavored book ratings — drop-in for lib/book-rating.js.
// Uses book_ratings table from migration_books_engagement.sql.
// Composite PK (book_id, user_id) → upsert replaces user's existing rating.
//
// Public surface — three name conventions exposed:
//   • Supabase-native: rateBook, getMyRating, getBookRatingStats
//   • Appwrite-compat aliases: createRating, getUserRating, getBookRatings
//
// Both naming styles are exported so:
//   1. New code (web + future mobile) can use the cleaner Supabase names.
//   2. Legacy mobile consumers (book-info.jsx etc.) keep working when
//      USE_SUPABASE_BOOKS flips on, without touching every call site.

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

// Aggregate stats — book-info / catalog cards / rankings rows all
// surface this. Two-tier read:
//
//   1. Denormalized columns on `books` (ratings_count + ratings_avg)
//      — fast (single row), trigger-maintained.
//   2. Real-time aggregate from `book_ratings` — fallback when the
//      denormalized columns are 0/null (trigger never installed,
//      backfill missed, etc.). Slower but always accurate.
//
// Why the fallback exists: BookRating chip on book-info was reading
// "★ 0" on books with hundreds of real ratings because the
// denormalized `ratings_avg` had never been populated. Mobile users
// saw a brand-new chip on every popular book regardless of how many
// people had rated. The fallback closes that gap so the chip reflects
// reality even on books predating the trigger.
//
// Return shape: includes every field name historical callers have
// used (`count`, `avg`, `average`, `averageRating`) so any consumer
// — book-info.jsx (`averageRating`), catalog rows (`average`), older
// Appwrite-shaped code (`avg`) — gets the same number.
export const getBookRatingStats = async ({ bookId }) => {
  const bookUuid = await resolveBookId(bookId);
  if (!bookUuid) {
    return { count: 0, avg: 0, average: 0, averageRating: 0 };
  }

  // Tier 1: denormalized.
  const { data: bookRow } = await supabase
    .from("books")
    .select("ratings_count, ratings_avg")
    .eq("id", bookUuid)
    .maybeSingle();

  let count = Number(bookRow?.ratings_count) || 0;
  let avg = Number(bookRow?.ratings_avg) || 0;

  // Tier 2: real-time aggregate when the denormalized columns are
  // empty. We only do this when both are 0 — once at least one of
  // them is populated we trust the trigger.
  if (count === 0 && avg === 0) {
    const { data: rows } = await supabase
      .from("book_ratings")
      .select("rating")
      .eq("book_id", bookUuid);
    const ratings = (rows || []).map((r) => Number(r.rating)).filter((n) => Number.isFinite(n) && n > 0);
    if (ratings.length > 0) {
      count = ratings.length;
      avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    }
  }

  return {
    count,
    avg,
    average: avg,
    averageRating: avg,
  };
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

// ─────────────────────────────────────────────────────────────────────────
// Appwrite-compat aliases — match the legacy BookRatingService static method
// names so consumer screens (book-info.jsx etc.) work unchanged when the
// USE_SUPABASE_BOOKS flag flips on. Each alias is a thin wrapper over its
// Supabase-native counterpart above.
// ─────────────────────────────────────────────────────────────────────────

// createRating({ bookId, userId, rating }) → rateBook (review optional)
export const createRating = ({ bookId, userId, rating }) =>
  rateBook({ bookId, userId, rating, review: null });

// getUserRating({ bookId, userId }) → getMyRating
export const getUserRating = (args) => getMyRating(args);

// getBookRatings({ bookId }) → getBookRatingStats
// Appwrite version returned a single document; the Supabase getBookRatingStats
// returns a stats object ({ count, average, ... }). Consumers in mobile read
// `.average` / `.count` either way; this is shape-compatible at the call sites
// audited (book-info.jsx).
export const getBookRatings = (args) => getBookRatingStats(args);
