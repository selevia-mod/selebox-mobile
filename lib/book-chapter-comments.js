// lib/book-chapter-comments.js — BookChapterCommentsService dispatcher.
//
// Routes between Supabase (lib/book-chapter-comments-supabase.js) and
// Appwrite (lib/book-chapter-comments-appwrite.js) via USE_SUPABASE_BOOKS.

import { USE_SUPABASE_BOOKS } from "./feature-flags";
import * as supabaseImpl from "./book-chapter-comments-supabase";
import { BookChapterCommentsService as BookChapterCommentsServiceAppwrite } from "./book-chapter-comments-appwrite";

const BookChapterCommentsServiceSupabase = {
  getBookChapterComments: supabaseImpl.getBookChapterComments,
  fetchBookChapterComments: supabaseImpl.fetchBookChapterComments,
  createBookChapterComment: supabaseImpl.createBookChapterComment,
  fetchChapterCommentReplies: supabaseImpl.fetchChapterCommentReplies,
  likeChapterComment: supabaseImpl.likeChapterComment,
  unlikeChapterComment: supabaseImpl.unlikeChapterComment,
  isChapterCommentLiked: supabaseImpl.isChapterCommentLiked,
  deleteBookChapterComment: supabaseImpl.deleteBookChapterComment,
};

export const BookChapterCommentsService = USE_SUPABASE_BOOKS
  ? BookChapterCommentsServiceSupabase
  : BookChapterCommentsServiceAppwrite;
