// lib/books.js — BookService dispatcher.
//
// Routes BookService class + all the module-level book helpers between
// Supabase (lib/books-supabase.js) and Appwrite (lib/books-appwrite.js)
// via USE_SUPABASE_BOOKS. Same pattern as the rest of the migration —
// keeps every existing import path stable so the ~30 consumer files
// (book-info, BookLibraryCard, BookChapterFooter, profile screens,
// search, recommendations, etc.) don't change.
//
// Pre-flight before flipping USE_SUPABASE_BOOKS=true:
//   1. Run Selebox/migration_books_engagement.sql to create the 9 new
//      engagement tables + 7 count-tracking triggers.
//   2. (Optional) Migrate existing book_comments / chapter_comments
//      ratings / inline-comments from Appwrite into Supabase. Without
//      this, USE_SUPABASE_BOOKS=true means users see the books list
//      from Supabase but any historical comments stay on Appwrite
//      (only viewable when the flag is off). This is fine for a soft
//      launch; data backfill can happen post-flip.
//   3. Verify USE_SUPABASE_AUTH plan — book-supabase methods accept
//      both UUID and Appwrite hex IDs, so this works under either auth
//      mode.
//   4. Test on dev build.

import { USE_SUPABASE_BOOKS } from "./feature-flags";
import * as supabaseImpl from "./books-supabase";
import * as appwriteImpl from "./books-appwrite";

const impl = USE_SUPABASE_BOOKS ? supabaseImpl : appwriteImpl;

// BookService class — picked at module load.
export const BookService = USE_SUPABASE_BOOKS
  ? supabaseImpl.BookServiceSupabase
  : appwriteImpl.BookService;

// Cache invalidators.
export const invalidateBookCache = impl.invalidateBookCache;
export const invalidateBookChapterCache = impl.invalidateBookChapterCache;

// Form initial values + chapter ordering helpers (backend-agnostic but
// re-exported here so consumers can import them from "./books").
export const initialBookForm = impl.initialBookForm;
export const initialChapterForm = impl.initialChapterForm;
export const INTRODUCTION_ORDER = impl.INTRODUCTION_ORDER;
export const getBookChapterOrder = impl.getBookChapterOrder;
export const sortBookChaptersByOrder = impl.sortBookChaptersByOrder;
export const isIntroductionChapter = impl.isIntroductionChapter;
export const getNextNumberedBookChapterOrder = impl.getNextNumberedBookChapterOrder;
export const getNextBookChapterOrder = impl.getNextBookChapterOrder;
export const getBookChapterSectionLabel = impl.getBookChapterSectionLabel;
export const BOOK_CHAPTER_LIST_SELECT = impl.BOOK_CHAPTER_LIST_SELECT;

// ─────────────────────────────────────────────────────────────────────────
// Helpers the migration scaffold initially missed.
//
// Both consumed at runtime — caught during dev-build smoke test:
//   - fetchRandomBook: Books tab → "Random pick" CTA + book-info / book-reading
//     screens, called from refreshBooks. Crash: "fetchRandomBook is not a
//     function".
//   - hydrateDiscoverStats: BooksDiscover screen → fetchDiscoverRankings
//     enriches book rows with totalReads/totalLikes/averageRating from a
//     batched call. Crash: "hydrateDiscoverStats is not a function".
//
// Both currently live on the Appwrite path only (no Supabase impl yet);
// when the Supabase impl gains them, the same `impl.X ?? appwriteImpl.X`
// pattern lets the export flip with the flag automatically.
// ─────────────────────────────────────────────────────────────────────────

export const fetchRandomBook = impl.fetchRandomBook ?? appwriteImpl.fetchRandomBook;
export const hydrateDiscoverStats = impl.hydrateDiscoverStats ?? appwriteImpl.hydrateDiscoverStats;
