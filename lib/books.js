// lib/books.js — BookService dispatcher.
//
// Routes the BookService class + all module-level book helpers between
// Supabase (lib/books-supabase.js) and Appwrite (lib/books-appwrite.js)
// via the USE_SUPABASE_BOOKS feature flag. Same pattern as the rest of
// the Appwrite → Supabase migration; keeps every existing import path
// stable so the ~30 consumer files (book-info, BookLibraryCard,
// BookChapterFooter, profile screens, search, recommendations, etc.)
// don't have to change when the flag flips.
//
// Current state (post-migration):
//   USE_SUPABASE_BOOKS = true is committed. The Appwrite branch of the
//   ternary is theoretically reachable on a flag revert, but the
//   slimmed lib/books-appwrite.js only retains the Bunny CDN upload
//   methods + helpers — every other CRUD method has been deleted. A
//   real revert would require restoring those from git history first.

import { USE_SUPABASE_BOOKS } from "./feature-flags";
import * as appwriteImpl from "./books-appwrite";
import * as supabaseImpl from "./books-supabase";

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

// Discovery helpers — both have native Supabase implementations now,
// so the previous `?? appwriteImpl.X` fallback is dead and gone.
// (Originally added to bridge crashes during the migration: "fetchRandomBook
// is not a function" / "hydrateDiscoverStats is not a function" before
// the Supabase versions landed. Both shipped weeks ago.)
export const fetchRandomBook = impl.fetchRandomBook;
export const hydrateDiscoverStats = impl.hydrateDiscoverStats;
