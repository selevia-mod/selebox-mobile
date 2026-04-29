import { Query } from "react-native-appwrite";
import secrets from "../private/secrets";
import { databases } from "./appwrite";

export class BooksRankingService {
  static MAX_RESULTS = 100;
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

  static async getCurrentRankingsByTags({ tags = [], limit = 20, offset = 0 }) {
    try {
      const BATCH_SIZE = 100;
      const allFiltered = [];
      let currentOffset = 0;
      const normalizedTags = this.normalizeTags(tags);
      const start = Math.max(0, offset || 0);
      const pageSize = Math.max(1, limit || 20);
      const targetMatches = Math.min(this.MAX_RESULTS, start + pageSize + 1);

      while (allFiltered.length < targetMatches) {
        const queries = [Query.limit(BATCH_SIZE), Query.offset(currentOffset), Query.orderDesc("monthlyReads")];

        const response = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.booksReadsCollectionId, queries, [
          "book",
        ]);

        if (!response.documents || response.documents.length === 0) break;

        const filtered = response.documents.filter((doc) => {
          const book = doc.book;
          if (!book?.tags) return false;
          if (normalizedTags.length === 0) return true;
          const bookTags = (book.tags || []).map((t) => String(t).toLowerCase());
          return normalizedTags.some((tag) => bookTags.includes(tag));
        });

        allFiltered.push(...filtered);
        if (allFiltered.length >= targetMatches) break;
        if (response.documents.length < BATCH_SIZE) break;

        currentOffset += BATCH_SIZE;
      }

      const end = start + pageSize;
      const paged = this.applyCachedStats(allFiltered.slice(start, end));
      const hasMore = allFiltered.length > end;

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
