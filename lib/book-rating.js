// lib/book-rating.js — BookRatingService dispatcher.
//
// Routes between Supabase (lib/book-rating-supabase.js — flat helpers
// over book_ratings table) and Appwrite (lib/book-rating-appwrite.js —
// original BookRatingService class) via USE_SUPABASE_BOOKS.

import { USE_SUPABASE_BOOKS } from "./feature-flags";
import * as supabaseImpl from "./book-rating-supabase";
import { BookRatingService as BookRatingServiceAppwrite } from "./book-rating-appwrite";

class BookRatingServiceSupabase {
  // Supabase-native methods
  async rateBook(args) { return supabaseImpl.rateBook(args); }
  async getMyRating(args) { return supabaseImpl.getMyRating(args); }
  async getBookRatingStats(args) { return supabaseImpl.getBookRatingStats(args); }
  async removeMyRating(args) { return supabaseImpl.removeMyRating(args); }
  async fetchRecentReviews(args) { return supabaseImpl.fetchRecentReviews(args); }
  // Appwrite-compat — match the legacy BookRatingService static method
  // names so book-info.jsx etc. call sites work unchanged when the
  // USE_SUPABASE_BOOKS flag flips on. The Appwrite service used static
  // methods (BookRatingService.createRating(...)), so we expose both as
  // static and instance forms.
  static async createRating(args) { return supabaseImpl.createRating(args); }
  static async getUserRating(args) { return supabaseImpl.getUserRating(args); }
  static async getBookRatings(args) { return supabaseImpl.getBookRatings(args); }
  async createRating(args) { return supabaseImpl.createRating(args); }
  async getUserRating(args) { return supabaseImpl.getUserRating(args); }
  async getBookRatings(args) { return supabaseImpl.getBookRatings(args); }
}

export const BookRatingService = USE_SUPABASE_BOOKS
  ? BookRatingServiceSupabase
  : BookRatingServiceAppwrite;
