import axios from "axios";
import { ID, Query } from "react-native-appwrite";
import { appwriteConfig, databases } from "./appwrite";
import { INTRODUCTION_ORDER, getBookChapterOrder } from "./books";

const UNLOCK_BOOK_API = "https://68ee799c002facb8d19b.fra.appwrite.run";
const resolveEntityId = (value) => {
  if (!value) return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value?.$id || value?.id || value?.uid || null;
};

export class BookUnlocksService {
  async unlockBookChapter({ book, chapterId, isFullyUnlocked = false, unlockBy }) {
    const userUnlockBookRecords = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.userBookUnlocksCollectionId, [
      Query.and([Query.equal("book", book), Query.equal("unlockBy", unlockBy)]),
    ]);

    const hasRecords = userUnlockBookRecords.documents.length > 0;

    if (hasRecords) {
      // update user unlock book records
      const userUnlockBookData = userUnlockBookRecords.documents[0];

      // merge and deduplicate chapter IDs
      const updatedChapters = Array.from(new Set([...userUnlockBookData.chapters, chapterId]));

      return databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.userBookUnlocksCollectionId, userUnlockBookData.$id, {
        chapters: updatedChapters,
      });
    } else {
      // create user unlock book records
      return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.userBookUnlocksCollectionId, ID.unique(), {
        book,
        chapters: [chapterId],
        isFullyUnlocked,
        unlockBy,
      });
    }
  }

  async getBookUnlockByUser({ book, unlockBy }) {
    const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.userBookUnlocksCollectionId, [
      Query.and([Query.equal("book", book), Query.equal("unlockBy", unlockBy)]),
    ]);

    return response;
  }

  static isBookOwnedByUser({ book, currentUserId }) {
    const ownerId = resolveEntityId(book?.uploader);
    const viewerId = resolveEntityId(currentUserId);
    return Boolean(ownerId && viewerId && ownerId === viewerId);
  }

  // Display-only lock check: same two-signal logic minus the owner-bypass
  // short-circuit. Used by visual surfaces (lock icons) where the author
  // should see what readers see. Functional callers should keep using
  // isChapterLocked so authors retain free read of their own work. See
  // lib/book-unlocks.js for the full rationale.
  static isChapterLockedForDisplay({ book, index, chapter, bookChapterLockStart, unlocks }) {
    const chapterOrder = getBookChapterOrder(chapter, index);
    if (chapterOrder === INTRODUCTION_ORDER) return false;

    if (unlocks?.isFullyUnlocked) return false;
    if (unlocks?.chapters?.includes(chapter?.$id)) return false;

    const chapterFlagLocked = !!(chapter?.is_locked || chapter?.isLocked);
    const resolvedLockStart =
      book?.bookChapterLockStart ??
      bookChapterLockStart ??
      (book?.isLocked ? 1 : Number.POSITIVE_INFINITY);
    const bookThresholdLocked = book?.isLocked && chapterOrder >= resolvedLockStart;

    return (bookThresholdLocked || chapterFlagLocked) && !unlocks?.isFullyLocked;
  }

  static isChapterLocked({ book, index, chapter, bookChapterLockStart, unlocks, currentUserId }) {
    if (BookUnlocksService.isBookOwnedByUser({ book, currentUserId })) return false;
    const chapterOrder = getBookChapterOrder(chapter, index);
    if (chapterOrder === INTRODUCTION_ORDER) return false;

    if (unlocks?.isFullyUnlocked) return false;
    if (unlocks?.chapters?.includes(chapter?.$id)) return false;

    // Two-signal lock check, same as the Supabase impl (see
    // book-unlocks.js for the full rationale): book-level threshold OR
    // per-chapter is_locked flag. Mirrors web's
    // `isLockedDef = isAtOrAfterLockPoint || c.is_locked`.
    const chapterFlagLocked = !!(chapter?.is_locked || chapter?.isLocked);
    const resolvedLockStart =
      book?.bookChapterLockStart ??
      bookChapterLockStart ??
      (book?.isLocked ? 1 : Number.POSITIVE_INFINITY);
    const bookThresholdLocked = book?.isLocked && chapterOrder >= resolvedLockStart;

    return (bookThresholdLocked || chapterFlagLocked) && !unlocks?.isFullyLocked;
  }

  async unlockBook({ bookId, chapterId, userId, type, contentOwnerId, unlockAll }) {
    try {
      const response = await axios.post(UNLOCK_BOOK_API, JSON.stringify({ bookId, chapterId, userId, type, contentOwnerId, unlockAll }), {
        headers: { "Content-Type": "application/json" },
      });
      const data = response.data;

      if (!data.success) {
        throw new Error(data.message || "Unlock failed");
      }

      return data;
    } catch (err) {
      console.error("Unlock book failed:", err.message);
      throw err;
    }
  }
}
