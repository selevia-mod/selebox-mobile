// lib/book-inline-comments.js — BookInlineCommentsService dispatcher.
//
// Routes between Supabase (lib/book-inline-comments-supabase.js — uses
// chapter_inline_comments + threads + likes tables) and Appwrite
// (lib/book-inline-comments-appwrite.js — original 717-line BookInline
// CommentsService) via USE_SUPABASE_BOOKS.
//
// Pure helpers (notification resource ID parse/build, feature flag
// shape) re-export unconditionally from the Appwrite file because
// they're backend-agnostic.

import { USE_SUPABASE_BOOKS } from "./feature-flags";
import * as supabaseImpl from "./book-inline-comments-supabase";
import {
  BookInlineCommentsService as BookInlineCommentsServiceAppwrite,
  INLINE_COMMENT_NOTIFICATION_TYPE,
  INLINE_COMMENT_FEATURE_FLAGS,
  buildInlineCommentNotificationResourceId,
  parseInlineCommentNotificationResourceId,
} from "./book-inline-comments-appwrite";

// Methods the Supabase impl actually exposes today. Built as a
// partial override; unknown methods fall through to the Appwrite
// service via the spread below.
const BookInlineCommentsServiceSupabaseOverrides = {
  // Threads
  getOrCreateInlineThread: supabaseImpl.getOrCreateInlineThread,
  fetchInlineThreadsForChapter: supabaseImpl.fetchInlineThreadsForChapter,
  // Comments
  fetchInlineComments: supabaseImpl.fetchInlineComments,
  fetchInlineCommentReplies: supabaseImpl.fetchInlineCommentReplies,
  createInlineComment: supabaseImpl.createInlineComment,
  updateInlineComment: supabaseImpl.updateInlineComment,
  deleteInlineComment: supabaseImpl.deleteInlineComment,
  // Likes
  likeInlineComment: supabaseImpl.likeInlineComment,
  unlikeInlineComment: supabaseImpl.unlikeInlineComment,
  isInlineCommentLiked: supabaseImpl.isInlineCommentLiked,
  fetchInlineLikesByUser: supabaseImpl.fetchInlineLikesByUser,
};

// Composed service: start from the Appwrite impl as the base, then
// override any method the Supabase impl has implemented. This keeps
// BookInlineCommentModal from crashing on calls like
// `isConfigured()`, `getFeatureFlags()`, `getThreadByAnchor()`, etc.
// — those still flow through the Appwrite service until Supabase
// parity is reached. For methods Supabase HAS implemented, the
// override wins and we hit the new backend.
const BookInlineCommentsServiceSupabase = {
  ...BookInlineCommentsServiceAppwrite,
  ...BookInlineCommentsServiceSupabaseOverrides,
};

export const BookInlineCommentsService = USE_SUPABASE_BOOKS
  ? BookInlineCommentsServiceSupabase
  : BookInlineCommentsServiceAppwrite;

// Pure helpers — backend-agnostic, always from the Appwrite file.
export {
  INLINE_COMMENT_NOTIFICATION_TYPE,
  INLINE_COMMENT_FEATURE_FLAGS,
  buildInlineCommentNotificationResourceId,
  parseInlineCommentNotificationResourceId,
};
