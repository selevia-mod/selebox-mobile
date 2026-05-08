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

const resolveBookId = async (bookId) => {
  if (!bookId) return null;
  if (UUID_RE.test(bookId)) return bookId;
  const { data } = await supabase.from("books").select("id").eq("legacy_appwrite_id", bookId).maybeSingle();
  return data?.id || null;
};

// fetchBookAggregatedChapterComments — pull every top-level chapter
// comment across every chapter of a book in ONE query. Replaces the
// old book-level comments surface (book-info "Comments" section) per
// the May 2026 product call: writers/readers want to see all the
// engagement on a book in one place, not just comments dropped on the
// book's profile page (which barely got any traffic anyway).
//
// Each returned row is shaped like a regular chapter comment but adds
// a `chapter` decorator with the parent chapter's title + order +
// legacy id, so the UI can render a "From: Chapter 5" breadcrumb on
// each item and route taps back into book-reading.jsx at that chapter.
//
// Returns { documents, total } in the same shape as getBookChapterComments
// for drop-in compat with existing comment-list consumers.
export const fetchBookAggregatedChapterComments = async ({ bookId, limit = 50 } = {}) => {
  if (!bookId) return { documents: [], total: 0 };
  const bookUuid = await resolveBookId(bookId);
  if (!bookUuid) return { documents: [], total: 0 };

  // The !inner join makes this an INNER JOIN on chapters, and
  // .eq("chapters.book_id", ...) filters by the joined table's column.
  // Without !inner Supabase would do a LEFT join and return rows whose
  // chapter is null, which we then have to filter client-side.
  //
  // Important: the chapters table column is `chapter_number` — NOT
  // `order`. The mobile codebase aliases it to `order` in the JS-side
  // mapper (lib/books-supabase.js mapChapterRow at line 311), but the
  // raw column is `chapter_number`. An earlier version of this query
  // selected "order" and silently broke the whole aggregator.
  const { data, error } = await supabase
    .from("chapter_comments")
    .select(
      `
        id, chapter_id, user_id, content, parent_id, likes_count, replies_count,
        legacy_appwrite_id, created_at,
        profiles!chapter_comments_user_id_fkey ( id, username, avatar_url, legacy_appwrite_id ),
        chapters!inner ( id, legacy_appwrite_id, title, chapter_number, book_id )
      `,
    )
    .eq("chapters.book_id", bookUuid)
    .is("parent_id", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.warn("[book-chapter-comments] fetchBookAggregated failed:", error.message);
    return { documents: [], total: 0 };
  }

  const documents = (data || []).map((row) => {
    const base = mapRow(row);
    if (!base) return null;
    const ch = row.chapters || {};
    return {
      ...base,
      chapter: {
        // The shape book-reading consumes via params.chapterId is the
        // legacy id (when present) — preserves the routing semantics
        // book-info already uses for its other "open chapter" calls.
        $id: ch.legacy_appwrite_id || ch.id,
        id: ch.id,
        legacy_appwrite_id: ch.legacy_appwrite_id,
        title: ch.title || "",
        // Re-alias chapter_number → order so the modal's breadcrumb
        // ("Chapter 5 — <title>") works without each consumer needing
        // to know the underlying column name.
        order: Number.isFinite(Number(ch.chapter_number)) ? Number(ch.chapter_number) : null,
      },
    };
  }).filter(Boolean);

  return { documents, total: documents.length };
};

export const getBookChapterComments = async ({ bookChapterId }) => {
  // Always include `total` so consumers (BookChapterStats, etc.) can
  // safely read result.total for the count badge. Returning bare
  // `{ documents }` made FormatNumber crash on undefined post-flip.
  const chapterUuid = await resolveChapterId(bookChapterId);
  if (!chapterUuid) return { documents: [], total: 0 };
  const { data, error } = await supabase
    .from("chapter_comments")
    .select(COMMENT_SELECT)
    .eq("chapter_id", chapterUuid)
    .is("parent_id", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const documents = (data || []).map(mapRow);
  return { documents, total: documents.length };
};

export const fetchBookChapterComments = async ({ bookChapterId, lastId, limit = 20 }) => {
  const chapterUuid = await resolveChapterId(bookChapterId);
  if (!chapterUuid) return { documents: [], total: 0 };
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
  const documents = (data || []).map(mapRow);
  return { documents, total: documents.length };
};

// createReplyChapterComment({ comment, commentOwner, bookChapterComment })
//
// Insert a reply to an existing chapter_comments row. Resolves the
// parent's chapter_id automatically so callers only need the parent
// comment id.
//
// Originally lived on lib/book-comments-supabase.js (the now-retired
// book-level comments module) because the legacy mobile call site in
// BookChapterCommentModal happened to import from there. Moved here
// May 2026 as part of the book-comments cleanup — the function only
// touches chapter_comments and belongs alongside the rest of the
// chapter-comment surface.
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
  const userUuid = await resolveSupabaseUserId(commentOwner);
  if (!userUuid) {
    console.warn("createReplyChapterComment: couldn't resolve comment owner:", commentOwner);
    return null;
  }
  const { data, error } = await supabase
    .from("chapter_comments")
    .insert({
      chapter_id: parent.chapter_id,
      user_id: userUuid,
      content: comment,
      parent_id: parent.id,
    })
    .select()
    .maybeSingle();
  if (error) {
    console.error("createReplyChapterComment: insert error", error.message);
    return null;
  }
  return data;
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
  if (!commentId) return { documents: [], total: 0 };
  const { data, error } = await supabase
    .from("chapter_comments")
    .select(COMMENT_SELECT)
    .eq("parent_id", commentId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const documents = (data || []).map(mapRow);
  return { documents, total: documents.length };
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
