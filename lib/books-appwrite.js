// lib/books-appwrite.js
//
// Slim legacy module — only the parts still reachable at runtime now
// that USE_SUPABASE_BOOKS=true is committed.
//
// What's still used:
//   • `BookService.uploadBookImage` / `uploadCover` / `uploadChapterInlineImage`
//     — the CDN uploads still go through Bunny via Appwrite Storage.
//     books-supabase.js dynamically imports this class and proxies the
//     three upload methods. Bunny isn't migrating with the rest of the
//     stack, so these stay.
//   • Top-level helpers (`invalidateBookCache`, `initialBookForm`,
//     `INTRODUCTION_ORDER`, the chapter-order helpers, the
//     `BOOK_CHAPTER_LIST_SELECT` constant) — kept as parity with
//     books-supabase.js so the lib/books.js dispatcher's
//     `import * as appwriteImpl` keeps working without `undefined`
//     surprises if any caller ever lands on the legacy branch.
//
// What's been removed:
//   • The full `BookService` CRUD surface (createNewBook, updateBook,
//     deleteBook, fetchBook, fetch*, all engagement reads/writes,
//     comments, library, ratings — ~30 methods, ~600 lines). All of it
//     was unreachable: the dispatcher in lib/books.js resolves
//     `BookService` to `BookServiceSupabase` when USE_SUPABASE_BOOKS=
//     true, which is the committed steady state. None of those methods
//     was being called.
//   • `fetchRandomBook` and `hydrateDiscoverStats` module exports —
//     books-supabase.js has native implementations of both, so the
//     `?? appwriteImpl.X` fallback in lib/books.js is now dead weight
//     and has been simplified to direct `impl.X`.
//   • Imports of `books-dual-write`, `book-reads`, `BooksRankingService`,
//     `searchUsers`, `logger`, and the cache helpers — all only
//     referenced by the deleted methods.
//
// If you ever need to revert to USE_SUPABASE_BOOKS=false, the deleted
// methods can be restored from git history (see commit that landed
// this trim). The dual-write helpers in lib/books-dual-write.js are
// untouched because they're still imported by other -appwrite.js files
// (book-reads-appwrite, book-comments-appwrite, etc.) whose flags
// haven't flipped yet.

import { ID } from "react-native-appwrite";
import { appwriteConfig, storage } from "./appwrite";

// Cache shims kept for API parity with books-supabase.js. Nothing
// actually populates these caches anymore (no fetchBook / fetchBookChapter
// methods on this class), so the .delete() calls are no-ops in practice.
// Keeping the exports prevents `lib/books.js`'s `impl.invalidateBookCache`
// reference from going `undefined` if anything ever lands on this side.
export const invalidateBookCache = () => {};
export const invalidateBookChapterCache = () => {};

// ─────────────────────────────────────────────────────────────────────────
// Form initial values + chapter-order helpers
// ─────────────────────────────────────────────────────────────────────────
//
// Duplicated by lib/books-supabase.js (those copies are the live ones at
// runtime). Kept here for the dispatcher's `import * as appwriteImpl`
// spread to surface the same shape on both branches. If you change
// behavior here, change books-supabase.js too — there's a chapter-order
// regression test ladder in book-editor / chapter-editor that touches
// these via `getNextNumberedBookChapterOrder`.

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
  const parsedOrder = Number(chapter?.order ?? chapter?.chapter_number);
  if (Number.isFinite(parsedOrder) && parsedOrder >= 0) return parsedOrder;
  return index;
};

export const sortBookChaptersByOrder = (chapters = []) =>
  [...chapters].sort((a, b) => getBookChapterOrder(a) - getBookChapterOrder(b));

export const isIntroductionChapter = (chapter, index = 0) =>
  getBookChapterOrder(chapter, index) === INTRODUCTION_ORDER;

export const getNextBookChapterOrder = (chapters = []) => {
  if (!chapters.length) return INTRODUCTION_ORDER;
  const max = Math.max(...chapters.map((chapter, index) => getBookChapterOrder(chapter, index)));
  return Number.isFinite(max) ? max + 1 : INTRODUCTION_ORDER;
};

export const getNextNumberedBookChapterOrder = (chapters = []) => {
  const numbered = chapters
    .map((chapter, index) => getBookChapterOrder(chapter, index))
    .filter((order) => order > INTRODUCTION_ORDER);
  if (!numbered.length) return INTRODUCTION_ORDER + 1;
  return Math.max(...numbered) + 1;
};

// Mirror of lib/books-supabase.js — keep in sync. `#N` matches the web
// client and is naming-agnostic (author can call a part Prologue, Teaser,
// Chapter 1, etc. without the sequence label clashing).
export const getBookChapterSectionLabel = (chapter, index = 0) =>
  isIntroductionChapter(chapter, index) ? "Introduction" : `#${getBookChapterOrder(chapter, index)}`;

export const BOOK_CHAPTER_LIST_SELECT = ["$id", "$createdAt", "$updatedAt", "title", "thumbnail", "order", "status"];

// ─────────────────────────────────────────────────────────────────────────
// BookService — Bunny CDN uploads only.
// ─────────────────────────────────────────────────────────────────────────
//
// books-supabase.js dynamically imports this class for the three upload
// methods. Everything else on the legacy class has been removed; if a
// caller manages to land on a method that isn't upload*, JS throws a
// "X is not a function" — that's intentional, it'll surface a missed
// migration rather than silently returning undefined.

export class BookService {
  /**
   * Convert image to WebP, upload to Appwrite Storage (Bunny CDN backed),
   * return a public preview URL. Used for both book covers and chapter
   * inline images — the only two CDN-bound write paths still on the
   * legacy stack.
   */
  async uploadBookImage(file, { maxWidth = 800, compress = 0.7 } = {}) {
    if (!file?.uri) return null;
    const { convertToWebP, cleanupTempFile } = require("./utils/image-utils");
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

  /** Book cover — uses the standard 800px / 0.7 compression preset. */
  async uploadCover(file) {
    return this.uploadBookImage(file, { maxWidth: 800, compress: 0.7 });
  }

  /** Inline image inside chapter content — wider (1400px) at slightly
   *  higher quality so paragraph-width images stay sharp. */
  async uploadChapterInlineImage(file) {
    return this.uploadBookImage(file, { maxWidth: 1400, compress: 0.78 });
  }
}
