// Supabase-flavored BookService — drop-in replacement for the main
// BookService class in lib/books.js during the Appwrite → Supabase
// migration. Mirrors the legacy API surface so consumers (book-info,
// BookLibraryCard, BookChapterFooter, etc.) keep importing from
// lib/books with no changes.
//
// Schema:
//   books            (29 columns — id, author_id, title, description,
//                     cover_url, genre, tags[], status, is_public,
//                     views_count, likes_count, chapters_count,
//                     word_count, created_at, updated_at, published_at,
//                     legacy_appwrite_id, is_hidden, is_editors_pick,
//                     trending_score, ratings_count, ratings_avg, etc.)
//   chapters         (16 columns — id, book_id, chapter_number, title,
//                     content, word_count, views_count, is_published,
//                     created_at, updated_at, legacy_appwrite_id,
//                     cover_url, scheduled_publish_at, is_locked,
//                     unlock_cost_coins, unlock_cost_stars)
//   book_likes       (composite PK: book_id, user_id)
//   book_bookmarks   (composite PK: user_id, book_id)
//   book_reads       (user_id, book_id, last_chapter_id,
//                     last_chapter_number, progress_pct, last_read_at)
//   book_comments    (id, book_id, user_id, content, parent_id,
//                     likes_count, replies_count, created_at)
//   chapter_comments (id, chapter_id, user_id, content, parent_id,
//                     likes_count, replies_count, created_at)
//
// Pre-flight: run Selebox/migration_books_engagement.sql before
// flipping USE_SUPABASE_BOOKS=true. That migration creates
// book_comments, book_comment_likes, chapter_comment_likes,
// chapter_inline_comments + threads + likes, book_ratings,
// book_downloads, book_ranking_history — all the engagement tables
// the leaf book*-supabase.js files depend on.
//
// ID resolution:
//   Methods accept either Supabase UUIDs or Appwrite hex IDs. The
//   detector (UUID_RE) routes to id vs legacy_appwrite_id columns.

import supabase from "./supabase";
import { resolveSupabaseUserId } from "./posts-supabase";
import { createTtlCache } from "./utils/createTtlCache";
import logger from "./utils/logger";

// Caches — same TTL + size as the legacy version so the perf profile
// matches.
const BOOK_CACHE = createTtlCache({ ttlMs: 30 * 1000, maxEntries: 200 });
const BOOK_CHAPTER_CACHE = createTtlCache({ ttlMs: 30 * 1000, maxEntries: 200 });

export const invalidateBookCache = (bookId) => {
  if (bookId) BOOK_CACHE.delete(bookId);
};
export const invalidateBookChapterCache = (chapterId) => {
  if (chapterId) BOOK_CHAPTER_CACHE.delete(chapterId);
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Map a Supabase books row + author profile join into the
// Appwrite-shaped document the legacy UI expects ($id, uploader, etc.).
const mapRowToBook = (row) => {
  if (!row) return null;
  const author = row.profiles || row.author || {};
  return {
    // Native Supabase fields
    id: row.id,
    title: row.title,
    description: row.description,
    cover_url: row.cover_url,
    genre: row.genre,
    tags: row.tags || [],
    status: row.status,
    is_public: row.is_public,
    views_count: row.views_count ?? 0,
    likes_count: row.likes_count ?? 0,
    chapters_count: row.chapters_count ?? 0,
    word_count: row.word_count ?? 0,
    ratings_count: row.ratings_count ?? 0,
    ratings_avg: row.ratings_avg ?? 0,
    trending_score: row.trending_score ?? 0,
    is_editors_pick: row.is_editors_pick ?? false,
    lock_from_chapter: row.lock_from_chapter,
    locked_at: row.locked_at,
    is_hidden: row.is_hidden ?? false,
    legacy_appwrite_id: row.legacy_appwrite_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,

    // Appwrite-shaped legacy aliases — every consumer that reads
    // .$id / .title / .synopsis / .thumbnail / .uploader keeps working.
    $id: row.legacy_appwrite_id || row.id,
    $createdAt: row.created_at,
    $updatedAt: row.updated_at,
    synopsis: row.description,        // legacy field name
    thumbnail: row.cover_url,         // legacy field name
    uploader: {
      $id: author.legacy_appwrite_id || author.id,
      id: author.id,
      username: author.username,
      avatar: author.avatar_url,
      avatar_url: author.avatar_url,
      legacy_appwrite_id: author.legacy_appwrite_id,
    },
    // Engagement counter aliases — Appwrite consumers (BooksDiscover,
    // BooksRanking, BookCard, BookCatalogCard) read these names. Each
    // points at the corresponding denormalized column on `books`, kept
    // fresh by triggers from the engagement migration.
    totalReads: row.views_count ?? 0,
    reads: row.views_count ?? 0,
    monthlyReads: row.views_count ?? 0,   // no monthly column today; same denominator
    totalLikes: row.likes_count ?? 0,
    likes: row.likes_count ?? 0,
    chaptersTotal: row.chapters_count ?? 0,
    averageRating: row.ratings_avg ?? 0,
    rating: row.ratings_avg ?? 0,
    // Author/owner aliases — different surfaces use different names for
    // the same person. uploader (canonical), bookOwner (search results),
    // author (BooksDiscover dedupe key).
    bookOwner: {
      $id: author.legacy_appwrite_id || author.id,
      id: author.id,
      username: author.username,
      avatar: author.avatar_url,
    },
    author: author.legacy_appwrite_id || author.id,
    // Paywall — book is "locked" / "Paid" when lock_from_chapter is set
    // (matches Selebox web's `(book.lock_from_chapter || 0) > 0` check).
    // The per-book chapter-start threshold is exposed as bookChapterLockStart
    // so isChapterLocked can prefer the per-book value over the global
    // BOOKS_CHAPTER_LOCK_START app-config setting.
    isLocked: (row.lock_from_chapter || 0) > 0,
    bookChapterLockStart: row.lock_from_chapter || null,
    // Legacy contentRating field — Appwrite stored it on the book; not in
    // Supabase schema yet. Default to "PG" so the consumer fallback chain
    // doesn't render `undefined`.
    contentRating: row.content_rating || "Rated PG",
  };
};

// Map a chapters row into the Appwrite-shaped doc.
const mapRowToChapter = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    book_id: row.book_id,
    chapter_number: row.chapter_number,
    title: row.title,
    content: row.content,
    word_count: row.word_count,
    views_count: row.views_count,
    is_published: row.is_published,
    is_locked: row.is_locked,
    unlock_cost_coins: row.unlock_cost_coins,
    unlock_cost_stars: row.unlock_cost_stars,
    cover_url: row.cover_url,
    scheduled_publish_at: row.scheduled_publish_at,
    legacy_appwrite_id: row.legacy_appwrite_id,
    created_at: row.created_at,
    updated_at: row.updated_at,

    // Legacy aliases — match Appwrite-shaped fields the renderers read.
    $id: row.legacy_appwrite_id || row.id,
    $createdAt: row.created_at,
    $updatedAt: row.updated_at,
    updatedAt: row.updated_at,        // BookChapterCommentItem reads chapter.updatedAt
    book: row.book_id,
    order: row.chapter_number,        // legacy used `order` for chapter position
    thumbnail: row.cover_url,
    status: row.is_published ? "Published" : "Draft",
    // isLocked at the chapter level — Appwrite consumers read both
    // `chapter.is_locked` (Supabase shape) and `chapter.isLocked` (legacy
    // shape) depending on the screen. Set both for safety.
    isLocked: !!row.is_locked,
  };
};

const BOOK_SELECT = `
  id, title, description, cover_url, genre, tags, status, is_public,
  views_count, likes_count, chapters_count, word_count,
  ratings_count, ratings_avg, trending_score, is_editors_pick,
  lock_from_chapter, locked_at, is_hidden, legacy_appwrite_id,
  created_at, updated_at, published_at, author_id,
  profiles!books_author_id_fkey ( id, username, avatar_url, legacy_appwrite_id )
`;

const CHAPTER_SELECT = `
  id, book_id, chapter_number, title, content, word_count, views_count,
  is_published, is_locked, unlock_cost_coins, unlock_cost_stars,
  cover_url, scheduled_publish_at, legacy_appwrite_id,
  created_at, updated_at
`;

// ════════════════════════════════════════════════════════════════════════════
// Pure helper re-exports — backend-agnostic, kept on the Appwrite side.
// ════════════════════════════════════════════════════════════════════════════
export const initialBookForm = {
  thumbnail: "",
  title: "",
  synopsis: "",
  uploader: "",
  tags: [],
  status: "Draft",
};

export const initialChapterForm = {
  thumbnail: "",
  title: "",
  content: "",
};

export const INTRODUCTION_ORDER = 0;

export const getBookChapterOrder = (chapter, index = 0) => {
  const parsedOrder = Number(chapter?.order ?? chapter?.chapter_number);
  if (Number.isFinite(parsedOrder) && parsedOrder >= 0) return parsedOrder;
  return index + 1;
};

export const sortBookChaptersByOrder = (chapters = []) =>
  [...chapters].sort((a, b) => getBookChapterOrder(a) - getBookChapterOrder(b));

export const isIntroductionChapter = (chapter, index = 0) =>
  getBookChapterOrder(chapter, index) === INTRODUCTION_ORDER;

export const getNextNumberedBookChapterOrder = (chapters = []) => {
  const numbered = (chapters || [])
    .map((chapter, index) => getBookChapterOrder(chapter, index))
    .filter((order) => order > INTRODUCTION_ORDER);
  return numbered.length === 0 ? 1 : Math.max(...numbered) + 1;
};

export const getNextBookChapterOrder = (chapters = []) => {
  if (!Array.isArray(chapters) || chapters.length === 0) return INTRODUCTION_ORDER;
  if (!chapters.some((chapter, index) => isIntroductionChapter(chapter, index))) return INTRODUCTION_ORDER;
  return getNextNumberedBookChapterOrder(chapters);
};

export const getBookChapterSectionLabel = (chapter, index = 0) =>
  isIntroductionChapter(chapter, index) ? "Introduction" : `Chapter ${getBookChapterOrder(chapter, index)}`;

export const BOOK_CHAPTER_LIST_SELECT = ["id", "created_at", "updated_at", "title", "cover_url", "chapter_number", "is_published"];


// ════════════════════════════════════════════════════════════════════════════
// BookService — Supabase implementation
// ════════════════════════════════════════════════════════════════════════════

export class BookServiceSupabase {
  // Image uploads → Bunny CDN — proxy to legacy. Bunny isn't migrating.
  async uploadBookImage(...args) {
    const { BookService: legacy } = await import("./books-appwrite");
    return new legacy().uploadBookImage(...args);
  }
  async uploadCover(...args) {
    const { BookService: legacy } = await import("./books-appwrite");
    return new legacy().uploadCover(...args);
  }
  async uploadChapterInlineImage(...args) {
    const { BookService: legacy } = await import("./books-appwrite");
    return new legacy().uploadChapterInlineImage(...args);
  }

  // ── Book CRUD ──
  async createNewBook({ title, synopsis, thumbnail, uploader, tags, genre, status, ...props }) {
    const authorUuid = await resolveSupabaseUserId(uploader);
    if (!authorUuid) throw new Error("createNewBook: cannot resolve uploader");
    const { data, error } = await supabase
      .from("books")
      .insert({
        title,
        description: synopsis,
        cover_url: thumbnail,
        author_id: authorUuid,
        tags: tags || [],
        genre,
        status: status || "Draft",
        is_public: status === "Published",
        ...props,
      })
      .select(BOOK_SELECT)
      .maybeSingle();
    if (error) throw error;
    return mapRowToBook(data);
  }

  async updateBook({ ID, synopsis, thumbnail, ...props }) {
    if (!ID) throw new Error("updateBook: ID required");
    const isUuid = UUID_RE.test(ID);
    const column = isUuid ? "id" : "legacy_appwrite_id";

    // Translate legacy field names to Supabase columns.
    const patch = { ...props };
    if (synopsis !== undefined) patch.description = synopsis;
    if (thumbnail !== undefined) patch.cover_url = thumbnail;

    const { data, error } = await supabase
      .from("books")
      .update(patch)
      .eq(column, ID)
      .select(BOOK_SELECT)
      .maybeSingle();
    if (error) throw error;
    invalidateBookCache(ID);
    return mapRowToBook(data);
  }

  async deleteBook({ ID }) {
    if (!ID) throw new Error("deleteBook: ID required");
    const isUuid = UUID_RE.test(ID);
    const column = isUuid ? "id" : "legacy_appwrite_id";
    const { error } = await supabase.from("books").delete().eq(column, ID);
    if (error) throw error;
    invalidateBookCache(ID);
  }

  // ── Chapter CRUD ──
  async createNewBookChapter({ title, content, thumbnail, bookId, status, order, ...props }) {
    const isUuid = UUID_RE.test(bookId);
    let bookUuid = isUuid ? bookId : null;
    if (!isUuid) {
      const { data: bookRow } = await supabase
        .from("books")
        .select("id")
        .eq("legacy_appwrite_id", bookId)
        .maybeSingle();
      bookUuid = bookRow?.id || null;
    }
    if (!bookUuid) throw new Error("createNewBookChapter: cannot resolve bookId");

    const { data, error } = await supabase
      .from("chapters")
      .insert({
        book_id: bookUuid,
        title,
        content,
        cover_url: thumbnail,
        chapter_number: order,
        is_published: status === "Published",
        ...props,
      })
      .select(CHAPTER_SELECT)
      .maybeSingle();
    if (error) throw error;
    return mapRowToChapter(data);
  }

  async updateBookChapter({ ID, status, thumbnail, order, ...props }) {
    if (!ID) throw new Error("updateBookChapter: ID required");
    const isUuid = UUID_RE.test(ID);
    const column = isUuid ? "id" : "legacy_appwrite_id";

    const patch = { ...props };
    if (status !== undefined) patch.is_published = status === "Published";
    if (thumbnail !== undefined) patch.cover_url = thumbnail;
    if (order !== undefined) patch.chapter_number = order;

    const { data, error } = await supabase
      .from("chapters")
      .update(patch)
      .eq(column, ID)
      .select(CHAPTER_SELECT)
      .maybeSingle();
    if (error) throw error;
    invalidateBookChapterCache(ID);
    return mapRowToChapter(data);
  }

  async deleteBookChapter({ ID }) {
    if (!ID) throw new Error("deleteBookChapter: ID required");
    const isUuid = UUID_RE.test(ID);
    const column = isUuid ? "id" : "legacy_appwrite_id";
    const { error } = await supabase.from("chapters").delete().eq(column, ID);
    if (error) throw error;
    invalidateBookChapterCache(ID);
  }

  // ── Book reads (lists) ──
  async fetchBooks({ userId, lastId, category, limit = 20, status }) {
    let q = supabase.from("books").select(BOOK_SELECT, { count: "exact" });

    if (userId) {
      const ids = Array.isArray(userId) ? userId : [userId];
      const resolved = await Promise.all(
        ids.map((id) => (UUID_RE.test(id) ? id : resolveSupabaseUserId(id))),
      );
      const uuidIds = resolved.filter(Boolean);
      if (uuidIds.length > 0) q = q.in("author_id", uuidIds);
    }

    if (category) q = q.contains("tags", [category]);

    if (status) {
      if (Array.isArray(status)) {
        q = q.in("status", status);
      } else {
        q = q.eq("status", status);
      }
    }

    q = q.order("created_at", { ascending: false }).limit(limit);
    if (lastId) {
      const { data: cursorRow } = await supabase
        .from("books")
        .select("created_at")
        .eq(UUID_RE.test(lastId) ? "id" : "legacy_appwrite_id", lastId)
        .maybeSingle();
      if (cursorRow?.created_at) q = q.lt("created_at", cursorRow.created_at);
    }

    const { data, error, count } = await q;
    if (error) throw error;
    return { documents: (data || []).map(mapRowToBook), total: count ?? 0 };
  }

  async fetchPublishedBooks({ category, lastId, status, limit = 100 }) {
    return this.fetchBooks({
      category,
      lastId,
      status: status || "Published",
      limit,
    });
  }

  async fetchDiscoverPool({ limit = 500 } = {}) {
    const PAGE = 100;
    const safeTotal = Math.max(PAGE, Math.floor(Number(limit)) || 500);
    const documents = [];
    const seen = new Set();
    let lastId;

    while (documents.length < safeTotal) {
      const remaining = safeTotal - documents.length;
      const pageLimit = Math.min(PAGE, remaining);
      const res = await this.fetchPublishedBooks({ limit: pageLimit, lastId });
      const page = res?.documents || [];
      if (page.length === 0) break;
      for (const doc of page) {
        if (!doc?.id || seen.has(doc.id)) continue;
        seen.add(doc.id);
        documents.push(doc);
      }
      lastId = page[page.length - 1]?.id;
      if (page.length < pageLimit || !lastId) break;
    }
    return documents;
  }

  async fetchBookChapters({ bookId, lastId, status, limit = 100, select } = {}) {
    if (!bookId) return { documents: [], total: 0 };
    const isUuid = UUID_RE.test(bookId);
    let bookUuid = isUuid ? bookId : null;
    if (!isUuid) {
      const { data: bookRow } = await supabase
        .from("books")
        .select("id")
        .eq("legacy_appwrite_id", bookId)
        .maybeSingle();
      bookUuid = bookRow?.id || null;
    }
    if (!bookUuid) return { documents: [], total: 0 };

    const pageLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
    let q = supabase
      .from("chapters")
      .select(CHAPTER_SELECT, { count: "exact" })
      .eq("book_id", bookUuid)
      .order("chapter_number", { ascending: true })
      .limit(pageLimit);

    if (status) {
      const wantsPublished = String(status).toLowerCase() === "published";
      q = q.eq("is_published", wantsPublished);
    }
    if (lastId) {
      const { data: cursorRow } = await supabase
        .from("chapters")
        .select("chapter_number")
        .eq(UUID_RE.test(lastId) ? "id" : "legacy_appwrite_id", lastId)
        .maybeSingle();
      if (cursorRow?.chapter_number != null) q = q.gt("chapter_number", cursorRow.chapter_number);
    }

    const { data, error, count } = await q;
    if (error) throw error;
    return { documents: (data || []).map(mapRowToChapter), total: count ?? 0 };
  }

  async fetchAllBookChapters({ bookId, status, limit = 100, select } = {}) {
    const pageLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
    const documents = [];
    const seenIds = new Set();
    let lastId;
    let total = 0;

    while (true) {
      const response = await this.fetchBookChapters({ bookId, status, limit: pageLimit, lastId, select });
      const pageDocuments = response?.documents || [];
      total = Math.max(total, response?.total || 0);
      if (!pageDocuments.length) break;

      let added = 0;
      for (const ch of pageDocuments) {
        if (!ch?.id || seenIds.has(ch.id)) continue;
        seenIds.add(ch.id);
        documents.push(ch);
        added += 1;
      }
      const next = pageDocuments[pageDocuments.length - 1]?.id;
      if (!next || next === lastId || added === 0 || pageDocuments.length < pageLimit) break;
      lastId = next;
    }
    return { documents, total: Math.max(total, documents.length) };
  }

  async fetchBook({ bookId }) {
    if (!bookId) return null;
    const cached = BOOK_CACHE.get(bookId);
    if (cached) return cached;

    const isUuid = UUID_RE.test(bookId);
    const column = isUuid ? "id" : "legacy_appwrite_id";
    const { data, error } = await supabase.from("books").select(BOOK_SELECT).eq(column, bookId).maybeSingle();
    if (error) throw error;
    const mapped = mapRowToBook(data);
    if (mapped) BOOK_CACHE.set(bookId, mapped);
    return mapped;
  }

  async fetchBookChapter({ chapterId }) {
    if (!chapterId) return null;
    const cached = BOOK_CHAPTER_CACHE.get(chapterId);
    if (cached) return cached;

    const isUuid = UUID_RE.test(chapterId);
    const column = isUuid ? "id" : "legacy_appwrite_id";
    const { data, error } = await supabase.from("chapters").select(CHAPTER_SELECT).eq(column, chapterId).maybeSingle();
    if (error) throw error;
    const mapped = mapRowToChapter(data);
    if (mapped) BOOK_CHAPTER_CACHE.set(chapterId, mapped);
    return mapped;
  }

  // ── Library / bookmarks (legacy called this "bookLibrary") ──
  async fetchBookLibraryByUser({ userId, lastId, limit = 20 }) {
    if (!userId) return { documents: [] };
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) return { documents: [] };

    let q = supabase
      .from("book_bookmarks")
      .select(`book_id, created_at, books ( ${BOOK_SELECT.replace(/profiles!.+$/, '').trim().replace(/,$/, '')} )`)
      .eq("user_id", userUuid)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (lastId) {
      const { data: cursorRow } = await supabase
        .from("book_bookmarks")
        .select("created_at")
        .eq("user_id", userUuid)
        .eq("book_id", lastId)
        .maybeSingle();
      if (cursorRow?.created_at) q = q.lt("created_at", cursorRow.created_at);
    }
    const { data, error } = await q;
    if (error) throw error;
    const documents = (data || []).map((row) => ({
      $id: `${userUuid}::${row.book_id}`,
      book: mapRowToBook(row.books),
      $createdAt: row.created_at,
    }));
    return { documents };
  }

  // ── Likes (book_likes) ──
  async getBookLikes({ bookId }) {
    if (!bookId) return { documents: [] };
    const isUuid = UUID_RE.test(bookId);
    let bookUuid = bookId;
    if (!isUuid) {
      const { data: bookRow } = await supabase.from("books").select("id").eq("legacy_appwrite_id", bookId).maybeSingle();
      bookUuid = bookRow?.id || null;
    }
    if (!bookUuid) return { documents: [] };
    const { data, error } = await supabase
      .from("book_likes")
      .select("book_id, user_id, created_at")
      .eq("book_id", bookUuid);
    if (error) throw error;
    return {
      documents: (data || []).map((row) => ({
        $id: `${row.book_id}::${row.user_id}`,
        book: row.book_id,
        likeOwner: row.user_id,
        $createdAt: row.created_at,
      })),
    };
  }

  async getBookLikeByOwner({ bookId, likeOwner }) {
    const userUuid = await resolveSupabaseUserId(likeOwner);
    if (!userUuid || !bookId) return { documents: [] };
    const isUuid = UUID_RE.test(bookId);
    let bookUuid = bookId;
    if (!isUuid) {
      const { data: bookRow } = await supabase.from("books").select("id").eq("legacy_appwrite_id", bookId).maybeSingle();
      bookUuid = bookRow?.id || null;
    }
    if (!bookUuid) return { documents: [] };
    const { data } = await supabase
      .from("book_likes")
      .select("book_id, user_id, created_at")
      .eq("book_id", bookUuid)
      .eq("user_id", userUuid)
      .maybeSingle();
    return data
      ? { documents: [{ $id: `${bookUuid}::${userUuid}`, book: bookUuid, likeOwner: userUuid }] }
      : { documents: [] };
  }

  async createBookLike({ bookId, likeOwner }) {
    const userUuid = await resolveSupabaseUserId(likeOwner);
    if (!userUuid) throw new Error("createBookLike: cannot resolve user");
    const isUuid = UUID_RE.test(bookId);
    let bookUuid = bookId;
    if (!isUuid) {
      const { data: bookRow } = await supabase.from("books").select("id").eq("legacy_appwrite_id", bookId).maybeSingle();
      bookUuid = bookRow?.id || null;
    }
    if (!bookUuid) throw new Error("createBookLike: cannot resolve book");
    const { error } = await supabase.from("book_likes").insert({ book_id: bookUuid, user_id: userUuid });
    if (error && error.code !== "23505") throw error;
    return { $id: `${bookUuid}::${userUuid}` };
  }

  async deleteBookLike({ bookLikeId }) {
    if (!bookLikeId) return;
    const [bookId, userId] = String(bookLikeId).split("::");
    if (!bookId || !userId) return;
    const { error } = await supabase
      .from("book_likes")
      .delete()
      .eq("book_id", bookId)
      .eq("user_id", userId);
    if (error) throw error;
  }

  // ── Bookmarks (book_bookmarks — what legacy called "library") ──
  async getBookLibraries({ bookId }) {
    if (!bookId) return { documents: [] };
    const isUuid = UUID_RE.test(bookId);
    let bookUuid = bookId;
    if (!isUuid) {
      const { data: bookRow } = await supabase.from("books").select("id").eq("legacy_appwrite_id", bookId).maybeSingle();
      bookUuid = bookRow?.id || null;
    }
    if (!bookUuid) return { documents: [] };
    const { data, error } = await supabase
      .from("book_bookmarks")
      .select("book_id, user_id, created_at")
      .eq("book_id", bookUuid);
    if (error) throw error;
    return {
      documents: (data || []).map((row) => ({
        $id: `${row.user_id}::${row.book_id}`,
        book: row.book_id,
        user: row.user_id,
        $createdAt: row.created_at,
      })),
    };
  }

  async getBookLibrayByUser({ bookId, userId }) {
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid || !bookId) return { documents: [] };
    const isUuid = UUID_RE.test(bookId);
    let bookUuid = bookId;
    if (!isUuid) {
      const { data: bookRow } = await supabase.from("books").select("id").eq("legacy_appwrite_id", bookId).maybeSingle();
      bookUuid = bookRow?.id || null;
    }
    if (!bookUuid) return { documents: [] };
    const { data } = await supabase
      .from("book_bookmarks")
      .select("book_id, user_id")
      .eq("book_id", bookUuid)
      .eq("user_id", userUuid)
      .maybeSingle();
    return data
      ? { documents: [{ $id: `${userUuid}::${bookUuid}`, book: bookUuid, user: userUuid }] }
      : { documents: [] };
  }

  async createBookLibrary({ bookId, userId }) {
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) throw new Error("createBookLibrary: cannot resolve user");
    const isUuid = UUID_RE.test(bookId);
    let bookUuid = bookId;
    if (!isUuid) {
      const { data: bookRow } = await supabase.from("books").select("id").eq("legacy_appwrite_id", bookId).maybeSingle();
      bookUuid = bookRow?.id || null;
    }
    if (!bookUuid) throw new Error("createBookLibrary: cannot resolve book");
    const { error } = await supabase.from("book_bookmarks").insert({ user_id: userUuid, book_id: bookUuid });
    if (error && error.code !== "23505") throw error;
    return { $id: `${userUuid}::${bookUuid}` };
  }

  async deleteBookLibrary({ bookLibraryId }) {
    if (!bookLibraryId) return;
    const [userId, bookId] = String(bookLibraryId).split("::");
    if (!userId || !bookId) return;
    const { error } = await supabase
      .from("book_bookmarks")
      .delete()
      .eq("user_id", userId)
      .eq("book_id", bookId);
    if (error) throw error;
  }

  // ── Search ──
  async searchBooks({ searchQuery = "", limit = 10, cursorId = null }) {
    if (!searchQuery) return { documents: [] };
    let q = supabase
      .from("books")
      .select(BOOK_SELECT)
      .ilike("title", `%${searchQuery}%`)
      .eq("is_public", true)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (cursorId) {
      const { data: cursorRow } = await supabase
        .from("books")
        .select("created_at")
        .eq(UUID_RE.test(cursorId) ? "id" : "legacy_appwrite_id", cursorId)
        .maybeSingle();
      if (cursorRow?.created_at) q = q.lt("created_at", cursorRow.created_at);
    }
    const { data, error } = await q;
    if (error) throw error;
    return { documents: (data || []).map(mapRowToBook) };
  }

  // ── Continue reading ──
  async fetchContinueReadingBooks({ userId }) {
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) return { documents: [] };
    const { data, error } = await supabase
      .from("book_reads")
      .select(`book_id, last_chapter_number, progress_pct, last_read_at, books ( ${BOOK_SELECT.split(",profiles")[0]} )`)
      .eq("user_id", userUuid)
      .order("last_read_at", { ascending: false })
      .limit(20);
    if (error) {
      logger.warn("books-supabase/fetchContinueReadingBooks", "fetch error", error);
      return { documents: [] };
    }
    return {
      documents: (data || [])
        .filter((row) => row.books)
        .map((row) => ({
          ...mapRowToBook(row.books),
          last_chapter_number: row.last_chapter_number,
          progress_pct: row.progress_pct,
          last_read_at: row.last_read_at,
        })),
    };
  }

  // ── Continue reading — single-book lookup (Appwrite-compat) ──
  // BookService.getContinueReadingBook({ userId, bookId }) — fetches the
  // user's saved progress for a specific book. Used by book-info.jsx to
  // show "Resume from chapter X" CTA. Returns null when the user hasn't
  // opened this book yet (matches Appwrite's "no progress doc" semantics).
  //
  // The Appwrite version returned a usersBookProgress document with
  // a `lastChapter` field; we surface the equivalent shape so the
  // consumer doesn't have to branch on backend.
  async getContinueReadingBook({ userId, bookId }) {
    if (!userId || !bookId) return null;
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) return null;
    // Resolve book id — accept Appwrite hex (legacy) or Supabase UUID.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookId);
    let bookUuid = bookId;
    if (!isUuid) {
      const { data: bookRow } = await supabase
        .from("books")
        .select("id")
        .eq("legacy_appwrite_id", bookId)
        .maybeSingle();
      if (!bookRow?.id) return null;
      bookUuid = bookRow.id;
    }
    const { data, error } = await supabase
      .from("book_reads")
      .select("user_id, book_id, last_chapter_id, last_chapter_number, progress_pct, last_read_at")
      .eq("user_id", userUuid)
      .eq("book_id", bookUuid)
      .maybeSingle();
    if (error) {
      logger.warn("books-supabase/getContinueReadingBook", "fetch error", error);
      return null;
    }
    if (!data) return null;
    // Appwrite-shaped fields the consumer reads (lastChapter is the most
    // important — book-info.jsx uses it to deep-link to that chapter).
    return {
      ...data,
      $id: `${data.user_id}:${data.book_id}`,
      user: data.user_id,
      book: data.book_id,
      lastChapter: data.last_chapter_id,
      lastChapterNumber: data.last_chapter_number,
      progressPct: data.progress_pct,
      lastReadAt: data.last_read_at,
    };
  }

  // ── Comments / chapter likes / chapter comments ──
  // These delegate to the leaf book-comments-supabase, book-chapter-comments-supabase
  // implementations (see those files). Here we keep the legacy API shape
  // and proxy through.
  async getBookComments(args) {
    const { getBookComments } = await import("./book-comments-supabase");
    return getBookComments(args);
  }
  async fetchBookComments(args) {
    const { fetchBookComments } = await import("./book-comments-supabase");
    return fetchBookComments(args);
  }
  async createBookComment(args) {
    const { createBookComment } = await import("./book-comments-supabase");
    return createBookComment(args);
  }
  async getBookChapterComments(args) {
    const { getBookChapterComments } = await import("./book-chapter-comments-supabase");
    return getBookChapterComments(args);
  }
  async fetchBookChapterComments(args) {
    const { fetchBookChapterComments } = await import("./book-chapter-comments-supabase");
    return fetchBookChapterComments(args);
  }
  async createBookChapterComment(args) {
    const { createBookChapterComment } = await import("./book-chapter-comments-supabase");
    return createBookChapterComment(args);
  }

  // Chapter likes — Supabase doesn't have a dedicated chapter_likes table
  // yet (see migration_books_engagement.sql notes). Proxy to legacy until
  // we add it. The book-level engagement is already on Supabase.
  async getBookChapterLikes(args) {
    const { BookService: legacy } = await import("./books-appwrite");
    return new legacy().getBookChapterLikes(args);
  }
  async getBookChapterLikeByOwner(args) {
    const { BookService: legacy } = await import("./books-appwrite");
    return new legacy().getBookChapterLikeByOwner(args);
  }
  async createBookChapterLike(args) {
    const { BookService: legacy } = await import("./books-appwrite");
    return new legacy().createBookChapterLike(args);
  }
  async deleteBookChapterLike(args) {
    const { BookService: legacy } = await import("./books-appwrite");
    return new legacy().deleteBookChapterLike(args);
  }
}
