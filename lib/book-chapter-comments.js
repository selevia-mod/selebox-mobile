// lib/book-chapter-comments.js — BookChapterCommentsService dispatcher.
//
// Routes between Supabase (lib/book-chapter-comments-supabase.js) and
// Appwrite (lib/book-chapter-comments-appwrite.js) via USE_SUPABASE_BOOKS.

import { USE_SUPABASE_BOOKS } from "./feature-flags";
import * as supabaseImpl from "./book-chapter-comments-supabase";
import { BookChapterCommentsService as BookChapterCommentsServiceAppwrite } from "./book-chapter-comments-appwrite";

const BookChapterCommentsServiceSupabase = {
  // Supabase-native methods
  getBookChapterComments: supabaseImpl.getBookChapterComments,
  fetchBookChapterComments: supabaseImpl.fetchBookChapterComments,
  createBookChapterComment: supabaseImpl.createBookChapterComment,
  fetchChapterCommentReplies: supabaseImpl.fetchChapterCommentReplies,
  likeChapterComment: supabaseImpl.likeChapterComment,
  unlikeChapterComment: supabaseImpl.unlikeChapterComment,
  isChapterCommentLiked: supabaseImpl.isChapterCommentLiked,
  deleteBookChapterComment: supabaseImpl.deleteBookChapterComment,
  // May 2026 — book-info "Comments" section now aggregates across all
  // chapters of a book instead of showing book-level comments. The
  // book-level comments surface was barely used; reader engagement
  // happens at the chapter level. This fetcher pulls the aggregated
  // view in one round-trip with chapter metadata embedded for the
  // breadcrumb on each item.
  fetchBookAggregatedChapterComments: supabaseImpl.fetchBookAggregatedChapterComments,
  // createReplyChapterComment was relocated from BookCommentsService
  // (May 2026 cleanup) — it's a chapter_comments INSERT and never had
  // anything to do with book-level comments. Lives here now on the
  // service that actually owns chapter_comments.
  createReplyChapterComment: supabaseImpl.createReplyChapterComment,
  // Appwrite-compat aliases — match legacy BookChapterCommentsService
  // method names so BookChapterCommentItem.likeComment / removeLikeComment
  // work unchanged when USE_SUPABASE_BOOKS flips on.
  likeComment: supabaseImpl.likeComment,
  removeLikeComment: supabaseImpl.removeLikeComment,
};

export const BookChapterCommentsService = USE_SUPABASE_BOOKS
  ? BookChapterCommentsServiceSupabase
  : BookChapterCommentsServiceAppwrite;
