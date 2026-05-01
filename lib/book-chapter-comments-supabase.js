// Supabase-flavored chapter comments — drop-in for lib/book-chapter-comments.js.
// Uses the existing chapter_comments table (which we extended via
// migration_books_engagement.sql to add likes_count, replies_count,
// updated_at) plus the new chapter_comment_likes table.

import supabase from "./supabase";
import { resolveSupabaseUserId } from "./posts-supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMENT_SELECT = `
  id, chapter_id, user_id, content, parent_id, likes_count, replies_count,
  legacy_appwrite_id, created_at,
  profiles!chapter_comments_user_id_fkey ( id, username, avatar_url, legacy_appwrite_id )
`;

const mapRow = (row) => {
  if (!row) return null;
  const u = row.profiles || {};
  return {
    id: row.id,
    chapter_id: row.chapter_id,
    user_id: row.user_id,
    content: row.content,
    parent_id: row.parent_id,
    likes_count: row.likes_count ?? 0,
    replies_count: row.replies_count ?? 0,
    created_at: row.created_at,
    legacy_appwrite_id: row.legacy_appwrite_id,
    // Appwrite-shaped legacy aliases
    $id: row.legacy_appwrite_id || row.id,
    $createdAt: row.created_at,
    chapter: row.chapter_id,
    comment: row.content,
    commentOwner: {
      $id: u.legacy_appwrite_id || u.id,
      id: u.id,
      username: u.username,
      avatar: u.avatar_url,
      avatar_url: u.avatar_url,
    },
  };
};

const resolveChapterId = async (chapterId) => {
  if (!chapterId) return null;
  if (UUID_RE.test(chapterId)) return chapterId;
  const { data } = await supabase.from("chapters").select("id").eq("legacy_appwrite_id", chapterId).maybeSingle();
  return data?.id || null;
};

export const getBookChapterComments = async ({ bookChapterId }) => {
  const chapterUuid = await resolveChapterId(bookChapterId);
  if (!chapterUuid) return { documents: [] };
  const { data, error } = await supabase
    .from("chapter_comments")
    .select(COMMENT_SELECT)
    .eq("chapter_id", chapterUuid)
    .is("parent_id", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return { documents: (data || []).map(mapRow) };
};

export const fetchBookChapterComments = async ({ bookChapterId, lastId, limit = 20 }) => {
  const chapterUuid = await resolveChapterId(bookChapterId);
  if (!chapterUuid) return { documents: [] };
  let q = supabase
    .from("chapter_comments")
    .select(COMMENT_SELECT)
    .eq("chapter_id", chapterUuid)
    .is("parent_id", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (lastId) {
    const { data: cursor } = await supabase
      .from("chapter_comments")
      .select("created_at")
      .eq(UUID_RE.test(lastId) ? "id" : "legacy_appwrite_id", lastId)
      .maybeSingle();
    if (cursor?.created_at) q = q.lt("created_at", cursor.created_at);
  }
  const { data, error } = await q;
  if (error) throw error;
  return { documents: (data || []).map(mapRow) };
};

export const createBookChapterComment = async ({ bookChapterId, comment, commentOwner, parentId }) => {
  const chapterUuid = await resolveChapterId(bookChapterId);
  const userUuid = await resolveSupabaseUserId(commentOwner);
  if (!chapterUuid || !userUuid) throw new Error("createBookChapterComment: missing chapter or user");
  const { data, error } = await supabase
    .from("chapter_comments")
    .insert({ chapter_id: chapterUuid, user_id: userUuid, content: comment, parent_id: parentId || null })
    .select(COMMENT_SELECT)
    .maybeSingle();
  if (error) throw error;
  return mapRow(data);
};

// Replies via parent_id
export const fetchChapterCommentReplies = async ({ commentId }) => {
  if (!commentId) return { documents: [] };
  const { data, error } = await supabase
    .from("chapter_comments")
    .select(COMMENT_SELECT)
    .eq("parent_id", commentId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return { documents: (data || []).map(mapRow) };
};

// Likes
export const likeChapterComment = async ({ commentId, likeOwner }) => {
  const userUuid = await resolveSupabaseUserId(likeOwner);
  if (!userUuid || !commentId) return null;
  const { error } = await supabase
    .from("chapter_comment_likes")
    .insert({ comment_id: commentId, user_id: userUuid });
  if (error && error.code !== "23505") throw error;
  return { $id: `${commentId}::${userUuid}` };
};

export const unlikeChapterComment = async ({ commentId, likeOwner }) => {
  const userUuid = await resolveSupabaseUserId(likeOwner);
  if (!userUuid || !commentId) return;
  const { error } = await supabase
    .from("chapter_comment_likes")
    .delete()
    .eq("comment_id", commentId)
    .eq("user_id", userUuid);
  if (error) throw error;
};

export const isChapterCommentLiked = async ({ commentId, userId }) => {
  const userUuid = await resolveSupabaseUserId(userId);
  if (!userUuid || !commentId) return false;
  const { data } = await supabase
    .from("chapter_comment_likes")
    .select("comment_id")
    .eq("comment_id", commentId)
    .eq("user_id", userUuid)
    .maybeSingle();
  return !!data;
};

export const deleteBookChapterComment = async ({ commentId }) => {
  if (!commentId) return;
  const isUuid = UUID_RE.test(commentId);
  const column = isUuid ? "id" : "legacy_appwrite_id";
  const { error } = await supabase.from("chapter_comments").delete().eq(column, commentId);
  if (error) throw error;
};

// ─────────────────────────────────────────────────────────────────────────
// Appwrite-compat aliases — match legacy BookChapterCommentsService method
// names so BookChapterCommentItem.jsx works unchanged when the
// USE_SUPABASE_BOOKS flag flips on.
// ─────────────────────────────────────────────────────────────────────────

// likeComment({ userId, commentId }) — Appwrite shape, maps to likeChapterComment
export const likeComment = ({ userId, commentId }) =>
  likeChapterComment({ commentId, likeOwner: userId });

// removeLikeComment({ userId, commentId }) — maps to unlikeChapterComment
export const removeLikeComment = ({ userId, commentId }) =>
  unlikeChapterComment({ commentId, likeOwner: userId });
