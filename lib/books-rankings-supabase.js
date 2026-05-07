// Supabase-flavored books rankings — drop-in for lib/books-rankings.js.
//
// Mirrors the API surface of lib/books-rankings-appwrite.js
// (BooksRankingService class with static methods). Consumers — the
// BooksRanking screen, BooksDiscover, the books tab pre-warm — call
// the same method names against either backend; the dispatcher in
// books-rankings.js routes by USE_SUPABASE_BOOKS.
//
// Why a class with static methods instead of a plain object?
//   • The Appwrite version is a class so consumers reference
//     `BooksRankingService.MAX_RESULTS` (static prop) and
//     `BooksRankingService.fetchRankingsPool()` (static method). If
//     this file exported an object, prop access would still work but
//     `static` semantics + ergonomic `this.X` calls inside methods
//     would not. Keeping the same shape is the cheapest way to make
//     the dispatcher swap transparent at every call site.
//
// Ranking-pool semantics:
//   The Appwrite version paginates booksReadsCollection (per-book
//   aggregates) ordered by monthlyReads desc. Supabase doesn't have a
//   per-book aggregate table — but books rows themselves carry the
//   denormalized counts (views_count, likes_count, ratings_avg,
//   trending_score) maintained by triggers from the engagement
//   migration. So the pool is just the top-N books by trending_score,
//   wrapped in the ranking-shaped envelope consumers expect:
//     { $id, book, totalReads, monthlyReads, averageRating,
//       totalLikes, chaptersTotal }

import supabase from "./supabase";
import { createTtlCache } from "./utils/createTtlCache";

const BOOK_SELECT = `
  id, title, description, cover_url, genre, tags, status, is_public,
  views_count, likes_count, chapters_count, ratings_count, ratings_avg,
  trending_score, views_last_7d, likes_last_7d, is_editors_pick,
  legacy_appwrite_id, created_at, updated_at, published_at, author_id,
  profiles!books_author_id_fkey ( id, username, avatar_url, legacy_appwrite_id )
`;

// Module-level cache for the full rankings pool. Same TTL as the
// Appwrite version (12h) so user behavior on the BooksRanking screen
// stays consistent across the flag flip.
const RANKINGS_POOL_CACHE = createTtlCache({ ttlMs: 12 * 60 * 60 * 1000, maxEntries: 1 });
const RANKINGS_POOL_KEY = "all";

// Tracks an in-flight pool fetch so a burst of concurrent callers
// (e.g. the rankings screen mounting while Discover is also asking)
// shares one round-trip instead of triggering N parallel queries.
let rankingsPoolInflight = null;

// Map a Supabase books row + author profile join into the
// Appwrite-shaped book document the consumers expect.
const mapBookRow = (row) => {
  if (!row) return null;
  const author = row.profiles || row.author || {};
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    cover_url: row.cover_url,
    genre: row.genre,
    tags: row.tags || [],
    status: row.status,
    is_public: row.is_public,
    views_count: row.views_count ?? 0,
    likes_count: row.likes_count ?? 0,
    chapters_count: row.chapters_count ?? 0,
    ratings_count: row.ratings_count ?? 0,
    ratings_avg: row.ratings_avg ?? 0,
    trending_score: row.trending_score ?? 0,
    is_editors_pick: row.is_editors_pick ?? false,
    legacy_appwrite_id: row.legacy_appwrite_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
    // Appwrite-shaped legacy aliases.
    $id: row.legacy_appwrite_id || row.id,
    $createdAt: row.created_at,
    $updatedAt: row.updated_at,
    synopsis: row.description,
    thumbnail: row.cover_url,
    uploader: {
      $id: author.legacy_appwrite_id || author.id,
      id: author.id,
      username: author.username,
      avatar: author.avatar_url,
      avatar_url: author.avatar_url,
    },
  };
};

// Wrap a book row in the ranking-entry shape consumers iterate. Uses
// denormalized count columns so no extra round-trips for stats —
// hydrateDiscoverStats was the Appwrite workaround for the missing
// counts; Supabase carries them on the row directly.
const wrapAsRanking = (book) => ({
  $id: book?.$id || book?.id || null,
  book,
  totalReads: Number(book?.views_count ?? 0) || 0,
  monthlyReads: Number(book?.views_last_7d ?? book?.views_count ?? 0) || 0,
  averageRating: Number(book?.ratings_avg ?? 0) || 0,
  totalLikes: Number(book?.likes_count ?? 0) || 0,
  chaptersTotal: Number(book?.chapters_count ?? 0) || 0,
});

export class BooksRankingService {
  // Hard cap on the rankings pool size. Matches the Appwrite version
  // so the BooksRanking screen's pagination math (MAX_RESULTS - offset)
  // produces identical "load more" stop points across backends.
  static MAX_RESULTS = 300;
  static STATS_BATCH_SIZE = 100;

  // Per-book-id cached stats overlay. Keeps the latest known
  // totalLikes / chaptersTotal across renders so a stale pool entry
  // doesn't flicker the count back to zero.
  //
  // TTL added May 2026 — was a forever Map; on long sessions the
  // cache grew unbounded as the user scrolled different ranking
  // pools. 30min TTL is generous (covers a typical books-tab
  // browsing session in one sitting) and the 500-entry LRU cap
  // bounds memory.
  static statsCache = createTtlCache({ ttlMs: 30 * 60 * 1000, maxEntries: 500 });

  // ── Helpers ─────────────────────────────────────────────────────────────

  static normalizeTags(tags = []) {
    return (Array.isArray(tags) ? tags : []).map((tag) => String(tag).toLowerCase());
  }

  static cacheRankingStats(items = []) {
    items.forEach((item) => {
      const bookId = item?.book?.$id || item?.book?.id;
      if (!bookId) return;
      const hasTotalLikes = item?.totalLikes !== undefined && item?.totalLikes !== null;
      const hasChaptersTotal = item?.chaptersTotal !== undefined && item?.chaptersTotal !== null;
      if (!hasTotalLikes && !hasChaptersTotal) return;
      const previous = this.statsCache.get(bookId) || {};
      this.statsCache.set(bookId, {
        totalLikes: hasTotalLikes ? item.totalLikes : previous.totalLikes,
        chaptersTotal: hasChaptersTotal ? item.chaptersTotal : previous.chaptersTotal,
      });
    });
  }

  static applyCachedStats(items = []) {
    this.cacheRankingStats(items);
    return items.map((item) => {
      const bookId = item?.book?.$id || item?.book?.id;
      if (!bookId) return item;
      const cached = this.statsCache.get(bookId);
      if (!cached) return item;
      const nextTotalLikes = item?.totalLikes ?? cached.totalLikes;
      const nextChaptersTotal = item?.chaptersTotal ?? cached.chaptersTotal;
      if (nextTotalLikes === item?.totalLikes && nextChaptersTotal === item?.chaptersTotal) {
        return item;
      }
      return {
        ...item,
        ...(nextTotalLikes !== undefined ? { totalLikes: nextTotalLikes } : {}),
        ...(nextChaptersTotal !== undefined ? { chaptersTotal: nextChaptersTotal } : {}),
      };
    });
  }

  // Supabase carries denormalized counts on each book row, so this is
  // a cheap re-pluck rather than the multi-batch grouped query the
  // Appwrite version does. Kept as a method for API parity in case any
  // caller still invokes it directly.
  static async fetchGroupedCounts({ ids = [], field = "likes_count" } = {}) {
    const normalized = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
    const counts = Object.fromEntries(normalized.map((id) => [id, 0]));
    if (!normalized.length) return counts;
    const { data } = await supabase
      .from("books")
      .select(`id, legacy_appwrite_id, ${field}`)
      .or(`id.in.(${normalized.join(",")}),legacy_appwrite_id.in.(${normalized.join(",")})`);
    for (const row of data || []) {
      const key = counts[row.id] !== undefined ? row.id : row.legacy_appwrite_id;
      if (key && counts[key] !== undefined) counts[key] = Number(row[field]) || 0;
    }
    return counts;
  }

  static async enrichRankingsWithStats(items = []) {
    // No-op on Supabase — counts are already on the book row from the
    // initial pool fetch. Kept as a method for API parity. The Appwrite
    // version does grouped-count fanouts here; we don't need to.
    return this.applyCachedStats(items);
  }

  // ── Pool fetch (the core method consumers wait on) ──────────────────────

  /**
   * Fetches the full pool of ranking entries (up to MAX_RESULTS) from
   * the books table ordered by trending_score. Result is cached in
   * RANKINGS_POOL_CACHE for 12h, and concurrent callers share an
   * in-flight Promise so we never paginate the same pool twice.
   *
   * Returns ranking-shaped entries: { $id, book, totalReads,
   * monthlyReads, averageRating, totalLikes, chaptersTotal }.
   */
  static async fetchRankingsPool({ forceRefresh = false } = {}) {
    if (!forceRefresh) {
      const cached = RANKINGS_POOL_CACHE.get(RANKINGS_POOL_KEY);
      if (cached) return cached;
    }
    if (rankingsPoolInflight) return rankingsPoolInflight;

    rankingsPoolInflight = (async () => {
      try {
        // Sort by views_count first (most-read at the top — "Ranking #1
        // is the highest reads"), with trending_score as tiebreaker for
        // brand-new books that share the same low view count. The
        // previous trending_score-only sort produced confusing results
        // where #1 had 122 views but #2 had 0 because trending_score is
        // a recency-weighted formula rather than raw popularity. Authors
        // and readers expect "Ranking" to literally mean "ordered by
        // most-read", which matches what other reading apps (Wattpad,
        // Webnovel) do under that label.
        const { data, error } = await supabase
          .from("books")
          .select(BOOK_SELECT)
          .eq("is_public", true)
          .in("status", ["ongoing", "completed"])
          .order("views_count", { ascending: false, nullsFirst: false })
          .order("trending_score", { ascending: false, nullsFirst: false })
          .limit(this.MAX_RESULTS);
        if (error) throw error;
        const entries = (data || []).map(mapBookRow).filter(Boolean).map(wrapAsRanking);
        RANKINGS_POOL_CACHE.set(RANKINGS_POOL_KEY, entries);
        return entries;
      } finally {
        rankingsPoolInflight = null;
      }
    })();

    return rankingsPoolInflight;
  }

  /**
   * Returns ranking entries for the given tag set, paged. Thin wrapper
   * over fetchRankingsPool + client-side filter + slice — every call
   * after the first is in-memory only, so tag switches are instant.
   */
  static async getCurrentRankingsByTags({ tags = [], limit = 20, offset = 0, forceRefresh = false } = {}) {
    try {
      const pool = await this.fetchRankingsPool({ forceRefresh });
      const normalizedTags = this.normalizeTags(tags);
      const start = Math.max(0, offset || 0);
      const pageSize = Math.max(1, limit || 20);

      const filtered = pool.filter((doc) => {
        const book = doc?.book;
        if (!book?.tags) return normalizedTags.length === 0;
        if (normalizedTags.length === 0) return true;
        const bookTags = (book.tags || []).map((t) => String(t).toLowerCase());
        return normalizedTags.some((tag) => bookTags.includes(tag));
      });

      const end = start + pageSize;
      const paged = this.applyCachedStats(filtered.slice(start, end));
      const hasMore = filtered.length > end;
      return { items: paged, hasMore };
    } catch (error) {
      console.error("[books-rankings-supabase] getCurrentRankingsByTags:", error?.message || error);
      throw error;
    }
  }

  static async preloadCurrentRankings({ tags = [], total = 100, batchSize = 20 } = {}) {
    const allResults = [];
    for (let offset = 0; offset < total; offset += batchSize) {
      const { items } = await this.getCurrentRankingsByTags({ tags, limit: batchSize, offset });
      if (items.length === 0) break;
      allResults.push(...items);
      if (items.length < batchSize) break;
    }
    return allResults.slice(0, total);
  }

  // ── Past rankings — read snapshots from book_ranking_history ────────────
  static async getPastRankings({ tags = [], monthKey, limit = 100 } = {}) {
    if (!monthKey) return [];
    try {
      let q = supabase
        .from("book_ranking_history")
        .select(`
          rank, trending_score, views_count, likes_count, recorded_for,
          books ( ${BOOK_SELECT} )
        `)
        .eq("recorded_for", monthKey)
        .order("rank", { ascending: true })
        .limit(limit);
      // Note: tag filtering against book_ranking_history requires a
      // `tag` column on snapshots which we don't have yet. For now we
      // return the unfiltered top-N for the month; tag-filtered past
      // rankings can be a follow-up if/when product asks.
      const { data, error } = await q;
      if (error) throw error;
      return (data || [])
        .filter((row) => row.books)
        .map((row) => wrapAsRanking(mapBookRow(row.books)));
    } catch (error) {
      console.error("[books-rankings-supabase] getPastRankings:", error?.message || error);
      throw error;
    }
  }

  // ── Convenience leaderboards (kept from the previous object form) ───────

  static async fetchTrending({ limit = 50 } = {}) {
    const { data, error } = await supabase
      .from("books")
      .select(BOOK_SELECT)
      .eq("is_public", true)
      .in("status", ["ongoing", "completed"])
      .order("trending_score", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map(mapBookRow).filter(Boolean);
  }

  static async fetchMostViewed({ limit = 50 } = {}) {
    const { data, error } = await supabase
      .from("books")
      .select(BOOK_SELECT)
      .eq("is_public", true)
      .in("status", ["ongoing", "completed"])
      .order("views_count", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map(mapBookRow).filter(Boolean);
  }

  static async fetchMostLiked({ limit = 50 } = {}) {
    const { data, error } = await supabase
      .from("books")
      .select(BOOK_SELECT)
      .eq("is_public", true)
      .in("status", ["ongoing", "completed"])
      .order("likes_count", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map(mapBookRow).filter(Boolean);
  }

  static async fetchEditorsPicks({ limit = 50 } = {}) {
    const { data, error } = await supabase
      .from("books")
      .select(BOOK_SELECT)
      .eq("is_editors_pick", true)
      .eq("is_public", true)
      .order("editors_pick_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map(mapBookRow).filter(Boolean);
  }

  static async fetchTopRated({ limit = 50, minRatings = 3 } = {}) {
    const { data, error } = await supabase
      .from("books")
      .select(BOOK_SELECT)
      .eq("is_public", true)
      .in("status", ["ongoing", "completed"])
      .gte("ratings_count", minRatings)
      .order("ratings_avg", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map(mapBookRow).filter(Boolean);
  }

  static async fetchHistoricalRanking({ recordedFor, limit = 50 } = {}) {
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
        ...mapBookRow(row.books),
        rank: row.rank,
        snapshotTrendingScore: row.trending_score,
        snapshotViews: row.views_count,
        snapshotLikes: row.likes_count,
      }));
  }

  static async snapshotTrending({ topN = 100, recordedFor = null } = {}) {
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
  }
}
