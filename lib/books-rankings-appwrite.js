import { Query } from "react-native-appwrite";
import secrets from "../private/secrets";
import { databases } from "./appwrite";
import { createTtlCache } from "./utils/createTtlCache";

// Module-level cache for the full rankings pool (all tags). Previously each tag
// switch on the BooksRanking screen triggered its own paginated fetch with
// client-side tag filtering — for rare tags this meant 10+ round-trips per tap
// (Appwrite returns 100 ranking entries per page, then we filter to find
// matching books). Caching the entire pool once and filtering in memory turns
// every tag tap after the first into an instant render.
//
// 12-hour TTL matches the per-tag redux cache lifetime in BooksRanking.jsx so
// users don't see the screen go stale while the in-flight pool stays fresh.
const RANKINGS_POOL_CACHE = createTtlCache({ ttlMs: 12 * 60 * 60 * 1000, maxEntries: 1 });
const RANKINGS_POOL_KEY = "all";

// Tracks an in-flight pool fetch so a burst of concurrent callers (e.g. the
// rankings screen mounting while Discover is also asking) share one round-trip
// instead of triggering N parallel paginations.
let rankingsPoolInflight = null;

export class BooksRankingService {
  // Hard cap on a single getCurrentRankingsByTags call. Raised from 100 to 300 so
  // the Discover tab's candidate pool can support all six sub-tabs (Popular,
  // Trending, New & Rising, Reader's Choice, Hidden Gem, Daily Picks) with strict
  // no-overlap. At 6 tabs × 15 visible cards = 90 unique books minimum, with
  // headroom for diversity caps and the engagement filter.
  static MAX_RESULTS = 300;
  static STATS_BATCH_SIZE = 100;
  static statsCache = new Map();

  static normalizeTags(tags = []) {
    return (Array.isArray(tags) ? tags : []).map((tag) => String(tag).toLowerCase());
  }

  static cacheRankingStats(items = []) {
    items.forEach((item) => {
      const bookId = item?.book?.$id;
      if (!bookId) return;

      const hasTotalLikes = item?.totalLikes !== undefined && item?.totalLikes !== null;
      const hasChaptersTotal = item?.chaptersTotal !== undefined && item?.chaptersTotal !== null;

      if (!hasTotalLikes && !hasChaptersTotal) return;

      const previousStats = this.statsCache.get(bookId) || {};
      this.statsCache.set(bookId, {
        totalLikes: hasTotalLikes ? item.totalLikes : previousStats.totalLikes,
        chaptersTotal: hasChaptersTotal ? item.chaptersTotal : previousStats.chaptersTotal,
      });
    });
  }

  static applyCachedStats(items = []) {
    this.cacheRankingStats(items);

    return items.map((item) => {
      const bookId = item?.book?.$id;
      if (!bookId) return item;

      const cachedStats = this.statsCache.get(bookId);
      if (!cachedStats) return item;

      const nextTotalLikes = item?.totalLikes ?? cachedStats.totalLikes;
      const nextChaptersTotal = item?.chaptersTotal ?? cachedStats.chaptersTotal;

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

  static async fetchGroupedCounts({ collectionId, field, ids = [], extraQueries = [] }) {
    const normalizedIds = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
    const counts = Object.fromEntries(normalizedIds.map((id) => [id, 0]));

    if (!normalizedIds.length) return counts;

    let currentOffset = 0;

    while (true) {
      const queries = [...extraQueries, Query.equal(field, normalizedIds), Query.limit(this.STATS_BATCH_SIZE), Query.offset(currentOffset)];

      const response = await databases.listDocuments(secrets.appwriteConfig.databaseId, collectionId, queries);
      const documents = response?.documents || [];

      documents.forEach((doc) => {
        const relation = doc?.[field];
        const relatedId = typeof relation === "string" ? relation : relation?.$id;
        if (relatedId && Object.prototype.hasOwnProperty.call(counts, relatedId)) {
          counts[relatedId] += 1;
        }
      });

      if (documents.length < this.STATS_BATCH_SIZE) break;
      currentOffset += this.STATS_BATCH_SIZE;
    }

    return counts;
  }

  static async enrichRankingsWithStats(items = []) {
    const safeItems = Array.isArray(items) ? items : [];
    const bookIds = [...new Set(safeItems.map((item) => item?.book?.$id).filter(Boolean))];
    const uncachedBookIds = bookIds.filter((bookId) => !this.statsCache.has(bookId));

    if (uncachedBookIds.length > 0) {
      const [likesResult, chaptersResult] = await Promise.allSettled([
        this.fetchGroupedCounts({
          collectionId: secrets.appwriteConfig.booksLikeCollectionId,
          field: "book",
          ids: uncachedBookIds,
        }),
        this.fetchGroupedCounts({
          collectionId: secrets.appwriteConfig.booksChaptersCollectionId,
          field: "book",
          ids: uncachedBookIds,
          extraQueries: [Query.equal("status", "Publish")],
        }),
      ]);

      const likesCounts = likesResult.status === "fulfilled" ? likesResult.value : {};
      const chaptersCounts = chaptersResult.status === "fulfilled" ? chaptersResult.value : {};

      if (likesResult.status === "rejected") {
        console.warn("Failed to fetch ranking likes counts:", likesResult.reason);
      }

      if (chaptersResult.status === "rejected") {
        console.warn("Failed to fetch ranking chapter counts:", chaptersResult.reason);
      }

      uncachedBookIds.forEach((bookId) => {
        this.statsCache.set(bookId, {
          totalLikes: likesCounts[bookId] ?? 0,
          chaptersTotal: chaptersCounts[bookId] ?? 0,
        });
      });
    }

    return this.applyCachedStats(safeItems);
  }

  /**
   * Fetches the full pool of ranking entries (up to MAX_RESULTS) from
   * booksReadsCollection ordered by monthlyReads desc. Result is cached in
   * RANKINGS_POOL_CACHE for 12 hours, and concurrent callers share an
   * in-flight Promise so we never paginate the same pool twice.
   *
   * Used by getCurrentRankingsByTags to enable instant client-side tag
   * filtering — the previous code paginated the collection and filtered
   * server-side per call, which on rare tags meant 10+ round-trips per tap.
   */
  static async fetchRankingsPool({ forceRefresh = false } = {}) {
    if (!forceRefresh) {
      const cached = RANKINGS_POOL_CACHE.get(RANKINGS_POOL_KEY);
      if (cached) return cached;
    }

    if (rankingsPoolInflight) return rankingsPoolInflight;

    rankingsPoolInflight = (async () => {
      try {
        const BATCH_SIZE = 100;
        const allEntries = [];
        let currentOffset = 0;
        const target = this.MAX_RESULTS;

        while (allEntries.length < target) {
          const queries = [
            Query.limit(Math.min(BATCH_SIZE, target - allEntries.length)),
            Query.offset(currentOffset),
            Query.orderDesc("monthlyReads"),
          ];

          const response = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.booksReadsCollectionId, queries, [
            "book",
          ]);

          const docs = response?.documents || [];
          if (docs.length === 0) break;

          allEntries.push(...docs);
          if (docs.length < BATCH_SIZE) break;
          currentOffset += BATCH_SIZE;
        }

        RANKINGS_POOL_CACHE.set(RANKINGS_POOL_KEY, allEntries);
        return allEntries;
      } finally {
        rankingsPoolInflight = null;
      }
    })();

    return rankingsPoolInflight;
  }

  /**
   * Returns ranking entries for the given tag set, paged. After the refactor
   * this is a thin wrapper over fetchRankingsPool + client-side filter +
   * slice — every call after the first is essentially free (in-memory only),
   * so tag switches feel instant.
   *
   * `forceRefresh` invalidates the pool cache and re-fetches, used by
   * pull-to-refresh on the BooksRanking screen.
   */
  static async getCurrentRankingsByTags({ tags = [], limit = 20, offset = 0, forceRefresh = false }) {
    try {
      const pool = await this.fetchRankingsPool({ forceRefresh });
      const normalizedTags = this.normalizeTags(tags);
      const start = Math.max(0, offset || 0);
      const pageSize = Math.max(1, limit || 20);

      const filtered = pool.filter((doc) => {
        const book = doc?.book;
        if (!book?.tags) return false;
        if (normalizedTags.length === 0) return true;
        const bookTags = (book.tags || []).map((t) => String(t).toLowerCase());
        return normalizedTags.some((tag) => bookTags.includes(tag));
      });

      const end = start + pageSize;
      const paged = this.applyCachedStats(filtered.slice(start, end));
      const hasMore = filtered.length > end;

      return { items: paged, hasMore };
    } catch (error) {
      console.error("Failed to fetch current rankings:", error);
      throw error;
    }
  }

  static async getPastRankings({ tags = [], monthKey, limit = 100 }) {
    try {
      const queries = [Query.equal("monthKey", monthKey), Query.orderAsc("rank"), Query.limit(limit)];
      if (tags.length > 0) queries.push(Query.equal("tag", tags));

      const response = await databases.listDocuments(
        secrets.appwriteConfig.databaseId,
        secrets.appwriteConfig.booksRankingHistoryCollectionId,
        queries,
        ["book"],
      );

      return response.documents;
    } catch (error) {
      console.error("Failed to fetch past rankings:", error);
      throw error;
    }
  }

  static async preloadCurrentRankings({ tags = [], total = 100, batchSize = 20 }) {
    const allResults = [];
    for (let offset = 0; offset < total; offset += batchSize) {
      const { items } = await this.getCurrentRankingsByTags({ tags, limit: batchSize, offset });
      if (items.length === 0) break;
      allResults.push(...items);
      if (items.length < batchSize) break;
    }
    return allResults.slice(0, total);
  }
}
