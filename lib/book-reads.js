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
  upsertBookRead: supabaseImpl.upsertBookRead,
  getBookRead: supabaseImpl.getBookRead,
  fetchRecentReads: supabaseImpl.fetchRecentReads,
};

export const BookReadService = USE_SUPABASE_BOOKS
  ? BookReadServiceSupabase
  : BookReadServiceAppwrite;

export const fetchBookReadsByIds = USE_SUPABASE_BOOKS
  ? supabaseImpl.fetchBookReadsByIds
  : fetchBookReadsByIdsAppwrite;

// invalidateBookReadCache is local cache management — keep the legacy
// implementation either way (no Supabase equivalent needed).
export const invalidateBookReadCache = invalidateBookReadCacheAppwrite;
