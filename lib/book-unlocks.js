// lib/book-unlocks.js — BookUnlocksService dispatcher.
//
// Routes between Supabase (lib/book-unlocks-supabase.js — wraps
// wallet-supabase unlock_content + unlock_book_bulk RPCs) and Appwrite
// (lib/book-unlocks-appwrite.js — legacy unlockVideo Cloud Function +
// unlockedVideos collection) via USE_SUPABASE_BOOKS.

import { USE_SUPABASE_BOOKS } from "./feature-flags";
import * as supabaseImpl from "./book-unlocks-supabase";
import { BookUnlocksService as BookUnlocksServiceAppwrite } from "./book-unlocks-appwrite";

class BookUnlocksServiceSupabase {
  async unlockChapter(args) { return supabaseImpl.unlockChapter(args); }
  async unlockBookAllChapters(args) { return supabaseImpl.unlockBookAllChapters(args); }
  async isChapterUnlocked(args) { return supabaseImpl.isChapterUnlocked(args); }
  async isBookFullyUnlocked(args) { return supabaseImpl.isBookFullyUnlocked(args); }
  async getUnlockedChapterIds(args) { return supabaseImpl.getUnlockedChapterIds(args); }
  async getUnlockedBookIds(args) { return supabaseImpl.getUnlockedBookIds(args); }
}

export const BookUnlocksService = USE_SUPABASE_BOOKS
  ? BookUnlocksServiceSupabase
  : BookUnlocksServiceAppwrite;
