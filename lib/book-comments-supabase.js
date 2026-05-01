// Supabase-flavored book comments — drop-in for lib/book-comments.js.
// Uses the new book_comments + book_comment_likes tables created by
// migration_books_engagement.sql. Comments and replies share the same
// table (parent_id IS NULL = top-level, parent_id IS NOT NULL = reply).

import supabase from "./supabase";
import { resolveSupabaseUserId } from "./posts-supabase";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMENT_SELECT = `
  id, book_id, user_id, content, parent_id, likes_count, replies_count,
  legacy_appwrite_id, created_at, updated_at,
  profiles!book_comments_user_id_fkey ( id, username, avatar_url, legacy_appwrite_id )
`;

const mapRow = (row) => {
  if (!row) return null;
  const u = row.profiles || {};
  return {
    id: row.id,
    book_id: row.book_id,
    user_id: row.user_id,
    content: row.content,
    parent_id: row.parent_id,
    likes_count: row.likes_count,
    replies_count: row.replies_count,
    created_at: row.created_at,
    legacy_appwrite_id: row.legacy_appwrite_id,
    // Appwrite-shaped legacy aliases
    $id: row.legacy_appwrite_id || row.id,
    $createdAt: row.created_at,
    book: row.book_id,
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

// Resolve a book id (Appwrite hex or Supabase UUID) to a Supabase UUID.
const resolveBookId = async (bookId) => {
  if (!bookId) return null;
  if (UUID_RE.test(bookId)) return bookId;
  const { data } = await supabase.from("books").select("id").eq("legacy_appwrite_id", bookId).maybeSingle();
  return data?.id || null;
};

export const getBookComments = async ({ bookId }) => {
  const bookUuid = await resolveBookId(bookId);
  if (!bookUuid) return { documents: [] };
  const { data, error } = await supabase
    .from("book_comments")
    .select(COMMENT_SELECT)
    .eq("book_id", bookUuid)
    .is("parent_id", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return { documents: (data || []).map(mapRow) };
};

export const fetchBookComments = async ({ bookId, lastId, limit = 20 }) => {
  const bookUuid = await resolveBookId(bookId);
  if (!bookUuid) return { documents: [] };
  let q = supabase
    .from("book_comments")
    .select(COMMENT_SELECT)
    .eq("book_id", bookUuid)
    .is("parent_id", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (lastId) {
    const { data: cursor } = await supabase
      .from("book_comments")
      .select("created_at")
      .eq(UUID_RE.test(lastId) ? "id" : "legacy_appwrite_id", lastId)
      .maybeSingle();
    if (cursor?.created_at) q = q.lt("created_at", cursor.created_at);
  }
  const { data, error } = await q;
  if (error) throw error;
  return { documents: (data || []).map(mapRow) };
};

export const createBookComment = async ({ bookId, comment, commentOwner, parentId }) => {
  const bookUuid = await resolveBookId(bookId);
  const userUuid = await resolveSupabaseUserId(commentOwner);
  if (!bookUuid || !userUuid) throw new Error("createBookComment: missing book or user");
  const { data, error } = await supabase
    .from("book_comments")
    .insert({ book_id: bookUuid, user_id: userUuid, content: comment, parent_id: parentId || null })
    .select(COMMENT_SELECT)
    .maybeSingle();
  if (error) throw error;
  return mapRow(data);
};

// Replies — same table, different parent_id filter.
export const fetchBookCommentReplies = async ({ commentId }) => {
  if (!commentId) return { documents: [] };
  const { data, error } = await supabase
    .from("book_comments")
    .select(COMMENT_SELECT)
    .eq("parent_id", commentId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return { documents: (data || []).map(mapRow) };
};

// Likes
export const likeBookComment = async ({ commentId, likeOwner }) => {
  const userUuid = await resolveSupabaseUserId(likeOwner);
  if (!userUuid || !commentId) return null;
  const { error } = await supabase
    .from("book_comment_likes")
    .insert({ comment_id: commentId, user_id: userUuid });
  if (error && error.code !== "23505") throw error;
  return { $id: `${commentId}::${userUuid}` };
};

export const unlikeBookComment = async ({ commentId, likeOwner }) => {
  const userUuid = await resolveSupabaseUserId(likeOwner);
  if (!userUuid || !commentId) return;
  const { error } = await supabase
    .from("book_comment_likes")
    .delete()
    .eq("comment_id", commentId)
    .eq("user_id", userUuid);
  if (error) throw error;
};

export const isBookCommentLiked = async ({ commentId, userId }) => {
  const userUuid = await resolveSupabaseUserId(userId);
  if (!userUuid || !commentId) return false;
  const { data } = await supabase
    .from("book_comment_likes")
    .select("comment_id")
    .eq("comment_id", commentId)
    .eq("user_id", userUuid)
    .maybeSingle();
  return !!data;
};

export const deleteBookComment = async ({ commentId }) => {
  if (!commentId) return;
  const isUuid = UUID_RE.test(commentId);
  const column = isUuid ? "id" : "legacy_appwrite_id";
  const { error } = await supabase.from("book_comments").delete().eq(column, commentId);
  if (error) throw error;
};

// ─────────────────────────────────────────────────────────────────────────
// Appwrite-compat aliases
// ─────────────────────────────────────────────────────────────────────────
// Match the legacy BookCommentsService method names so consumer screens
// (BookCommentItem, BookCommentModal, BookChapterCommentModal) work
// unchanged when USE_SUPABASE_BOOKS flips on. Each is a thin wrapper that
// adapts the arg shape to the Supabase-native helper.

// likeComment({ userId, commentId }) — Appwrite shape, maps to likeBookComment
export const likeComment = ({ userId, commentId }) =>
  likeBookComment({ commentId, likeOwner: userId });

// removeLikeComment({ userId, commentId }) — maps to unlikeBookComment
export const removeLikeComment = ({ userId, commentId }) =>
  unlikeBookComment({ commentId, likeOwner: userId });

// createReplyComment({ comment, commentOwner, bookComment }) — Appwrite
// version stored replies in a separate booksCommentRepliesCollection;
// Supabase keeps replies in the same book_comments table with parent_id.
// We look up the parent's book_id (so we can satisfy the NOT NULL constraint
// on book_comments.book_id) and insert the reply under it.
export const createReplyComment = async ({ comment, commentOwner, bookComment }) => {
  if (!comment || !commentOwner || !bookComment) {
    console.warn("createReplyComment: missing required params:", { comment, commentOwner, bookComment });
    return null;
  }
  // Resolve the parent comment to its UUID + book_id. Accept either Appwrite
  // hex (legacy) or Supabase UUID for bookComment.
  const isUuid = UUID_RE.test(bookComment);
  const column = isUuid ? "id" : "legacy_appwrite_id";
  const { data: parent, error: parentErr } = await supabase
    .from("book_comments")
    .select("id, book_id")
    .eq(column, bookComment)
    .maybeSingle();
  if (parentErr) {
    console.error("createReplyComment: parent lookup error", parentErr.message);
    return null;
  }
  if (!parent?.book_id) {
    console.warn("createReplyComment: parent comment not found:", bookComment);
    return null;
  }
  return createBookComment({
    bookId: parent.book_id,
    comment,
    commentOwner,
    parentId: parent.id, // use the resolved UUID as parent_id
  });
};

// createReplyChapterComment({ comment, commentOwner, bookChapterComment }) —
// Appwrite version stored chapter-comment replies in
// booksChaptersCommentRepliesCollection (separate from chapter_comments).
// Supabase consolidates everything in chapter_comments using parent_id.
//
// This function lives on BookCommentsService (not BookChapterCommentsService)
// because that's where the legacy mobile code calls it from
// (components/BookChapterCommentModal.jsx). We could relocate later, but for
// the migration the goal is dropping it where consumers expect it.
export const createReplyChapterComment = async ({ comment, commentOwner, bookChapterComment }) => {
  if (!comment || !commentOwner || !bookChapterComment) {
    console.warn("createReplyChapterComment: missing required params:", { comment, commentOwner, bookChapterComment });
    return null;
  }
  // Resolve the parent chapter comment to its UUID + chapter_id.
  const isUuid = UUID_RE.test(bookChapterComment);
  const column = isUuid ? "id" : "legacy_appwrite_id";
  const { data: parent, error: parentErr } = await supabase
    .from("chapter_comments")
    .select("id, chapter_id")
    .eq(column, bookChapterComment)
    .maybeSingle();
  if (parentErr) {
    console.error("createReplyChapterComment: parent lookup error", parentErr.message);
    return null;
  }
  if (!parent?.chapter_id) {
    console.warn("createReplyChapterComment: parent chapter comment not found:", bookChapterComment);
    return null;
  }
  // Resolve the comment owner — accept either Appwrite hex or Supabase UUID.
  const userUuid = await resolveSupabaseUserId(commentOwner);
  if (!userUuid) {
    console.warn("createReplyChapterComment: couldn't resolve comment owner:", commentOwner);
    return null;
  }
  // Insert directly — we have all the IDs already, no need to roundtrip
  // through book-chapter-comments-supabase's createBookChapterComment.
  const { data, error } = await supabase
    .from("chapter_comments")
    .insert({
      chapter_id: parent.chapter_id,
      user_id: userUuid,
      content: comment,
      parent_id: parent.id, // resolved UUID
    })
    .select()
    .maybeSingle();
  if (error) {
    console.error("createReplyChapterComment: insert error", error.message);
    return null;
  }
  return data;
};
