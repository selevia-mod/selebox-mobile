import NetInfo from "@react-native-community/netinfo";
import { ID, Query } from "react-native-appwrite";
import { storage } from "../store/storage";
import { appwriteConfig, databases } from "./appwrite";

const OFFLINE_READS_KEY = "book-reads-offline-v1";

const safeParse = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn("book-reads: parse error", error);
    return null;
  }
};

const getOfflineReadsState = () =>
  safeParse(storage.getString(OFFLINE_READS_KEY)) || {
    version: 1,
    entries: {},
  };

const setOfflineReadsState = (state) => {
  storage.set(OFFLINE_READS_KEY, JSON.stringify(state));
};

const isNetworkError = (err) => {
  const message = (err?.message || "").toLowerCase();
  return (
    err?.code === "NETWORK_ERROR" || message.includes("failed to fetch") || message.includes("network request failed") || message.includes("network")
  );
};

const isOnline = async () => {
  try {
    const state = await NetInfo.fetch();
    return Boolean(state.isConnected && state.isInternetReachable !== false);
  } catch (error) {
    return false;
  }
};

const recordOfflineRead = ({ userId, bookId, chapterId, readAt = Date.now() }) => {
  if (!userId || !bookId || !chapterId) return;

  const state = getOfflineReadsState();
  const entries = state.entries || {};
  const userEntries = entries[userId] || {};
  const bookEntry = userEntries[bookId] || { chapters: {}, lastChapterId: chapterId, lastReadAt: readAt };
  const chapters = bookEntry.chapters || {};

  const chapterEntry = chapters[chapterId] || { count: 0, lastReadAt: 0 };
  chapterEntry.count = (chapterEntry.count || 0) + 1;
  chapterEntry.lastReadAt = Math.max(chapterEntry.lastReadAt || 0, readAt);
  chapters[chapterId] = chapterEntry;

  bookEntry.chapters = chapters;
  if (!bookEntry.lastReadAt || readAt >= bookEntry.lastReadAt) {
    bookEntry.lastReadAt = readAt;
    bookEntry.lastChapterId = chapterId;
  }

  userEntries[bookId] = bookEntry;
  entries[userId] = userEntries;
  state.entries = entries;
  setOfflineReadsState(state);
};

const removeOfflineChapter = ({ userId, bookId, chapterId }) => {
  const state = getOfflineReadsState();
  const entries = state.entries || {};
  const userEntries = entries[userId];
  if (!userEntries) return;

  const bookEntry = userEntries[bookId];
  if (!bookEntry?.chapters || !bookEntry.chapters[chapterId]) return;

  const { [chapterId]: _removed, ...rest } = bookEntry.chapters;
  bookEntry.chapters = rest;
  userEntries[bookId] = bookEntry;

  if (Object.keys(bookEntry.chapters).length === 0 && !bookEntry.lastChapterId) {
    delete userEntries[bookId];
  }

  if (Object.keys(userEntries).length === 0) {
    delete entries[userId];
  }

  state.entries = entries;
  setOfflineReadsState(state);
};

const markOfflineProgressSynced = ({ userId, bookId }) => {
  const state = getOfflineReadsState();
  const entries = state.entries || {};
  const userEntries = entries[userId];
  if (!userEntries) return;

  const bookEntry = userEntries[bookId];
  if (!bookEntry) return;

  delete bookEntry.lastChapterId;
  delete bookEntry.lastReadAt;

  if (!bookEntry.chapters || Object.keys(bookEntry.chapters).length === 0) {
    delete userEntries[bookId];
  } else {
    userEntries[bookId] = bookEntry;
  }

  if (Object.keys(userEntries).length === 0) {
    delete entries[userId];
  }

  state.entries = entries;
  setOfflineReadsState(state);
};

const countOfflineReadsForUser = (userId) => {
  const state = getOfflineReadsState();
  const userEntries = state.entries?.[userId];
  if (!userEntries) return 0;

  let total = 0;
  Object.values(userEntries).forEach((bookEntry) => {
    const chapters = bookEntry?.chapters || {};
    Object.values(chapters).forEach((chapterEntry) => {
      total += Number(chapterEntry?.count || 0);
    });
  });

  return total;
};

let syncInProgress = false;

/**
 * BookReadService
 * --------------------------
 * Handles tracking of user reading activity in the app.
 * This includes:
 *  - Logging chapter reads per user
 *  - Tracking overall progress (last read chapter)
 *  - Optionally triggering backend functions for total book read counts
 */
export const BookReadService = {
  /**
   * readBookChapter
   * ------------------------------------
   * Called when a user opens or reads a chapter.
   * - Creates or updates a "read" record for the user & chapter.
   * - Updates the user’s last read chapter in `usersBookProgress`.
   *
   * @param {Object} params
   * @param {string} params.userId - Appwrite user ID
   * @param {string} params.bookId - Book document ID
   * @param {string} params.chapterId - Chapter document ID
   *
   * @example
   * await BookReadService.readBookChapter({ userId, bookId, chapterId });
   */
  readBookChapter: async ({ userId, bookId, chapterId }) => {
    try {
      // 🧠 Safety Check — Ensure all required IDs exist before running any queries.
      if (!userId || !bookId || !chapterId) {
        console.warn("❌ readBookChapter missing required IDs:", {
          userId,
          bookId,
          chapterId,
        });
        return;
      }

      const online = await isOnline();
      if (!online) {
        recordOfflineRead({ userId, bookId, chapterId });
        return;
      }

      /**
       * STEP 1️⃣ — Check if the user already has a record for this chapter.
       * Prevents creating duplicate read entries for the same chapter/user.
       */
      const existing = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksChaptersReadsCollectionId, [
        Query.equal("user", userId),
        Query.equal("chapter", chapterId),
      ]);

      /**
       * STEP 2️⃣ — Create or update the read record.
       * If first time reading → create new record
       * Otherwise → increment the existing read count.
       */
      if (existing.total === 0) {
        await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.booksChaptersReadsCollectionId, ID.unique(), {
          user: userId,
          book: bookId,
          chapter: chapterId,
          readCount: 1,
        });
      } else {
        const doc = existing.documents[0];

        await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.booksChaptersReadsCollectionId, doc.$id, {
          readCount: (doc.readCount || 0) + 1,
        });
      }

      /**
       * STEP 3️⃣ — Update user’s book progress.
       * Ensures the app can resume reading at the last opened chapter.
       */
      const progress = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.usersBookProgressCollectionId, [
        Query.equal("user", userId),
        Query.equal("book", bookId),
      ]);

      if (progress.total === 0) {
        // No existing progress record → create one
        await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.usersBookProgressCollectionId, ID.unique(), {
          user: userId,
          book: bookId,
          lastChapter: chapterId,
        });
      } else {
        // Update lastChapter so the app can resume from this chapter
        await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.usersBookProgressCollectionId, progress.documents[0].$id, {
          lastChapter: chapterId,
        });
      }

      /**
       * ✅ Success:
       * Both per-chapter read tracking and progress update completed.
       * This ensures analytics and the "Continue Reading" feature stay accurate.
       */
    } catch (err) {
      if (isNetworkError(err)) {
        recordOfflineRead({ userId, bookId, chapterId });
        return;
      }
      console.error("readBookChapter error:", err?.message || err);
    }
  },

  /**
   * syncOfflineReads
   * ------------------------------------
   * Syncs any offline chapter reads back to Appwrite when connectivity returns.
   * This updates both the chapter read counts and user book progress.
   */
  syncOfflineReads: async ({ userId }) => {
    if (!userId) return { synced: 0, remaining: 0 };
    if (syncInProgress) return { synced: 0, remaining: countOfflineReadsForUser(userId) };

    const online = await isOnline();
    if (!online) return { synced: 0, remaining: countOfflineReadsForUser(userId) };

    syncInProgress = true;
    let synced = 0;

    try {
      const state = getOfflineReadsState();
      const userEntries = state.entries?.[userId];
      if (!userEntries || Object.keys(userEntries).length === 0) {
        return { synced: 0, remaining: 0 };
      }

      for (const [bookId, bookEntry] of Object.entries(userEntries)) {
        const chapters = bookEntry?.chapters || {};

        for (const [chapterId, chapterEntry] of Object.entries(chapters)) {
          const count = Number(chapterEntry?.count || 0);
          if (!count) {
            removeOfflineChapter({ userId, bookId, chapterId });
            continue;
          }

          try {
            const existing = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksChaptersReadsCollectionId, [
              Query.equal("user", userId),
              Query.equal("chapter", chapterId),
            ]);

            if (existing.total === 0) {
              await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.booksChaptersReadsCollectionId, ID.unique(), {
                user: userId,
                book: bookId,
                chapter: chapterId,
                readCount: count,
              });
            } else {
              const doc = existing.documents[0];
              await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.booksChaptersReadsCollectionId, doc.$id, {
                readCount: (doc.readCount || 0) + count,
              });
            }

            synced += count;
            removeOfflineChapter({ userId, bookId, chapterId });
          } catch (err) {
            console.warn("syncOfflineReads chapter error:", err?.message || err);
            if (isNetworkError(err)) {
              return { synced, remaining: countOfflineReadsForUser(userId) };
            }
          }
        }

        if (bookEntry?.lastChapterId) {
          try {
            const progress = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.usersBookProgressCollectionId, [
              Query.equal("user", userId),
              Query.equal("book", bookId),
            ]);

            if (progress.total === 0) {
              await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.usersBookProgressCollectionId, ID.unique(), {
                user: userId,
                book: bookId,
                lastChapter: bookEntry.lastChapterId,
              });
            } else {
              await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.usersBookProgressCollectionId, progress.documents[0].$id, {
                lastChapter: bookEntry.lastChapterId,
              });
            }

            markOfflineProgressSynced({ userId, bookId });
          } catch (err) {
            console.warn("syncOfflineReads progress error:", err?.message || err);
            if (isNetworkError(err)) {
              return { synced, remaining: countOfflineReadsForUser(userId) };
            }
          }
        }
      }

      return { synced, remaining: countOfflineReadsForUser(userId) };
    } finally {
      syncInProgress = false;
    }
  },

  /**
   * fetchBookRead
   * ------------------------------------
   * Retrieves the total read information for a specific book.
   * Useful for displaying total read counts, analytics, or ranking features.
   *
   * @param {Object} params
   * @param {string} params.bookId - The Appwrite document ID of the book
   *
   * @returns {Promise<Object|null>} The matching bookRead document, or null if not found
   *
   * @example
   * const bookRead = await BookReadService.fetchBookRead({ bookId });
   * console.log(bookRead?.totalReads || 0);
   */
  fetchBookRead: async ({ bookId }) => {
    try {
      // 🧠 Safety Check — Ensure bookId is valid before running queries
      if (!bookId) {
        console.warn("❌ fetchBookRead missing required ID:", { bookId });
        return null;
      }

      /**
       * STEP 1️⃣ — Query the `bookReads` collection
       * Filters by the `book` relationship field to find the read stats
       * for the specified book.
       */
      const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksReadsCollectionId, [
        Query.equal("book", [bookId]),
      ]);

      /**
       * STEP 2️⃣ — Handle empty results safely
       * If the book has never been read (no record yet), return null
       * instead of an empty object to simplify client handling.
       */
      if (response.total === 0) {
        console.log(`ℹ️ No read record found for book: ${bookId}`);
        return null;
      }

      /**
       * ✅ STEP 3️⃣ — Return the first (and usually only) document
       * In most setups, each book will only have one read summary document.
       */
      const bookReadDoc = response.documents[0];
      return bookReadDoc;
    } catch (err) {
      console.error("fetchBookRead error:", err?.message || err);
      return null;
    }
  },

  /**
   * fetchChapterRead
   * ------------------------------------
   * Retrieves the total number of read entries for a specific chapter.
   * Each document in `booksChaptersReadsCollection` represents one read event
   * (e.g., a user reading a chapter), so we use the total document count as the read total.
   *
   * @param {Object} params
   * @param {string} params.chapterId - The Appwrite document ID of the chapter
   *
   * @returns {Promise<number|null>} Total number of reads for this chapter, or null if an error occurs
   *
   * @example
   * const chapterReads = await BookReadService.fetchChapterRead({ chapterId });
   * console.log(`Chapter ${chapterId} has been read ${chapterReads} times.`);
   */
  fetchChapterRead: async ({ chapterId }) => {
    try {
      // 🧠 STEP 1️⃣ — Validate parameter before making query
      if (!chapterId) {
        console.warn("❌ fetchChapterRead missing required ID:", { chapterId });
        return null;
      }

      /**
       * STEP 2️⃣ — Query the `booksChaptersReadsCollection`
       * Filter by the `chapter` relationship field to find all read records
       * associated with the given chapter.
       */
      const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksChaptersReadsCollectionId, [
        Query.equal("chapter", [chapterId]),
      ]);

      /**
       * STEP 3️⃣ — Return the number of matching read records.
       * Each record represents one read instance or user read tracking document.
       */
      return response.total;
    } catch (err) {
      console.error("fetchChapterRead error:", err?.message || err);
      return null;
    }
  },
};
