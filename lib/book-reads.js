// lib/book-reads.js — BookReadService dispatcher.
//
// Routes between Supabase (lib/book-reads-supabase.js) and Appwrite
// (lib/book-reads-appwrite.js) via USE_SUPABASE_BOOKS.
//
// invalidateBookReadCache + fetchBookReadsByIds are also re-exported
// from here because the legacy lib/book-reads.js exposes them at module
// level (not via the BookReadService object). Consumers do
// `import { fetchBookReadsByIds, BookReadService } from "./book-reads"`.

import { USE_SUPABASE_BOOKS } from "./feature-flags";
import * as supabaseImpl from "./book-reads-supabase";
import {
  BookReadService as BookReadServiceAppwrite,
  invalidateBookReadCache as invalidateBookReadCacheAppwrite,
  fetchBookReadsByIds as fetchBookReadsByIdsAppwrite,
} from "./book-reads-appwrite";

const BookReadServiceSupabase = {
  // Supabase-native methods
  upsertBookRead: supabaseImpl.upsertBookRead,
  getBookRead: supabaseImpl.getBookRead,
  fetchRecentReads: supabaseImpl.fetchRecentReads,
  // recordBookView — May 2026 simplified views model. Called from
  // book-info.jsx on screen mount to bump books.views_count by 1 per
  // open. Pairs with readBookChapter, which bumps both chapter and
  // book counters via record_chapter_view on chapter open.
  recordBookView: supabaseImpl.recordBookView,
  // Appwrite-compat — match legacy BookReadService method names so
  // book-reading.jsx (4 call sites), BookCard, BookCatalogCard,
  // BookInfoStats, BookLibraryCard, BookChapterStats all work unchanged
  // when USE_SUPABASE_BOOKS flips on.
  readBookChapter: supabaseImpl.readBookChapter,
  fetchBookRead: supabaseImpl.fetchBookRead,
  fetchChapterRead: supabaseImpl.fetchChapterRead,
};

export const BookReadService = USE_SUPABASE_BOOKS
  ? BookReadServiceSupabase
  : BookReadServiceAppwrite;

export const fetchBookReadsByIds = USE_SUPABASE_BOOKS
  ? supabaseImpl.fetchBookReadsByIds
  : fetchBookReadsByIdsAppwrite;

// invalidateBookReadCache — Appwrite version evicts a per-book TTL cache
// used by the books-appwrite list loaders. Supabase version is a no-op
// because aggregate stats are read fresh from the books table per render.
// Route to the right impl so consumers don't hit Appwrite's MMKV cache
// after the flag flips.
export const invalidateBookReadCache = USE_SUPABASE_BOOKS
  ? supabaseImpl.invalidateBookReadCache
  : invalidateBookReadCacheAppwrite;
