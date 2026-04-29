import { ID, Query } from "react-native-appwrite";
import { appwriteConfig, databases, storage } from "./appwrite";
import { searchUsers } from "./users";

export const initialBookForm = {
  thumbnail: "",
  title: "",
  synopsis: "",
  uploader: "",
  tags: [],
  status: "Draft",
};

export const initialChapterForm = {
  thumbnail: "",
  title: "",
  content: "",
};

export const INTRODUCTION_ORDER = 0;

export const getBookChapterOrder = (chapter, index = 0) => {
  const parsedOrder = Number(chapter?.order);
  if (Number.isFinite(parsedOrder) && parsedOrder >= 0) return parsedOrder;
  return index + 1;
};

export const sortBookChaptersByOrder = (chapters = []) => [...chapters].sort((a, b) => getBookChapterOrder(a) - getBookChapterOrder(b));

export const isIntroductionChapter = (chapter, index = 0) => getBookChapterOrder(chapter, index) === INTRODUCTION_ORDER;

export const getNextBookChapterOrder = (chapters = []) => {
  if (!Array.isArray(chapters) || chapters.length === 0) return INTRODUCTION_ORDER;
  if (!chapters.some((chapter, index) => isIntroductionChapter(chapter, index))) return INTRODUCTION_ORDER;
  return getNextNumberedBookChapterOrder(chapters);
};

export const getNextNumberedBookChapterOrder = (chapters = []) => {
  const numberedChapters = Array.isArray(chapters)
    ? chapters.map((chapter, index) => getBookChapterOrder(chapter, index)).filter((order) => order > INTRODUCTION_ORDER)
    : [];
  if (!numberedChapters.length) return 1;
  return Math.max(...numberedChapters) + 1;
};

export const getBookChapterSectionLabel = (chapter, index = 0) =>
  isIntroductionChapter(chapter, index) ? "Introduction" : `Part ${getBookChapterOrder(chapter, index)}`;

export const BOOK_CHAPTER_LIST_SELECT = ["$id", "$createdAt", "$updatedAt", "title", "thumbnail", "order", "status"];

export class BookService {
  async uploadBookImage(file, { maxWidth = 800, compress = 0.7 } = {}) {
    if (!file?.uri) return null;
    const { convertToWebP, cleanupTempFile } = require("./image-utils");
    const webp = await convertToWebP(file.uri, { maxWidth, compress });
    try {
      const asset = {
        name: (file.fileName || file.uri.split("/").pop()).replace(/\.\w+$/, ".webp"),
        size: webp.fileSize,
        type: "image/webp",
        uri: webp.uri,
      };
      const uploadedFile = await storage.createFile(appwriteConfig.booksStorageId, ID.unique(), asset);
      const uploadedFileId = uploadedFile?.$id;
      if (!uploadedFileId) return null;
      const filePreview = storage.getFilePreview(appwriteConfig.booksStorageId, uploadedFileId);
      return typeof filePreview === "string" ? filePreview : filePreview?.toString?.() || null;
    } catch (error) {
      throw error;
    } finally {
      cleanupTempFile(webp.uri, file.uri);
    }
  }

  async uploadCover(file) {
    return this.uploadBookImage(file, { maxWidth: 800, compress: 0.7 });
  }

  async uploadChapterInlineImage(file) {
    return this.uploadBookImage(file, { maxWidth: 1400, compress: 0.78 });
  }

  async createNewBook({ title, synopsis, thumbnail, uploader, ...props }) {
    return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.booksCollectionId, ID.unique(), {
      title: title,
      synopsis: synopsis,
      thumbnail: thumbnail,
      uploader: uploader,
      ...props,
    });
  }

  async updateBook({ ID, ...props }) {
    return databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.booksCollectionId, ID, {
      ...props,
    });
  }

  async createNewBookChapter({ title, content, thumbnail, bookId, status, order, ...props }) {
    return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.booksChaptersCollectionId, ID.unique(), {
      title: title,
      content: content,
      thumbnail: thumbnail,
      book: bookId,
      order: order,
      status: status,
    });
  }

  async updateBookChapter({ ID, ...props }) {
    return databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.booksChaptersCollectionId, ID, {
      ...props,
    });
  }

  async deleteBook({ ID }) {
    return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.booksCollectionId, ID);
  }

  async deleteBookChapter({ ID }) {
    return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.booksChaptersCollectionId, ID);
  }

  async fetchBooks({ userId, lastId, category, limit = 20, status }) {
    const queries = [Query.limit(limit), Query.orderDesc("$createdAt")];
    if (lastId) queries.push(Query.cursorAfter(lastId));
    if (userId) queries.push(Query.equal("uploader", userId));
    if (category) queries.push(Query.contains("tags", category));
    if (status) {
      if (Array.isArray(status)) {
        queries.push(Query.or(status.map((s) => Query.equal("status", s))));
      } else {
        queries.push(Query.equal("status", status));
      }
    }

    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksCollectionId, queries);
  }

  async fetchPublishedBooks({ category, lastId, status, limit = 100 }) {
    const queries = [Query.limit(limit), Query.orderDesc("$createdAt"), Query.notEqual("status", "Draft")];
    if (lastId) queries.push(Query.cursorAfter(lastId));
    if (category) queries.push(Query.contains("tags", category));
    if (status) queries.push(Query.equal("status", status));
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksCollectionId, queries);
  }

  async fetchBookChapters({ bookId, lastId, status, limit = 100, select } = {}) {
    const pageLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
    const queries = [Query.limit(pageLimit), Query.orderAsc("order")];
    if (Array.isArray(select) && select.length > 0) queries.push(Query.select(select));
    if (lastId) queries.push(Query.cursorAfter(lastId));
    if (bookId) queries.push(Query.equal("book", bookId));
    if (status) queries.push(Query.equal("status", status));
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksChaptersCollectionId, queries);
  }

  async fetchAllBookChapters({ bookId, status, limit = 100, select } = {}) {
    const pageLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
    const documents = [];
    const seenIds = new Set();
    let lastId;
    let total = 0;

    while (true) {
      const response = await this.fetchBookChapters({ bookId, status, limit: pageLimit, lastId, select });
      const pageDocuments = response?.documents || [];
      const responseTotal = Number(response?.total);
      if (Number.isFinite(responseTotal)) total = Math.max(total, responseTotal);
      if (!pageDocuments.length) break;

      let addedCount = 0;
      pageDocuments.forEach((chapter) => {
        if (!chapter?.$id || seenIds.has(chapter.$id)) return;
        seenIds.add(chapter.$id);
        documents.push(chapter);
        addedCount += 1;
      });

      const nextLastId = pageDocuments[pageDocuments.length - 1]?.$id;
      if (!nextLastId || nextLastId === lastId || addedCount === 0 || pageDocuments.length < pageLimit) break;
      lastId = nextLastId;
    }

    return { documents, total: Math.max(total, documents.length) };
  }

  async fetchBook({ bookId }) {
    return databases.getDocument(appwriteConfig.databaseId, appwriteConfig.booksCollectionId, bookId);
  }

  async fetchBookChapter({ chapterId }) {
    return databases.getDocument(appwriteConfig.databaseId, appwriteConfig.booksChaptersCollectionId, chapterId);
  }

  async fetchBookLibraryByUser({ userId, lastId, limit = 20 }) {
    const queries = [Query.limit(limit), Query.orderDesc("$createdAt")];
    if (lastId) queries.push(Query.cursorAfter(lastId));
    if (userId) queries.push(Query.equal("user", userId));
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksLibraryCollectionid, queries);
  }

  async getBookLikes({ bookId }) {
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksLikeCollectionId, [Query.equal("book", bookId)]);
  }

  async getBookLikeByOwner({ bookId, likeOwner }) {
    const queries = [Query.and([Query.equal("book", bookId), Query.equal("likeOwner", likeOwner)])];
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksLikeCollectionId, queries);
  }

  async createBookLike({ bookId, likeOwner }) {
    return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.booksLikeCollectionId, ID.unique(), {
      book: bookId,
      likeOwner,
    });
  }

  async deleteBookLike({ bookLikeId }) {
    return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.booksLikeCollectionId, bookLikeId);
  }

  async getBookLibraries({ bookId }) {
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksLibraryCollectionid, [Query.equal("book", bookId)]);
  }

  async getBookLibrayByUser({ bookId, userId }) {
    const queries = [Query.and([Query.equal("book", bookId), Query.equal("user", userId)])];
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksLibraryCollectionid, queries);
  }

  async createBookLibrary({ bookId, userId }) {
    return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.booksLibraryCollectionid, ID.unique(), {
      book: bookId,
      user: userId,
    });
  }

  async deleteBookLibrary({ bookLibraryId }) {
    return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.booksLibraryCollectionid, bookLibraryId);
  }

  async getBookComments({ bookId }) {
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksCommentsCollectionId, [Query.equal("book", bookId)]);
  }

  async fetchBookComments({ bookId, lastId, limit }) {
    const queries = [Query.limit(limit), Query.equal("book", bookId)];
    if (lastId) queries.push(Query.cursorAfter(lastId));
    const result = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksCommentsCollectionId, queries);

    if (result.documents.length > 0) {
      try {
        const commentIds = result.documents.map((comment) => comment?.$id).filter(Boolean);
        if (commentIds.length > 0) {
          const repliesResult = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksCommentRepliesCollectionId, [
            Query.equal("bookComment", commentIds),
            Query.orderAsc("$createdAt"),
            Query.limit(200),
          ]);

          const repliesByComment = {};
          repliesResult.documents.forEach((reply) => {
            const parentId = typeof reply?.bookComment === "string" ? reply.bookComment : reply?.bookComment?.$id;
            if (!parentId) return;
            if (!repliesByComment[parentId]) repliesByComment[parentId] = [];
            repliesByComment[parentId].push(reply);
          });

          result.documents.forEach((comment) => {
            comment.booksCommentReplies = repliesByComment[comment?.$id] || [];
          });
        }
      } catch (error) {
        console.log("fetchBookComments: replies fetch failed, comments still returned", error);
      }
    }

    return result;
  }

  async createBookComment({ bookId, comment, commentOwner }) {
    return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.booksCommentsCollectionId, ID.unique(), {
      book: bookId,
      comment,
      commentOwner,
    });
  }

  async getBookChapterLikes({ bookChapterId }) {
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksChaptersLikeCollectionId, [
      Query.equal("booksChapter", bookChapterId),
    ]);
  }

  async getBookChapterLikeByOwner({ bookChapterId, likeOwner }) {
    const queries = [Query.and([Query.equal("booksChapter", bookChapterId), Query.equal("likeOwner", likeOwner)])];
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksChaptersLikeCollectionId, queries);
  }

  async createBookChapterLike({ bookChapterId, likeOwner }) {
    return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.booksChaptersLikeCollectionId, ID.unique(), {
      booksChapter: bookChapterId,
      likeOwner,
    });
  }

  async deleteBookChapterLike({ bookChapterLikeId }) {
    return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.booksChaptersLikeCollectionId, bookChapterLikeId);
  }

  async getBookChapterComments({ bookChapterId }) {
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksChaptersCommentsCollectionId, [
      Query.equal("booksChapter", bookChapterId),
    ]);
  }

  async fetchBookChapterComments({ bookChapterId, lastId, limit }) {
    const queries = [Query.limit(limit), Query.equal("booksChapter", bookChapterId)];
    if (lastId) queries.push(Query.cursorAfter(lastId));
    const result = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksChaptersCommentsCollectionId, queries);

    // Explicitly fetch replies — Appwrite inverse relationship attributes
    // are not reliably expanded by listDocuments, so we query the replies
    // collection directly and attach them to their parent comments.
    if (result.documents.length > 0) {
      try {
        const commentIds = result.documents.map((c) => c.$id);
        const repliesResult = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksChaptersCommentRepliesCollectionId, [
          Query.equal("bookChapterComment", commentIds),
          Query.orderAsc("$createdAt"),
          Query.limit(100),
        ]);

        const repliesByComment = {};
        for (const reply of repliesResult.documents) {
          const parentId = typeof reply.bookChapterComment === "string" ? reply.bookChapterComment : reply.bookChapterComment?.$id;
          if (parentId) {
            if (!repliesByComment[parentId]) repliesByComment[parentId] = [];
            repliesByComment[parentId].push(reply);
          }
        }

        for (const comment of result.documents) {
          comment.booksChaptersCommentReplies = repliesByComment[comment.$id] || [];
        }
      } catch (err) {
        console.log("fetchBookChapterComments: replies fetch failed, comments still returned", err);
      }
    }

    return result;
  }

  async createBookChapterComment({ bookChapterId, comment, commentOwner }) {
    return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.booksChaptersCommentsCollectionId, ID.unique(), {
      booksChapter: bookChapterId,
      comment,
      commentOwner,
    });
  }

  async searchBooks({ searchQuery = "", limit = 10, cursorId = null }) {
    const trimmedQuery = searchQuery.trim();
    const userIds = await searchUsers(trimmedQuery);

    const baseQueries = [Query.orderDesc("$createdAt"), Query.limit(limit), Query.notEqual("status", "Draft")];

    if (cursorId) baseQueries.push(Query.cursorAfter(cursorId));

    const databaseId = appwriteConfig.databaseId;
    const collectionId = appwriteConfig.booksCollectionId;

    // 1️⃣ Exact title match
    const exactRes = await databases.listDocuments(databaseId, collectionId, [...baseQueries, Query.equal("title", trimmedQuery)]);

    // 2️⃣ Starts with (approximation: you can’t do startsWith, so use search)
    const searchRes = await databases.listDocuments(databaseId, collectionId, [...baseQueries, Query.search("title", searchQuery)]);

    // 3️⃣ Uploader match (if found)
    let uploaderRes = { documents: [] };
    if (userIds.length > 0) {
      uploaderRes = await databases.listDocuments(databaseId, collectionId, [...baseQueries, Query.equal("uploader", userIds)]);
    }

    // Merge + remove duplicates
    const combined = [...exactRes.documents, ...searchRes.documents, ...uploaderRes.documents];

    const unique = combined.filter((doc, index, arr) => arr.findIndex((d) => d.$id === doc.$id) === index);

    // Cap to limit
    return {
      documents: unique.slice(0, limit),
      hasMore: unique.length >= limit,
    };
  }

  async fetchContinueReadingBooks({ userId }) {
    try {
      // Fetch all user progress documents
      const progressDocs = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.usersBookProgressCollectionId, [
        Query.equal("user", userId),
        Query.orderDesc("$updatedAt"),
      ]);

      // Then, for each progress document, fetch the book and its chapters
      const booksWithChapters = await Promise.all(
        progressDocs.documents.map(async (progressDoc) => {
          const book = progressDoc.book; // assuming this is a relation field

          // 🧩 If book relation exists, fetch its chapters
          let bookChapters = [];
          if (book?.$id) {
            const chaptersResponse = await databases.listDocuments(
              appwriteConfig.databaseId,
              appwriteConfig.booksChaptersCollectionId,
              [Query.equal("book", book.$id), Query.orderAsc("order"), Query.notEqual("status", "Draft")], // or use your field
            );

            bookChapters = chaptersResponse.total;
          }

          return {
            ...progressDoc,
            book,
            bookChapters,
          };
        }),
      );

      return { documents: booksWithChapters, total: progressDocs.total };
    } catch (err) {
      console.error("fetchContinueReadingBooks error:", err);
      return [];
    }
  }

  async getContinueReadingBook({ userId, bookId }) {
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.usersBookProgressCollectionId, [
      Query.equal("user", userId),
      Query.equal("book", bookId),
    ]);
  }
}

const dedupeBooksById = (books = []) => {
  const seen = new Set();
  return books.filter((book) => {
    if (!book?.$id || seen.has(book.$id)) return false;
    seen.add(book.$id);
    return true;
  });
};

const shuffleBooks = (books = []) => {
  const shuffled = [...books];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled;
};

export const fetchRandomBook = async ({ limit = 1, status, category, excludeIds = [] } = {}) => {
  try {
    const safeLimit = Math.max(1, Math.floor(limit));
    const excludedBookIds = new Set(excludeIds.filter(Boolean));
    const baseFilters = [Query.notEqual("status", "Draft")];

    if (status) {
      baseFilters.push(Query.equal("status", status));
    }
    if (category) {
      baseFilters.push(Query.contains("tags", category));
    }

    const countResult = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksCollectionId, [...baseFilters, Query.limit(1)]);

    const totalBooks = countResult.total || 0;
    if (totalBooks === 0) {
      console.warn("No books found for the given filter.");
      return { documents: [] };
    }

    const sampleWindowSize = Math.min(Math.max(safeLimit * 3, 30), 100);
    const maxOffset = Math.max(totalBooks - sampleWindowSize, 0);
    const desiredWindowCount = Math.max(1, Math.min(4, Math.ceil(safeLimit / 12)));
    const usedOffsets = new Set();
    const sampledBooks = [];

    const buildWindowQuery = (offset) => [...baseFilters, Query.orderDesc("$createdAt"), Query.limit(sampleWindowSize), Query.offset(offset)];

    const initialOffsets = [];
    while (initialOffsets.length < desiredWindowCount) {
      const offset = maxOffset === 0 ? 0 : Math.floor(Math.random() * (maxOffset + 1));
      if (usedOffsets.has(offset)) continue;
      usedOffsets.add(offset);
      initialOffsets.push(offset);
    }

    const initialBatches = await Promise.all(
      initialOffsets.map((offset) => databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksCollectionId, buildWindowQuery(offset))),
    );

    sampledBooks.push(...initialBatches.flatMap((batch) => batch.documents));

    let uniqueBooks = dedupeBooksById(sampledBooks).filter((book) => !excludedBookIds.has(book.$id));
    let attempts = 0;
    const maxAttempts = 6;

    while (uniqueBooks.length < safeLimit && attempts < maxAttempts && usedOffsets.size < maxOffset + 1) {
      attempts += 1;
      const nextOffset = maxOffset === 0 ? 0 : Math.floor(Math.random() * (maxOffset + 1));
      if (usedOffsets.has(nextOffset)) continue;

      usedOffsets.add(nextOffset);
      const nextBatch = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksCollectionId, buildWindowQuery(nextOffset));

      sampledBooks.push(...nextBatch.documents);
      uniqueBooks = dedupeBooksById(sampledBooks).filter((book) => !excludedBookIds.has(book.$id));
    }

    const randomizedBooks = shuffleBooks(uniqueBooks).slice(0, safeLimit);

    return {
      documents: randomizedBooks,
      total: totalBooks,
    };
  } catch (err) {
    console.error("fetchRandomBook error:", err);
    throw err;
  }
};
