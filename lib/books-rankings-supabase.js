// Supabase-flavored books rankings — drop-in for lib/books-rankings.js.
// Uses books.trending_score / views_last_7d / likes_last_7d (existing
// columns) plus the new book_ranking_history table from
// migration_books_engagement.sql.

import supabase from "./supabase";

const BOOK_SELECT = `
  id, title, description, cover_url, genre, tags, status, is_public,
  views_count, likes_count, chapters_count, ratings_count, ratings_avg,
  trending_score, views_last_7d, likes_last_7d, is_editors_pick,
  legacy_appwrite_id, created_at, updated_at, published_at, author_id,
  profiles!books_author_id_fkey ( id, username, avatar_url, legacy_appwrite_id )
`;

export const BooksRankingService = {
  // Top trending books in the last 7 days.
  async fetchTrending({ limit = 50 } = {}) {
    const { data, error } = await supabase
      .from("books")
      .select(BOOK_SELECT)
      .eq("is_public", true)
      .neq("status", "Draft")
      .order("trending_score", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  // Top by total views (all-time).
  async fetchMostViewed({ limit = 50 } = {}) {
    const { data, error } = await supabase
      .from("books")
      .select(BOOK_SELECT)
      .eq("is_public", true)
      .neq("status", "Draft")
      .order("views_count", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  // Top by likes (all-time).
  async fetchMostLiked({ limit = 50 } = {}) {
    const { data, error } = await supabase
      .from("books")
      .select(BOOK_SELECT)
      .eq("is_public", true)
      .neq("status", "Draft")
      .order("likes_count", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  // Editor's picks — manually curated by mods.
  async fetchEditorsPicks({ limit = 50 } = {}) {
    const { data, error } = await supabase
      .from("books")
      .select(BOOK_SELECT)
      .eq("is_editors_pick", true)
      .eq("is_public", true)
      .order("editors_pick_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  // Highest-rated books (must have at least 3 ratings to qualify, so a
  // book with one 5-star doesn't beat a book with 50 4-stars).
  async fetchTopRated({ limit = 50, minRatings = 3 } = {}) {
    const { data, error } = await supabase
      .from("books")
      .select(BOOK_SELECT)
      .eq("is_public", true)
      .neq("status", "Draft")
      .gte("ratings_count", minRatings)
      .order("ratings_avg", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },

  // Historical leaderboard — given an ISO week (YYYY-MM-DD = Monday of
  // that week), return the top N books that were trending then.
  async fetchHistoricalRanking({ recordedFor, limit = 50 }) {
    if (!recordedFor) return [];
    const { data, error } = await supabase
      .from("book_ranking_history")
      .select(`
        rank, trending_score, views_count, likes_count, recorded_for,
        books ( ${BOOK_SELECT} )
      `)
      .eq("recorded_for", recordedFor)
      .order("rank", { ascending: true })
      .limit(limit);
    if (error) throw error;
    return (data || [])
      .filter((row) => row.books)
      .map((row) => ({
        ...row.books,
        rank: row.rank,
        snapshotTrendingScore: row.trending_score,
        snapshotViews: row.views_count,
        snapshotLikes: row.likes_count,
      }));
  },

  // Snapshot today's top trending into book_ranking_history. Called
  // weekly by a cron job (server-side; this method is here for ops).
  async snapshotTrending({ topN = 100, recordedFor = null } = {}) {
    const top = await this.fetchTrending({ limit: topN });
    const today = recordedFor || new Date().toISOString().slice(0, 10);
    const rows = top.map((book, i) => ({
      book_id: book.id,
      rank: i + 1,
      trending_score: Number(book.trending_score) || 0,
      views_count: book.views_count ?? 0,
      likes_count: book.likes_count ?? 0,
      recorded_for: today,
    }));
    if (rows.length === 0) return { snapshotted: 0 };
    const { error } = await supabase
      .from("book_ranking_history")
      .upsert(rows, { onConflict: "book_id,recorded_for" });
    if (error) throw error;
    return { snapshotted: rows.length };
  },
};
