// lib/books-rankings.js — BooksRankingService dispatcher.
//
// Routes between Supabase (lib/books-rankings-supabase.js) and Appwrite
// (lib/books-rankings-appwrite.js) via USE_SUPABASE_BOOKS.

import { USE_SUPABASE_BOOKS } from "./feature-flags";
import { BooksRankingService as BooksRankingServiceSupabase } from "./books-rankings-supabase";
import { BooksRankingService as BooksRankingServiceAppwrite } from "./books-rankings-appwrite";

export const BooksRankingService = USE_SUPABASE_BOOKS
  ? BooksRankingServiceSupabase
  : BooksRankingServiceAppwrite;
