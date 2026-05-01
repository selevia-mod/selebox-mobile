// lib/book-comments.js — BookCommentsService dispatcher.
//
// Routes between Supabase (lib/book-comments-supabase.js) and Appwrite
// (lib/book-comments-appwrite.js) via USE_SUPABASE_BOOKS.

import { USE_SUPABASE_BOOKS } from "./feature-flags";
import * as supabaseImpl from "./book-comments-supabase";
import { BookCommentsService as BookCommentsServiceAppwrite } from "./book-comments-appwrite";

const BookCommentsServiceSupabase = {
  getBookComments: supabaseImpl.getBookComments,
  fetchBookComments: supabaseImpl.fetchBookComments,
  createBookComment: supabaseImpl.createBookComment,
  fetchBookCommentReplies: supabaseImpl.fetchBookCommentReplies,
  likeBookComment: supabaseImpl.likeBookComment,
  unlikeBookComment: supabaseImpl.unlikeBookComment,
  isBookCommentLiked: supabaseImpl.isBookCommentLiked,
  deleteBookComment: supabaseImpl.deleteBookComment,
};

export const BookCommentsService = USE_SUPABASE_BOOKS
  ? BookCommentsServiceSupabase
  : BookCommentsServiceAppwrite;
