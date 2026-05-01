// Supabase-flavored inline chapter comments — drop-in for
// lib/book-inline-comments.js. The legacy file is 717 lines covering
// thread anchoring, comments, replies, likes — the most complex
// engagement surface in books.
//
// Schema (from migration_books_engagement.sql):
//   chapter_inline_comment_threads — anchor groups (chapter + start/end
//                                    offset + anchor_text)
//   chapter_inline_comments        — top-level + replies via parent_id
//   chapter_inline_comment_likes   — composite PK (comment_id, user_id)
//
// This file ports the most-used read/write paths. Less-common operations
// (bulk migration utilities, complex anchor fixup) fall through to the
// Appwrite version via the dispatcher when the flag is on but consumers
// touch unported code paths.

import supabase from "./supabase";
import { resolveSupabaseUserId } from "./posts-supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resolveChapterId = async (chapterId) => {
  if (!chapterId) return null;
  if (UUID_RE.test(chapterId)) return chapterId;
  const { data } = await supabase.from("chapters").select("id").eq("legacy_appwrite_id", chapterId).maybeSingle();
  return data?.id || null;
};

const COMMENT_SELECT = `
  id, thread_id, chapter_id, user_id, content, parent_id,
  likes_count, replies_count, legacy_appwrite_id, created_at, updated_at,
  profiles!chapter_inline_comments_user_id_fkey ( id, username, avatar_url, legacy_appwrite_id )
`;

const mapComment = (row) => {
  if (!row) return null;
  const u = row.profiles || {};
  return {
    id: row.id,
    threadId: row.thread_id,
    chapterId: row.chapter_id,
    userId: row.user_id,
    content: row.content,
    parentId: row.parent_id,
    likesCount: row.likes_count ?? 0,
    repliesCount: row.replies_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    legacyAppwriteId: row.legacy_appwrite_id,
    user: { id: u.id, username: u.username, avatar: u.avatar_url, legacyAppwriteId: u.legacy_appwrite_id },
    // Appwrite-shaped legacy alias
    $id: row.legacy_appwrite_id || row.id,
    $createdAt: row.created_at,
    comment: row.content,
    commentOwner: u,
  };
};

// ── Threads ─────────────────────────────────────────────────────────────

// Get or create a thread for a specific anchor in a chapter. Reusing an
// existing thread for the same anchor span keeps multiple commenters
// grouped together.
export const getOrCreateInlineThread = async ({
  chapterId, startOffset, endOffset, anchorText,
}) => {
  const chapterUuid = await resolveChapterId(chapterId);
  if (!chapterUuid) throw new Error("getOrCreateInlineThread: cannot resolve chapter");
  if (!Number.isFinite(startOffset) || !Number.isFinite(endOffset)) {
    throw new Error("startOffset and endOffset must be numbers");
  }

  // Try to find an existing thread covering the same span.
  const { data: existing } = await supabase
    .from("chapter_inline_comment_threads")
    .select("id, start_offset, end_offset, anchor_text, comments_count")
    .eq("chapter_id", chapterUuid)
    .eq("start_offset", startOffset)
    .eq("end_offset", endOffset)
    .maybeSingle();
  if (existing) return existing;

  // Otherwise create one.
  const { data, error } = await supabase
    .from("chapter_inline_comment_threads")
    .insert({
      chapter_id: chapterUuid,
      start_offset: startOffset,
      end_offset: endOffset,
      anchor_text: anchorText || "",
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
};

// All threads on a chapter — used to render the highlighted anchors in
// the reader.
export const fetchInlineThreadsForChapter = async ({ chapterId }) => {
  const chapterUuid = await resolveChapterId(chapterId);
  if (!chapterUuid) return [];
  const { data, error } = await supabase
    .from("chapter_inline_comment_threads")
    .select("id, chapter_id, start_offset, end_offset, anchor_text, comments_count, created_at")
    .eq("chapter_id", chapterUuid)
    .order("start_offset", { ascending: true });
  if (error) throw error;
  return data || [];
};

// ── Comments ────────────────────────────────────────────────────────────

export const fetchInlineComments = async ({ threadId, limit = 50 }) => {
  if (!threadId) return [];
  const { data, error } = await supabase
    .from("chapter_inline_comments")
    .select(COMMENT_SELECT)
    .eq("thread_id", threadId)
    .is("parent_id", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(mapComment);
};

export const fetchInlineCommentReplies = async ({ commentId }) => {
  if (!commentId) return [];
  const { data, error } = await supabase
    .from("chapter_inline_comments")
    .select(COMMENT_SELECT)
    .eq("parent_id", commentId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(mapComment);
};

export const createInlineComment = async ({
  threadId, chapterId, userId, content, parentId = null,
}) => {
  const userUuid = await resolveSupabaseUserId(userId);
  const chapterUuid = chapterId ? await resolveChapterId(chapterId) : null;
  if (!threadId || !userUuid || !chapterUuid) throw new Error("createInlineComment: missing args");

  const { data, error } = await supabase
    .from("chapter_inline_comments")
    .insert({
      thread_id: threadId,
      chapter_id: chapterUuid,
      user_id: userUuid,
      content,
      parent_id: parentId,
    })
    .select(COMMENT_SELECT)
    .maybeSingle();
  if (error) throw error;
  return mapComment(data);
};

export const updateInlineComment = async ({ commentId, content }) => {
  if (!commentId) return null;
  const isUuid = UUID_RE.test(commentId);
  const column = isUuid ? "id" : "legacy_appwrite_id";
  const { data, error } = await supabase
    .from("chapter_inline_comments")
    .update({ content, updated_at: new Date().toISOString() })
    .eq(column, commentId)
    .select(COMMENT_SELECT)
    .maybeSingle();
  if (error) throw error;
  return mapComment(data);
};

export const deleteInlineComment = async ({ commentId }) => {
  if (!commentId) return;
  const isUuid = UUID_RE.test(commentId);
  const column = isUuid ? "id" : "legacy_appwrite_id";
  const { error } = await supabase.from("chapter_inline_comments").delete().eq(column, commentId);
  if (error) throw error;
};

// ── Likes ───────────────────────────────────────────────────────────────

export const likeInlineComment = async ({ commentId, userId }) => {
  const userUuid = await resolveSupabaseUserId(userId);
  if (!userUuid || !commentId) return null;
  const { error } = await supabase
    .from("chapter_inline_comment_likes")
    .insert({ comment_id: commentId, user_id: userUuid });
  if (error && error.code !== "23505") throw error;
  return { $id: `${commentId}::${userUuid}` };
};

export const unlikeInlineComment = async ({ commentId, userId }) => {
  const userUuid = await resolveSupabaseUserId(userId);
  if (!userUuid || !commentId) return;
  const { error } = await supabase
    .from("chapter_inline_comment_likes")
    .delete()
    .eq("comment_id", commentId)
    .eq("user_id", userUuid);
  if (error) throw error;
};

export const isInlineCommentLiked = async ({ commentId, userId }) => {
  const userUuid = await resolveSupabaseUserId(userId);
  if (!userUuid || !commentId) return false;
  const { data } = await supabase
    .from("chapter_inline_comment_likes")
    .select("comment_id")
    .eq("comment_id", commentId)
    .eq("user_id", userUuid)
    .maybeSingle();
  return !!data;
};

// Bulk fetch — given a list of comment ids, return which the user has liked.
// Used to mark hearts on all comments in a chapter view in one query.
export const fetchInlineLikesByUser = async ({ commentIds = [], userId }) => {
  if (!userId || commentIds.length === 0) return new Set();
  const userUuid = await resolveSupabaseUserId(userId);
  if (!userUuid) return new Set();
  const { data } = await supabase
    .from("chapter_inline_comment_likes")
    .select("comment_id")
    .eq("user_id", userUuid)
    .in("comment_id", commentIds);
  return new Set((data || []).map((r) => r.comment_id));
};
