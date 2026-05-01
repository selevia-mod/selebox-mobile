// lib/book-rating.js — BookRatingService dispatcher.
//
// Routes between Supabase (lib/book-rating-supabase.js — flat helpers
// over book_ratings table) and Appwrite (lib/book-rating-appwrite.js —
// original BookRatingService class) via USE_SUPABASE_BOOKS.

import { USE_SUPABASE_BOOKS } from "./feature-flags";
import * as supabaseImpl from "./book-rating-supabase";
import { BookRatingService as BookRatingServiceAppwrite } from "./book-rating-appwrite";

class BookRatingServiceSupabase {
  async rateBook(args) { return supabaseImpl.rateBook(args); }
  async getMyRating(args) { return supabaseImpl.getMyRating(args); }
  async getBookRatingStats(args) { return supabaseImpl.getBookRatingStats(args); }
  async removeMyRating(args) { return supabaseImpl.removeMyRating(args); }
  async fetchRecentReviews(args) { return supabaseImpl.fetchRecentReviews(args); }
}

export const BookRatingService = USE_SUPABASE_BOOKS
  ? BookRatingServiceSupabase
  : BookRatingServiceAppwrite;
