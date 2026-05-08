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
import { expandProfileRoleFlags } from "./user-roles";
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

// ─────────────────────────────────────────────────────────────────────────
// Internal id helpers — Supabase canonical UUIDs vs legacy Appwrite hex
// ─────────────────────────────────────────────────────────────────────────
//
// During the migration window every books / chapters row carries both
// `id` (uuid, source of truth) and `legacy_appwrite_id` (the original
// Appwrite document id, kept for cross-platform deep links + dual-write
// compatibility). Mobile call sites freely pass either form, so every
// service method that takes a bookId / chapterId / lastId has to
// branch on the shape.
//
// `idColumnFor(id)` answers "which column do I .eq() against?" and
// `resolveBookUuid` / `resolveChapterUuid` answer "give me the canonical
// UUID for this id, looking it up via legacy_appwrite_id if needed."
// Both shape lookups previously inlined a 4–5 line block at every call
// site (~7 places); the audit flagged it as a cleanup target.

const idColumnFor = (id) => (UUID_RE.test(String(id)) ? "id" : "legacy_appwrite_id");

/**
 * Resolve a book id (UUID or legacy Appwrite hex) to its canonical Supabase UUID.
 * Returns null if the id is missing or no row is found.
 *
 * @param {string|null|undefined} bookId
 * @returns {Promise<string|null>}
 */
const resolveBookUuid = async (bookId) => {
  if (!bookId) return null;
  if (UUID_RE.test(String(bookId))) return String(bookId);
  const { data } = await supabase.from("books").select("id").eq("legacy_appwrite_id", bookId).maybeSingle();
  return data?.id || null;
};

/**
 * Resolve a chapter id (UUID or legacy Appwrite hex) to its canonical Supabase UUID.
 * Returns null if the id is missing or no row is found.
 *
 * @param {string|null|undefined} chapterId
 * @returns {Promise<string|null>}
 */
const resolveChapterUuid = async (chapterId) => {
  if (!chapterId) return null;
  if (UUID_RE.test(String(chapterId))) return String(chapterId);
  const { data } = await supabase.from("chapters").select("id").eq("legacy_appwrite_id", chapterId).maybeSingle();
  return data?.id || null;
};

// Heuristic: infer a content-rating chip from a book's tags / genre
// when the explicit `content_rating` column is NULL. Most of the older
// migrated books never got a value backfilled, so this lookup keeps
// the rating chip visible without forcing every author to re-edit
// their book just to surface what their tags already declare.
//
// "Rated 18" trigger words: hot, dark, mature, adult, smut, erotic,
// 18+, NSFW, explicit. Match is case-insensitive and substring-based
// so "Hot Romance", "Dark Romance", "Mature Themes", "Erotica" all
// trip it. If a book genuinely is rated PG by the author, we still
// honor an explicit `content_rating='Rated PG'` from the DB above
// the heuristic — only falls through to inference when the column
// is null.
const MATURE_TAG_PATTERNS = /\b(hot|dark|mature|adult|smut|erotic|erotica|18\+?|nsfw|explicit)\b/i;
const inferContentRatingFromTags = (tags = [], genre = "") => {
  const candidates = [
    ...(Array.isArray(tags) ? tags : []),
    ...(typeof genre === "string" ? [genre] : []),
  ]
    .map((t) => (typeof t === "string" ? t : ""))
    .filter(Boolean);
  if (candidates.some((t) => MATURE_TAG_PATTERNS.test(t))) {
    return "Rated 18";
  }
  return null;
};

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
    // When the author dismissed the "this book is free, did you mean
    // to lock it?" prompt for this specific book. Used by the mobile
    // banner to stay hidden after dismissal. Null = prompt may show.
    lock_prompt_dismissed_at: row.lock_prompt_dismissed_at ?? null,
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
      // Expand role flags so UserRoleBadgeIcons surfaces the verified
      // seal next to the book author's name (book-info, BooksDiscover,
      // BookSearchCard, etc.).
      ...expandProfileRoleFlags(author),
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
      ...expandProfileRoleFlags(author),
    },
    author: author.legacy_appwrite_id || author.id,
    // Paywall — book is "locked" / "Paid" when lock_from_chapter is set
    // (matches Selebox web's `(book.lock_from_chapter || 0) > 0` check).
    // The per-book chapter-start threshold is exposed as bookChapterLockStart
    // so isChapterLocked can prefer the per-book value over the global
    // BOOKS_CHAPTER_LOCK_START app-config setting.
    isLocked: (row.lock_from_chapter || 0) > 0,
    bookChapterLockStart: row.lock_from_chapter || null,
    // Content rating resolution chain:
    //   1. Explicit DB value (`content_rating`) — set by the author or
    //      backfill script. Always wins.
    //   2. Heuristic from tags / genre — for legacy migrated books
    //      whose column is NULL, infer "Rated 18" when tags contain
    //      mature signals (Hot/Dark Romance, Adult, Mature, Smut,
    //      Erotica, 18+, NSFW, Explicit).
    //   3. null — display chip is dropped via .filter(Boolean) so we
    //      never falsely advertise mature content as PG.
    //
    // Earlier we hardcoded the fallback to "Rated PG" which mis-
    // labeled every mature book whose column was empty. Switching to
    // null fixed the mis-labeling but made the chip vanish for books
    // that legitimately ARE 18+ (just not flagged in the DB). This
    // chain restores the chip when the author's own tags make the
    // intent obvious without trusting bad defaults.
    // Three-tier resolution:
    //   1. Explicit DB column (`row.content_rating`) — author-set.
    //   2. Tag inference — Hot/Dark/Adult/SSPG/etc. → "Rated 18".
    //   3. Default to "Rated PG" so every book carries a label rather
    //      than rendering nothing on book-info / catalog cards. This
    //      restores the missing-pill behavior the user reported on
    //      non-mature books while preserving the inference fix that
    //      keeps mature books labeled "Rated 18".
    contentRating:
      row.content_rating ||
      inferContentRatingFromTags(row.tags, row.genre) ||
      "Rated PG",
  };
};

// Map a chapters row into the Appwrite-shaped doc.
const mapRowToChapter = (row) => {
  if (!row) return null;

  // Resolve the joined book row (from CHAPTER_SELECT's
  // `books!chapters_book_id_fkey (...)` relation). When the relation
  // is absent — old call sites using a stripped select — fall back to
  // the bare book_id string so `chapter.book?.$id || chapter.book`
  // patterns still resolve to the legacy id.
  const joinedBook = row.books;
  const bookField = joinedBook
    ? {
        // Full Appwrite-shape so book?.isLocked / book?.bookChapterLockStart
        // / book?.uploader resolve correctly anywhere `chapter.book` is
        // consumed (book-reading.jsx isChapterLocked, modal headers, etc.)
        id: joinedBook.id,
        $id: joinedBook.legacy_appwrite_id || joinedBook.id,
        legacy_appwrite_id: joinedBook.legacy_appwrite_id,
        title: joinedBook.title,
        cover_url: joinedBook.cover_url,
        thumbnail: joinedBook.cover_url,
        chapters_count: joinedBook.chapters_count ?? 0,
        chaptersTotal: joinedBook.chapters_count ?? 0,
        lock_from_chapter: joinedBook.lock_from_chapter,
        // Same isLocked / bookChapterLockStart computation as
        // mapRowToBook — keep these in sync so a chapter-embedded book
        // gates identically to a standalone book row.
        isLocked: (joinedBook.lock_from_chapter || 0) > 0,
        bookChapterLockStart: joinedBook.lock_from_chapter || null,
        // uploader.$id is what isBookOwnedByUser compares against for
        // the owner-bypass; surface it both as a string and on a
        // .uploader.$id path so either lookup pattern works.
        uploader: joinedBook.author_id
          ? { $id: joinedBook.author_id, id: joinedBook.author_id }
          : null,
        author_id: joinedBook.author_id,
      }
    : row.book_id;

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
    book: bookField,                  // full book object when join present, else book_id string
    order: row.chapter_number,        // legacy used `order` for chapter position
    thumbnail: row.cover_url,
    status: row.is_published ? "Published" : "Draft",
    // isLocked at the chapter level — Appwrite consumers read both
    // `chapter.is_locked` (Supabase shape) and `chapter.isLocked` (legacy
    // shape) depending on the screen. Set both for safety.
    isLocked: !!row.is_locked,
  };
};

// content_rating is the DB column that drives the BookTag's
// "Rated PG / Rated 18 / SSPG" badge. Without selecting it here every
// book row came back without the field → mapRowToBook line 193 fell back
// to "Rated PG" for every book → the entire books surface (Ranking, For
// You, Discover, Library, profile, etc.) flipped to PG. The backfill
// script populated content_rating in the DB correctly; the bug was on
// the read side. Same fix applied in books-rankings-supabase.js.
const BOOK_SELECT = `
  id, title, description, cover_url, genre, tags, status, is_public,
  content_rating,
  views_count, likes_count, chapters_count, word_count,
  ratings_count, ratings_avg, trending_score, is_editors_pick,
  lock_from_chapter, locked_at, lock_prompt_dismissed_at,
  is_hidden, legacy_appwrite_id,
  created_at, updated_at, published_at, author_id,
  profiles!books_author_id_fkey ( id, username, avatar_url, role, legacy_appwrite_id )
`;

// We pull the book relation alongside every chapter row so consumers
// (book-reading.jsx, BookChaptersModal, etc.) get a real book object
// on `chapter.book` — not just a bare book_id UUID. Without this join
// `chapter.book` was a string, `book?.isLocked` evaluated to undefined,
// and `isChapterLocked` short-circuited to "not locked" — paid chapters
// rendered for free. We need at minimum: legacy_appwrite_id (so $id
// resolution matches the legacy chapter.book.$id pattern), id,
// lock_from_chapter (drives both `book.isLocked` and the per-book lock
// threshold), and author_id (for the owner-bypass check in
// isChapterLocked).
const CHAPTER_SELECT = `
  id, book_id, chapter_number, title, content, word_count, views_count,
  is_published, is_locked, unlock_cost_coins, unlock_cost_stars,
  cover_url, scheduled_publish_at, legacy_appwrite_id,
  created_at, updated_at,
  books!chapters_book_id_fkey (
    id, legacy_appwrite_id, title, cover_url,
    lock_from_chapter, author_id, chapters_count
  )
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

// Sequence label shown in TOC, publish-success modal, and other "where
// am I in the book" contexts. Uses `#N` (matching the web client) instead
// of "Chapter N" or "Part N" so authors can name parts freely
// (Prologue / Teaser / Interlude / Chapter 1) without the system label
// fighting their naming. The order field still drives `#N`.
export const getBookChapterSectionLabel = (chapter, index = 0) =>
  isIntroductionChapter(chapter, index) ? "Introduction" : `#${getBookChapterOrder(chapter, index)}`;

// `is_locked` is included so list-view consumers (the inline TOC in
// book-editor.jsx, BookChaptersModal, etc.) can render a lock glyph
// per row without a second fetch. The column is small (boolean) and
// already populated by the chapter writer flow. Adding it is purely
// additive — no existing consumer breaks from the extra field.
export const BOOK_CHAPTER_LIST_SELECT = ["id", "created_at", "updated_at", "title", "cover_url", "chapter_number", "is_published", "is_locked"];


// ════════════════════════════════════════════════════════════════════════════
// Discovery helpers — Supabase native implementations
// ════════════════════════════════════════════════════════════════════════════
// These mirror the Appwrite versions in lib/books-appwrite.js. The
// dispatcher in lib/books.js (`impl.X ?? appwriteImpl.X`) currently falls
// back to the Appwrite impl when these are missing — which silently
// defeats the migration on the Books tab + BooksDiscover. Now that
// Supabase has the same denormalized engagement counts on each books
// row (likes_count, views_count, ratings_avg, chapters_count via the
// engagement-migration triggers), both helpers become simpler than
// their Appwrite counterparts.

// Module-level cache for fetchRandomBook's totalBooks count, keyed by
// the filter combination. 5-minute TTL — same shape as the Appwrite
// version so warm pull-to-refreshes skip the count round-trip.
const RANDOM_BOOK_COUNT_CACHE_SB = new Map();
const RANDOM_BOOK_COUNT_TTL_SB = 5 * 60 * 1000;
const _randomBookCountKey = ({ status, category }) =>
  `${status || "any"}::${category || "any"}`;
const _readRandomBookCount = (k) => {
  const c = RANDOM_BOOK_COUNT_CACHE_SB.get(k);
  if (!c) return null;
  if (Date.now() - c.fetchedAt > RANDOM_BOOK_COUNT_TTL_SB) {
    RANDOM_BOOK_COUNT_CACHE_SB.delete(k);
    return null;
  }
  return c.total;
};
const _writeRandomBookCount = (k, total) => {
  if (!Number.isFinite(total) || total < 0) return;
  RANDOM_BOOK_COUNT_CACHE_SB.set(k, { total, fetchedAt: Date.now() });
};

const _shuffleBooks = (arr) => {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const _dedupeBooksById = (arr) => {
  const seen = new Set();
  const out = [];
  for (const b of arr) {
    const id = b?.id || b?.$id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(b);
  }
  return out;
};

/**
 * fetchRandomBook — sample N random published books from Supabase. Used by
 * the Books tab "Random pick" CTA and the refreshBooks fan-out (weekly /
 * fresh / completed). Algorithm mirrors the Appwrite version: count total,
 * pick random offsets, fetch a window per offset, shuffle, dedupe, slice.
 * Postgres has ORDER BY random() but it's table-scan expensive on large
 * catalogs — windowed offset sampling stays cheap as the catalog grows.
 */
export const fetchRandomBook = async ({ limit = 1, status, category, excludeIds = [] } = {}) => {
  try {
    const safeLimit = Math.max(1, Math.floor(limit));
    const excluded = new Set((excludeIds || []).filter(Boolean));

    // Build the base filter: published + optional category + optional explicit status.
    const buildBaseQuery = () => {
      let q = supabase
        .from("books")
        .select(BOOK_SELECT, { count: "exact" })
        .eq("is_public", true)
        .eq("is_hidden", false)
        .neq("status", "draft");
      if (status) {
        // Accept either capitalized ("Published") or lowercase ("ongoing")
        // — match the Appwrite caller convention.
        const s = String(status).toLowerCase();
        if (s !== "published" && s !== "publish") q = q.eq("status", s);
      }
      if (category) q = q.contains("tags", [category]);
      return q;
    };

    // Fast-path total via cache.
    const cacheKey = _randomBookCountKey({ status, category });
    let totalBooks = _readRandomBookCount(cacheKey);
    if (totalBooks === null) {
      const { count, error } = await buildBaseQuery().limit(1);
      if (error) throw error;
      totalBooks = count || 0;
      _writeRandomBookCount(cacheKey, totalBooks);
    }
    if (totalBooks === 0) return { documents: [], total: 0 };

    const sampleWindowSize = Math.min(Math.max(safeLimit * 3, 30), 100);
    const maxOffset = Math.max(totalBooks - sampleWindowSize, 0);
    const desiredWindowCount = Math.max(1, Math.min(4, Math.ceil(safeLimit / 12)));

    const usedOffsets = new Set();
    const sampledRows = [];

    const fetchWindow = async (offset) => {
      const { data, count, error } = await buildBaseQuery()
        .order("created_at", { ascending: false })
        .range(offset, offset + sampleWindowSize - 1);
      if (error) throw error;
      // Refresh the cache with the latest observed total.
      if (Number.isFinite(count)) {
        _writeRandomBookCount(cacheKey, count);
        totalBooks = count;
      }
      return data || [];
    };

    const initialOffsets = [];
    while (initialOffsets.length < desiredWindowCount) {
      const offset = maxOffset === 0 ? 0 : Math.floor(Math.random() * (maxOffset + 1));
      if (usedOffsets.has(offset)) continue;
      usedOffsets.add(offset);
      initialOffsets.push(offset);
    }

    const initial = await Promise.all(initialOffsets.map(fetchWindow));
    initial.forEach((batch) => sampledRows.push(...batch));

    let unique = _dedupeBooksById(sampledRows.map(mapRowToBook)).filter((b) => !excluded.has(b.id) && !excluded.has(b.$id));
    let attempts = 0;
    const maxAttempts = 6;
    while (unique.length < safeLimit && attempts < maxAttempts && usedOffsets.size < maxOffset + 1) {
      attempts += 1;
      const next = maxOffset === 0 ? 0 : Math.floor(Math.random() * (maxOffset + 1));
      if (usedOffsets.has(next)) continue;
      usedOffsets.add(next);
      const batch = await fetchWindow(next);
      sampledRows.push(...batch);
      unique = _dedupeBooksById(sampledRows.map(mapRowToBook)).filter((b) => !excluded.has(b.id) && !excluded.has(b.$id));
    }

    return { documents: _shuffleBooks(unique).slice(0, safeLimit), total: totalBooks };
  } catch (err) {
    console.error("[books-supabase] fetchRandomBook error:", err?.message || err);
    throw err;
  }
};

/**
 * hydrateDiscoverStats — wrap a list of book documents with the
 * ranking-shaped envelope BooksDiscover/BooksRanking consumers expect:
 *   { $id, book, totalReads, monthlyReads, averageRating, totalLikes, chaptersTotal }
 *
 * The Appwrite version round-trips three batched queries (reads, likes,
 * chapter counts) because Appwrite has no denormalized counts. Supabase
 * already carries these as columns on `books`, kept fresh by triggers
 * from migration_books_engagement.sql, so this is a pure structural
 * reshape — no network. Map already exposes the legacy aliases.
 */
export const hydrateDiscoverStats = async (books = []) => {
  if (!Array.isArray(books) || books.length === 0) return [];
  return books.map((book) => ({
    $id: book?.$id || book?.id || null,
    book,
    totalReads: Number(book?.totalReads ?? book?.views_count ?? 0) || 0,
    monthlyReads: Number(book?.monthlyReads ?? book?.views_count ?? 0) || 0,
    averageRating: Number(book?.averageRating ?? book?.ratings_avg ?? 0) || 0,
    totalLikes: Number(book?.totalLikes ?? book?.likes_count ?? 0) || 0,
    chaptersTotal: Number(book?.chaptersTotal ?? book?.chapters_count ?? 0) || 0,
  }));
};


// ════════════════════════════════════════════════════════════════════════════
// Status normalizers — translate legacy/varied caller status strings
// into the canonical values web's filters and the engagement triggers
// expect. Web filters books with `status IN ('ongoing','completed')`
// and chapters with `is_published = true`. Mobile historically passes
// Capitalized strings like "Draft", "Publish", "Published". Without
// normalization, a mobile-published book lands as `status='Publish'`
// in Supabase and stays invisible on web.
// ════════════════════════════════════════════════════════════════════════════

const _normalizeBookStatus = (s) => {
  if (typeof s !== "string") return "draft";
  const lower = s.toLowerCase();
  if (lower === "draft") return "draft";
  if (lower === "publish" || lower === "published" || lower === "ongoing") return "ongoing";
  if (lower === "completed" || lower === "complete") return "completed";
  return "draft";
};

const _normalizeChapterPublished = (s) => {
  if (typeof s === "boolean") return s;
  if (typeof s !== "string") return false;
  const lower = s.toLowerCase();
  return lower === "publish" || lower === "published";
};


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
  // All write paths route through SECURITY DEFINER RPCs because mobile
  // uses the anon key (USE_SUPABASE_AUTH=false → auth.uid() is null), so
  // direct INSERT/UPDATE/DELETE on `books` and `chapters` is rejected by
  // RLS with PG 42501. The RPCs take an explicit actor uuid, verify
  // ownership server-side, then apply the write. Same pattern as the
  // phase1/phase3 mobile-write RPCs.
  //
  // Each create/update RPC also returns the freshly-written row inline
  // (jsonb) so we don't need a follow-up SELECT — that follow-up would
  // be RLS-filtered for drafts on anon clients and break the post-save
  // hand-back to the editor.

  /**
   * Create a new book row, returning it in Appwrite-shaped form.
   * Routes through the `submit_book_create` SECURITY DEFINER RPC so
   * mobile (anon-key) callers can author drafts without RLS rejection.
   *
   * @param {object} args
   * @param {string} args.title           Book title (required, non-empty).
   * @param {string} [args.synopsis]      Description / blurb.
   * @param {string} [args.thumbnail]     Public URL for the cover image.
   * @param {string} args.uploader        Author id — Appwrite hex or Supabase UUID.
   * @param {string[]} [args.tags]        Tag list; `[]` if omitted.
   * @param {string} [args.genre]
   * @param {string} [args.status]        "Draft" / "Publish" / "Ongoing" / "Completed";
   *                                       normalized server-side to `draft|ongoing|completed`.
   * @returns {Promise<object|null>} mapRowToBook'd document, or null on failure.
   */
  async createNewBook({ title, synopsis, thumbnail, uploader, tags, genre, status }) {
    const authorUuid = await resolveSupabaseUserId(uploader);
    if (!authorUuid) throw new Error("createNewBook: cannot resolve uploader");
    const normalizedStatus = _normalizeBookStatus(status);

    const { data: rpcData, error: rpcErr } = await supabase.rpc("submit_book_create", {
      p_actor_id: authorUuid,
      p_title: title,
      p_synopsis: synopsis ?? null,
      p_cover_url: thumbnail ?? null,
      p_tags: Array.isArray(tags) ? tags : [],
      p_genre: genre ?? null,
      p_status: normalizedStatus,
    });
    if (rpcErr) throw rpcErr;
    if (!rpcData?.ok) throw new Error(`createNewBook: ${rpcData?.error || "failed"}`);

    // The RPC returns the full row (including the joined author profile)
    // because a follow-up `from("books").select(...)` from anon would be
    // RLS-filtered for drafts (is_public=false). See the migration's
    // header for the full rationale.
    return mapRowToBook(rpcData.row);
  }

  /**
   * Update an existing book. NULL/undefined fields are left unchanged
   * (server-side COALESCE pattern in `submit_book_update`).
   *
   * @param {object} args
   * @param {string} args.ID              Book id — UUID or Appwrite hex.
   * @param {string} [args.title]
   * @param {string} [args.synopsis]
   * @param {string} [args.thumbnail]
   * @param {string[]} [args.tags]
   * @param {string} [args.genre]
   * @param {string} [args.status]        Normalized server-side; flips is_public + published_at when leaving "draft".
   * @param {string} [args.userId]        Caller id (Appwrite hex or UUID). Defaults to messages-user cache.
   * @returns {Promise<object|null>} Updated, mapped book document.
   */
  async updateBook({ ID, title, synopsis, thumbnail, tags, genre, status, userId, lockFromChapter, isLocked, contentRating }) {
    if (!ID) throw new Error("updateBook: ID required");

    let actorUuid = null;
    if (userId) {
      actorUuid = await resolveSupabaseUserId(userId);
    } else {
      const { getMessagesUserId } = await import("./messages-supabase");
      actorUuid = getMessagesUserId();
    }
    if (!actorUuid) throw new Error("updateBook: actor not resolved");

    const normalizedStatus = status !== undefined ? _normalizeBookStatus(status) : null;

    // Resolve `p_lock_from_chapter` per the RPC sentinel scheme:
    //    null → leave unchanged
    //    0    → clear (set NULL, makes the book free again)
    //    5-10 → write the threshold (server-side check enforces the range)
    //
    // Two ways callers can drive this:
    //   - Explicit numeric: lockFromChapter = 7
    //   - Toggle:           isLocked = true  (writes the global default)
    //                       isLocked = false (clears via 0 sentinel)
    // The toggle path is for legacy "Lock Book" switch behavior;
    // the explicit-numeric path is what the new picker uses.
    let pLockFromChapter = null;
    if (lockFromChapter !== undefined && lockFromChapter !== null) {
      pLockFromChapter = Number(lockFromChapter);
    } else if (isLocked === true) {
      // Legacy toggle "ON" — caller wants the book locked but didn't
      // pick a threshold. We can't infer; leave the column unchanged
      // and let the caller use lockFromChapter for explicit control.
      pLockFromChapter = null;
    } else if (isLocked === false) {
      pLockFromChapter = 0; // sentinel — clear to NULL
    }

    const { data: rpcData, error: rpcErr } = await supabase.rpc("submit_book_update", {
      p_actor_id: actorUuid,
      p_book_id: ID,
      p_title: title ?? null,
      p_synopsis: synopsis ?? null,
      p_cover_url: thumbnail ?? null,
      p_tags: Array.isArray(tags) ? tags : null,
      p_genre: genre ?? null,
      p_status: normalizedStatus,
      p_lock_from_chapter: pLockFromChapter,
    });
    if (rpcErr) throw rpcErr;
    if (!rpcData?.ok) throw new Error(`updateBook: ${rpcData?.error || "failed"}`);

    // submit_book_update RPC doesn't accept content_rating yet, so write
    // directly to the column. RLS policy `books_update_own` (author_id =
    // current_profile_id()) allows the author to update their own book.
    if (contentRating !== undefined && contentRating !== null) {
      const { error: crErr } = await supabase
        .from("books")
        .update({ content_rating: contentRating })
        .eq("id", ID);
      if (crErr) {
        console.warn("[books-supabase] updateBook content_rating write failed:", crErr.message);
      }
    }

    invalidateBookCache(ID);
    return mapRowToBook(rpcData.row);
  }

  /**
   * Dismiss the in-app "this book is free, did you mean to lock it?"
   * prompt for a specific book. Server-side trigger automatically
   * clears the dismissal if the author later locks the book, so a
   * future unlock can re-arm the prompt. SECURITY DEFINER RPC
   * enforces author ownership.
   *
   * @param {object} args
   * @param {string} args.ID         Book id — UUID or Appwrite hex.
   * @param {string} [args.userId]   Caller id (Appwrite hex or UUID).
   * @returns {Promise<{ok: true}>}
   */
  async dismissBookLockPrompt({ ID, userId } = {}) {
    if (!ID) throw new Error("dismissBookLockPrompt: ID required");

    let actorUuid = null;
    if (userId) {
      actorUuid = await resolveSupabaseUserId(userId);
    } else {
      const { getMessagesUserId } = await import("./messages-supabase");
      actorUuid = getMessagesUserId();
    }
    if (!actorUuid) throw new Error("dismissBookLockPrompt: actor not resolved");

    const { data, error } = await supabase.rpc("submit_book_lock_prompt_dismiss", {
      p_actor_id: actorUuid,
      p_book_id: ID,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(`dismissBookLockPrompt: ${data?.error || "failed"}`);

    invalidateBookCache(ID);
    return { ok: true };
  }

  /**
   * Quick yes/no — does the caller already own at least one book with
   * a paywall threshold set? Drives whether the in-app
   * BookLockPromptBanner renders. Cheaper than paginating books for
   * a count: the RPC does a single EXISTS check server-side.
   *
   * @param {object} args
   * @param {string} [args.userId]   Caller id (Appwrite hex or UUID).
   * @returns {Promise<boolean>}
   */
  async hasPaidBooks({ userId } = {}) {
    let actorUuid = null;
    if (userId) {
      actorUuid = await resolveSupabaseUserId(userId);
    } else {
      const { getMessagesUserId } = await import("./messages-supabase");
      actorUuid = getMessagesUserId();
    }
    if (!actorUuid) return false;

    const { data, error } = await supabase.rpc("has_paid_books_for_author", {
      p_actor_id: actorUuid,
    });
    if (error) {
      console.error("hasPaidBooks RPC error:", error.message);
      return false;
    }
    return Boolean(data);
  }

  /**
   * Delete a book the caller owns. CASCADE FKs wipe chapters / likes /
   * bookmarks / comments / reads / ratings as part of the same write.
   *
   * @param {object} args
   * @param {string} args.ID         Book id — UUID or Appwrite hex.
   * @param {string} [args.userId]   Caller id (resolved to actor UUID for the RPC's ownership check).
   * @returns {Promise<{ok:true,deleted:number,book_id:string}>}
   * @throws {Error} `not_owner` if caller isn't the author; `not_found` if book is gone.
   */
  async deleteBook({ ID, userId } = {}) {
    if (!ID) throw new Error("deleteBook: ID required");

    // Routed through `delete_book_owned` RPC because mobile uses the
    // anon key (USE_SUPABASE_AUTH=false → auth.uid() is null), so a
    // direct `.from("books").delete()` is rejected by RLS. The RPC is
    // SECURITY DEFINER, verifies the actor owns the book (server-side
    // checks p_actor_id == books.author_id), and CASCADE FKs clean up
    // chapters / likes / bookmarks / comments / etc. Same architectural
    // fix as upsert_profile_mirror + the phase1/phase3 mobile-write RPCs.
    //
    // Caller may pass `userId` explicitly; if omitted we fall back to
    // the active messages-user (resolved at signin from the Supabase
    // profile mirror). All current call sites — ProfileBooksTab,
    // book-editor, catalog — pass nothing today, so the fallback is
    // what actually drives the resolution. Adding `userId` to the
    // signature future-proofs this against multi-account cases.
    let actorUuid = null;
    if (userId) {
      actorUuid = await resolveSupabaseUserId(userId);
    } else {
      const { getMessagesUserId } = await import("./messages-supabase");
      actorUuid = getMessagesUserId();
    }
    if (!actorUuid) throw new Error("deleteBook: actor not resolved");

    const { data, error } = await supabase.rpc("delete_book_owned", {
      p_book_id: ID,
      p_actor_id: actorUuid,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(`deleteBook: ${data?.error || "failed"}`);
    invalidateBookCache(ID);
    return data;
  }

  // ── Chapter CRUD ──
  // Same RPC-routed pattern as the book methods above. Ownership is
  // verified server-side by joining chapters → books and checking
  // books.author_id, so direct chapter writes never need the caller to
  // know who owns the parent book.

  /**
   * Create a new chapter under an existing book. Caller must own the
   * parent book — verified server-side via `submit_chapter_create`.
   *
   * @param {object} args
   * @param {string} args.title
   * @param {string} [args.content]      HTML content (sanitized via getSanitizedChapterContent before persistence).
   * @param {string} [args.thumbnail]    Cover URL.
   * @param {string} args.bookId         Parent book id — UUID or Appwrite hex.
   * @param {string} [args.status]       "Publish"/"Published" → is_published=true; anything else → false.
   * @param {number} [args.order]        chapter_number; 0 = introduction.
   * @param {string} [args.userId]       Caller id (resolved to actor UUID).
   * @returns {Promise<object|null>}     mapRowToChapter'd new chapter.
   */
  async createNewBookChapter({ title, content, thumbnail, bookId, status, order, userId }) {
    if (!bookId) throw new Error("createNewBookChapter: bookId required");

    let actorUuid = null;
    if (userId) {
      actorUuid = await resolveSupabaseUserId(userId);
    } else {
      const { getMessagesUserId } = await import("./messages-supabase");
      actorUuid = getMessagesUserId();
    }
    if (!actorUuid) throw new Error("createNewBookChapter: actor not resolved");

    const { data: rpcData, error: rpcErr } = await supabase.rpc("submit_chapter_create", {
      p_actor_id: actorUuid,
      p_book_id: bookId,
      p_title: title ?? null,
      p_content: content ?? null,
      p_cover_url: thumbnail ?? null,
      p_chapter_number: order ?? null,
      p_is_published: _normalizeChapterPublished(status),
    });
    if (rpcErr) throw rpcErr;
    if (!rpcData?.ok) throw new Error(`createNewBookChapter: ${rpcData?.error || "failed"}`);

    // RPC returns the full chapter row to bypass the anon RLS filter
    // that hides unpublished chapters. See migration header for details.
    return mapRowToChapter(rpcData.row);
  }

  /**
   * Update an existing chapter. NULL fields are left unchanged.
   * Ownership is verified through the parent book's author_id.
   *
   * @param {object} args
   * @param {string} args.ID
   * @param {string} [args.title]
   * @param {string} [args.content]
   * @param {string} [args.status]
   * @param {string} [args.thumbnail]
   * @param {number} [args.order]
   * @param {string} [args.userId]
   * @returns {Promise<object|null>}
   */
  async updateBookChapter({ ID, title, content, status, thumbnail, order, userId, unlockCostCoins, unlockCostStars }) {
    if (!ID) throw new Error("updateBookChapter: ID required");

    let actorUuid = null;
    if (userId) {
      actorUuid = await resolveSupabaseUserId(userId);
    } else {
      const { getMessagesUserId } = await import("./messages-supabase");
      actorUuid = getMessagesUserId();
    }
    if (!actorUuid) throw new Error("updateBookChapter: actor not resolved");

    // Cost-override sentinel scheme — same shape the RPC expects:
    //    undefined / null → leave unchanged
    //    -1               → clear to NULL (chapter inherits the
    //                       BOOKS_CHAPTER_*_PRICE app_config default)
    //    1-10             → write the explicit per-chapter price
    // The mobile UI passes -1 when the author flips the "Use default"
    // toggle and a 1-10 number when they pick from the segmented row.
    const resolveCostParam = (val) => {
      if (val === undefined || val === null) return null;
      if (val === -1 || val === "default" || val === "Default") return -1;
      const n = Number(val);
      if (!Number.isFinite(n)) return null;
      return n;
    };

    const { data: rpcData, error: rpcErr } = await supabase.rpc("submit_chapter_update", {
      p_actor_id: actorUuid,
      p_chapter_id: ID,
      p_title: title ?? null,
      p_content: content ?? null,
      p_cover_url: thumbnail ?? null,
      p_chapter_number: order ?? null,
      p_is_published: status !== undefined ? _normalizeChapterPublished(status) : null,
      p_unlock_cost_coins: resolveCostParam(unlockCostCoins),
      p_unlock_cost_stars: resolveCostParam(unlockCostStars),
    });
    if (rpcErr) throw rpcErr;
    if (!rpcData?.ok) throw new Error(`updateBookChapter: ${rpcData?.error || "failed"}`);

    invalidateBookChapterCache(ID);
    return mapRowToChapter(rpcData.row);
  }

  /**
   * Delete a chapter. Owner-only; CASCADE FKs handle chapter_likes /
   * chapter_reads / chapter_comments / inline comment threads.
   *
   * @param {object} args
   * @param {string} args.ID
   * @param {string} [args.userId]
   * @returns {Promise<{ok:true,deleted:number,id:string}>}
   */
  async deleteBookChapter({ ID, userId } = {}) {
    if (!ID) throw new Error("deleteBookChapter: ID required");

    let actorUuid = null;
    if (userId) {
      actorUuid = await resolveSupabaseUserId(userId);
    } else {
      const { getMessagesUserId } = await import("./messages-supabase");
      actorUuid = getMessagesUserId();
    }
    if (!actorUuid) throw new Error("deleteBookChapter: actor not resolved");

    const { data, error } = await supabase.rpc("submit_chapter_delete", {
      p_actor_id: actorUuid,
      p_chapter_id: ID,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(`deleteBookChapter: ${data?.error || "failed"}`);
    invalidateBookChapterCache(ID);
    return data;
  }

  // ── Book reads (lists) ──

  /**
   * List books. Generalized fetch used by Discovery, Ranking, search,
   * profile screens, and the author catalog.
   *
   * Self-author fast path: when `actorUserId` is passed AND it resolves
   * to the same UUID as `userId` (a single id, not an array) AND no
   * `category`/`status` filter is set, routes through `fetch_author_books`
   * RPC so the author sees their own DRAFTS — anon SELECT path filters
   * `is_public = true` only.
   *
   * @param {object} args
   * @param {string|string[]} [args.userId]    Single user id or array (Discovery batch).
   * @param {string} [args.actorUserId]        Caller id; enables self-author drafts when matches userId.
   * @param {string} [args.lastId]             Cursor — last book's id from the previous page.
   * @param {string} [args.category]           Tag filter.
   * @param {number} [args.limit=20]
   * @param {string|string[]} [args.status]    "Ongoing" / "Completed" / array.
   * @returns {Promise<{documents:object[],total:number}>}
   */
  async fetchBooks({ userId, actorUserId, lastId, category, limit = 20, status }) {
    // Self-author fast path — drafts visible.
    //
    // When the caller is fetching books for a single user that matches
    // the currently signed-in actor, route through the SECURITY DEFINER
    // `fetch_author_books` RPC. The direct `from("books").select(...)`
    // path that follows uses the anon key (USE_SUPABASE_AUTH=false) and
    // is therefore filtered by the books_select RLS policy to is_public=
    // true rows — which is why authors saw their drafts on web (Supabase
    // session, auth.uid() = author_id) but not on mobile.
    //
    // Actor resolution priority:
    //   1. `actorUserId` arg — caller passes user.$id from useGlobalContext.
    //      Reliable, available immediately on screen mount.
    //   2. `getMessagesUserId()` — module-level cache populated during
    //      signin. Initially null, races with screen mount; we keep this
    //      as a fallback for callers that don't pass actorUserId yet.
    //
    // Conditions to route through the RPC:
    //   • userId is a single id (not an array — Discovery / Ranking
    //     batch lookups stay on the public path)
    //   • no extra filters (category / status) — those callers want
    //     filtered subsets of public books and don't need drafts
    //   • we can resolve an actor uuid that matches the requested
    //     author uuid
    // Anything that doesn't meet all three falls through to the
    // existing direct-SELECT path.
    if (userId && !Array.isArray(userId) && !category && !status) {
      try {
        const authorUuid = UUID_RE.test(userId) ? userId : await resolveSupabaseUserId(userId);

        // Resolve actor — prefer the explicit caller-provided id (usually
        // user.$id from useGlobalContext) over the module-level cache,
        // which can be null during the post-signin async resolve window.
        let actorUuid = null;
        if (actorUserId) {
          actorUuid = UUID_RE.test(actorUserId) ? actorUserId : await resolveSupabaseUserId(actorUserId);
        }
        if (!actorUuid) {
          const { getMessagesUserId } = await import("./messages-supabase");
          actorUuid = getMessagesUserId();
        }

        if (authorUuid && actorUuid && actorUuid === authorUuid) {
          // Resolve the cursor's created_at if the caller passed lastId,
          // matching the existing behavior on the direct-SELECT path.
          let cursorCreatedAt = null;
          if (lastId) {
            const { data: cursorRow } = await supabase
              .from("books")
              .select("created_at")
              .eq(idColumnFor(lastId), lastId)
              .maybeSingle();
            cursorCreatedAt = cursorRow?.created_at || null;
          }

          const { data, error } = await supabase.rpc("fetch_author_books", {
            p_actor_id: actorUuid,
            p_author_id: authorUuid,
            p_limit: limit,
            p_after_created_at: cursorCreatedAt,
          });
          if (error) throw error;
          if (!data?.ok) throw new Error(`fetchBooks: ${data?.error || "failed"}`);

          const documents = (data.rows || []).map(mapRowToBook).filter(Boolean);
          return { documents, total: data.total ?? documents.length };
        }
      } catch (rpcErr) {
        // RPC failure shouldn't blank the user's library — log loud and
        // fall through to the public-SELECT path so they at least see
        // their published books while we investigate.
        console.error("[books-supabase] fetch_author_books RPC failed:", rpcErr?.message);
      }
    }

    // Public fallback path — used for Discovery, Ranking, search, other-
    // user profile views, and as a safety net when the self-author RPC
    // path can't run. Returns is_public=true rows (RLS-filtered for anon).
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
        .eq(idColumnFor(lastId), lastId)
        .maybeSingle();
      if (cursorRow?.created_at) q = q.lt("created_at", cursorRow.created_at);
    }

    const { data, error, count } = await q;
    if (error) throw error;
    return { documents: (data || []).map(mapRowToBook), total: count ?? 0 };
  }

  /**
   * List ONLY books visible to the public — `status IN ('ongoing','completed')`.
   * Backs Discovery / Ranking pools. Drafts are never returned here, even
   * for the author. Use `fetchBooks` if you need self-author drafts.
   *
   * @param {object} args
   * @param {string} [args.category]
   * @param {string} [args.lastId]
   * @param {string|string[]} [args.status]   Defaults to ["ongoing","completed"].
   * @param {number} [args.limit=100]
   * @returns {Promise<{documents:object[],total:number}>}
   */
  async fetchPublishedBooks({ category, lastId, status, limit = 100 }) {
    // "Published" is a UI/legacy concept; in Supabase the canonical
    // statuses for a public book are ['ongoing', 'completed'] (matches
    // web's filter at Selebox/js/app.js public book list). When the
    // caller passes a specific status, normalize it through the same
    // helper write-side uses so capital-P "Published" → "ongoing"
    // doesn't slip through and zero-match the .eq() filter downstream.
    let normalized;
    if (status) {
      normalized = Array.isArray(status)
        ? status.map((s) => _normalizeBookStatus(s))
        : _normalizeBookStatus(status);
    } else {
      normalized = ["ongoing", "completed"];
    }
    return this.fetchBooks({
      category,
      lastId,
      status: normalized,
      limit,
    });
  }

  /**
   * Larger paginated drain of public books for the Discovery feed.
   * Internally loops `fetchPublishedBooks` until either `limit` rows
   * are gathered or the source is exhausted. Caller-side dedupes by id.
   *
   * @param {object} args
   * @param {number} [args.limit=500]
   * @returns {Promise<object[]>}
   */
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

  /**
   * Paginated chapter list for a book. Used by reader surfaces; pass
   * `status: "Publish"` to get only published chapters.
   *
   * @param {object} args
   * @param {string} args.bookId
   * @param {string} [args.lastId]
   * @param {string|boolean} [args.status]   "Publish" / "Published" / true → is_published=true; else false.
   * @param {number} [args.limit=100]
   * @param {string} [args.select]           Reserved for legacy compat.
   * @returns {Promise<{documents:object[],total:number}>}
   */
  async fetchBookChapters({ bookId, lastId, status, limit = 100, select } = {}) {
    if (!bookId) return { documents: [], total: 0 };
    const bookUuid = await resolveBookUuid(bookId);
    if (!bookUuid) return { documents: [], total: 0 };

    const pageLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
    let q = supabase
      .from("chapters")
      .select(CHAPTER_SELECT, { count: "exact" })
      .eq("book_id", bookUuid)
      .order("chapter_number", { ascending: true })
      .limit(pageLimit);

    if (status) {
      // Accept any of "Publish" / "Published" / "publish" / "published"
      // / true as "published". Legacy callers (book-reading.jsx and
      // older Appwrite-shaped strings) pass "Publish" without -ed; the
      // previous strict === "published" check zero-matched and the
      // chapter list rendered blank. Anything else (including "Draft")
      // routes to the unpublished bucket.
      const s = String(status).toLowerCase();
      const wantsPublished = s === "publish" || s === "published" || status === true;
      q = q.eq("is_published", wantsPublished);
    }
    if (lastId) {
      const { data: cursorRow } = await supabase
        .from("chapters")
        .select("chapter_number")
        .eq(idColumnFor(lastId), lastId)
        .maybeSingle();
      if (cursorRow?.chapter_number != null) q = q.gt("chapter_number", cursorRow.chapter_number);
    }

    const { data, error, count } = await q;
    if (error) throw error;
    return { documents: (data || []).map(mapRowToChapter), total: count ?? 0 };
  }

  /**
   * Fetch ALL chapters of a book in one logical call (paginates internally).
   *
   * Self-author fast path: when `actorUserId` resolves to the book's
   * author AND no `status` filter is requested, routes through
   * `fetch_author_book_chapters` RPC so DRAFTS surface in the author's
   * Table of Contents. Reader paths pass `status: "Publish"` and stay
   * on the public direct-SELECT.
   *
   * @param {object} args
   * @param {string} args.bookId
   * @param {string} [args.actorUserId]      Author id; enables drafts when matches book owner.
   * @param {string|boolean} [args.status]
   * @param {number} [args.limit=100]
   * @param {string} [args.select]
   * @returns {Promise<{documents:object[],total:number}>}
   */
  async fetchAllBookChapters({ bookId, actorUserId, status, limit = 100, select } = {}) {
    // Self-author fast path — drafts visible inside the Table of Contents.
    //
    // When the caller is the book's author AND no status filter is
    // requested (book-editor.jsx wants all chapters incl. drafts),
    // route through the SECURITY DEFINER `fetch_author_book_chapters`
    // RPC. The direct anon SELECT path otherwise gets RLS-filtered to
    // is_published=true, which is why a chapter "disappears" from the
    // TOC the moment the user saves it as draft online.
    //
    // Reader paths (book-reading, book-info) still pass status="Publish"
    // and fall through to the existing direct-SELECT, which only ever
    // returns published rows — readers never need drafts.
    if (bookId && !status && actorUserId) {
      try {
        const actorUuid = UUID_RE.test(actorUserId) ? actorUserId : await resolveSupabaseUserId(actorUserId);
        if (actorUuid) {
          const { data, error } = await supabase.rpc("fetch_author_book_chapters", {
            p_actor_id: actorUuid,
            p_book_id: bookId,
            p_limit: 100,
            p_after_chapter_number: null,
          });
          if (error) throw error;
          if (!data?.ok) throw new Error(`fetchAllBookChapters: ${data?.error || "failed"}`);

          // Page through the rest if the book has > 100 chapters. Cursor
          // is chapter_number ASC, matching the RPC's ORDER.
          const allRows = [...(data.rows || [])];
          let total = data.total ?? allRows.length;

          while (allRows.length > 0 && allRows.length < total) {
            const lastChapterNumber = allRows[allRows.length - 1]?.chapter_number;
            if (lastChapterNumber == null) break;
            const { data: nextData, error: nextErr } = await supabase.rpc("fetch_author_book_chapters", {
              p_actor_id: actorUuid,
              p_book_id: bookId,
              p_limit: 100,
              p_after_chapter_number: lastChapterNumber,
            });
            if (nextErr) throw nextErr;
            if (!nextData?.ok) break;
            const nextRows = nextData.rows || [];
            if (!nextRows.length) break;
            allRows.push(...nextRows);
            total = Math.max(total, nextData.total ?? allRows.length);
          }

          const documents = allRows.map(mapRowToChapter).filter(Boolean);
          return { documents, total: Math.max(total, documents.length) };
        }
      } catch (rpcErr) {
        console.error("[books-supabase] fetch_author_book_chapters RPC failed:", rpcErr?.message);
        // Fall through so the user at least sees published chapters.
      }
    }

    // Public / reader fallback — existing paginated direct-SELECT loop.
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

  /**
   * Single-row book fetch. Reads from BOOK_CACHE first.
   *
   * Self-author fast path: when `actorUserId` is passed, tries
   * `fetch_author_book_one` RPC first so the author can fetch their
   * own draft books (anon SELECT is RLS-filtered to is_public=true).
   * Falls through to public direct-SELECT for non-owners.
   *
   * @param {object} args
   * @param {string} args.bookId
   * @param {string} [args.actorUserId]
   * @returns {Promise<object|null>}
   */
  async fetchBook({ bookId, actorUserId }) {
    if (!bookId) return null;
    const cached = BOOK_CACHE.get(bookId);
    if (cached) return cached;

    // Self-author fast path — author can fetch their own draft books
    // (is_public=false). The direct anon SELECT path below is RLS-
    // filtered to public rows, which would return null for any draft
    // and break "resume draft" / deep-link-to-draft flows.
    if (actorUserId) {
      try {
        const actorUuid = UUID_RE.test(actorUserId) ? actorUserId : await resolveSupabaseUserId(actorUserId);
        if (actorUuid) {
          const { data, error } = await supabase.rpc("fetch_author_book_one", {
            p_actor_id: actorUuid,
            p_book_id: bookId,
          });
          if (error) throw error;
          if (data?.ok && data.row) {
            const mapped = mapRowToBook(data.row);
            if (mapped) BOOK_CACHE.set(bookId, mapped);
            return mapped;
          }
          // ok:false from the RPC means not_found OR not visible to this
          // actor — fall through to the public path so a non-owner who
          // knows the legacy id still resolves a published book.
        }
      } catch (rpcErr) {
        console.error("[books-supabase] fetch_author_book_one failed:", rpcErr?.message);
      }
    }

    const { data, error } = await supabase
      .from("books")
      .select(BOOK_SELECT)
      .eq(idColumnFor(bookId), bookId)
      .maybeSingle();
    if (error) throw error;
    const mapped = mapRowToBook(data);
    if (mapped) BOOK_CACHE.set(bookId, mapped);
    return mapped;
  }

  /**
   * Single-row chapter fetch. Reads from BOOK_CHAPTER_CACHE first.
   *
   * Self-author fast path: when `actorUserId` is passed, tries
   * `fetch_author_chapter_one` RPC first so the author can fetch their
   * own draft chapters (anon SELECT is RLS-filtered to is_published=true).
   *
   * @param {object} args
   * @param {string} args.chapterId
   * @param {string} [args.actorUserId]
   * @returns {Promise<object|null>}
   */
  async fetchBookChapter({ chapterId, actorUserId }) {
    if (!chapterId) return null;
    const cached = BOOK_CHAPTER_CACHE.get(chapterId);
    if (cached) return cached;

    // Self-author fast path — same rationale as fetchBook above. Author
    // viewing or editing a draft chapter (is_published=false) needs to
    // bypass anon RLS via the SECURITY DEFINER RPC.
    if (actorUserId) {
      try {
        const actorUuid = UUID_RE.test(actorUserId) ? actorUserId : await resolveSupabaseUserId(actorUserId);
        if (actorUuid) {
          const { data, error } = await supabase.rpc("fetch_author_chapter_one", {
            p_actor_id: actorUuid,
            p_chapter_id: chapterId,
          });
          if (error) throw error;
          if (data?.ok && data.row) {
            const mapped = mapRowToChapter(data.row);
            if (mapped) BOOK_CHAPTER_CACHE.set(chapterId, mapped);
            return mapped;
          }
        }
      } catch (rpcErr) {
        console.error("[books-supabase] fetch_author_chapter_one failed:", rpcErr?.message);
      }
    }

    const { data, error } = await supabase
      .from("chapters")
      .select(CHAPTER_SELECT)
      .eq(idColumnFor(chapterId), chapterId)
      .maybeSingle();
    if (error) throw error;
    const mapped = mapRowToChapter(data);
    if (mapped) BOOK_CHAPTER_CACHE.set(chapterId, mapped);
    return mapped;
  }

  // ── Library / bookmarks (legacy called this "bookLibrary") ──
  // Reads book_bookmarks for the user, joining the underlying books row
  // so the Library card has full book context in one round-trip. The
  // BOOK_SELECT.replace(...) strips the profiles author-join because
  // Library cards don't display the author; keeps the query lean.
  //
  // RLS dependency: book_bookmarks must allow anon SELECT (see
  // migration_book_bookmarks_rls.sql) for this to return rows under
  // USE_SUPABASE_AUTH=false. Without that policy, anon clients
  // silently get zero rows even when book_bookmarks contains matches
  // for the user_id.
  async fetchBookLibraryByUser({ userId, lastId, limit = 20 }) {
    if (!userId) return { documents: [], total: 0 };
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) return { documents: [], total: 0 };

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
    return { documents, total: documents.length };
  }

  // ── Likes (book_likes) ──
  // book_likes has a composite PK `(book_id, user_id)` so the synthesized
  // legacy `$id` is `${book_id}::${user_id}` — kept for back-compat with
  // Appwrite-shaped consumers that index by $id.

  /**
   * All likes on a book. Used by trending/score recomputes and "who liked this" UIs.
   * @param {object} args
   * @param {string} args.bookId
   * @returns {Promise<{documents:object[],total:number}>}
   */
  async getBookLikes({ bookId }) {
    // All `get*` methods return `{ documents, total }` to match the
    // Appwrite shape every consumer reads (`result.total` for counts,
    // `result.documents` for list iteration). Forgetting `total` was
    // the post-flip crash root cause: BookLibraryCard set state to
    // undefined and FormatNumber threw on .toString().
    //
    // `total` is read from the denormalized `books.likes_count` column
    // (kept current by triggers), NOT from counting rows in `book_likes`.
    // `book_likes` has RLS that only lets a user SELECT their own row,
    // so a per-card .from("book_likes").select() returns 1 row for the
    // signed-in user (or 0 for anon) regardless of the real total. The
    // author of a popular book seeing "1 like" on their own work is the
    // bug that motivated this change. `documents` is still returned for
    // any caller that wants to iterate (even if RLS will trim it to the
    // caller's own row).
    if (!bookId) return { documents: [], total: 0 };
    const bookUuid = await resolveBookUuid(bookId);
    if (!bookUuid) return { documents: [], total: 0 };

    const [{ data: likesRows, error: likesErr }, { data: bookRow }] = await Promise.all([
      supabase.from("book_likes").select("book_id, user_id, created_at").eq("book_id", bookUuid),
      supabase.from("books").select("likes_count").eq("id", bookUuid).maybeSingle(),
    ]);
    if (likesErr) throw likesErr;

    const documents = (likesRows || []).map((row) => ({
      $id: `${row.book_id}::${row.user_id}`,
      book: row.book_id,
      likeOwner: row.user_id,
      $createdAt: row.created_at,
    }));
    const total = bookRow?.likes_count ?? documents.length;
    return { documents, total };
  }

  /**
   * Returns the caller's like record for a book, or empty if not liked.
   * BookCatalogCard / BookCard heart-icon state reads this on mount.
   * @param {object} args
   * @param {string} args.bookId
   * @param {string} args.likeOwner   User id (Appwrite hex or UUID).
   * @returns {Promise<{documents:object[]}>}
   */
  async getBookLikeByOwner({ bookId, likeOwner }) {
    const userUuid = await resolveSupabaseUserId(likeOwner);
    if (!userUuid || !bookId) return { documents: [] };
    const bookUuid = await resolveBookUuid(bookId);
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

  /**
   * Add a like. Routes through the `submit_book_like` SECURITY DEFINER
   * RPC (phase3) which bypasses anon RLS and is idempotent.
   * @param {object} args
   * @param {string} args.bookId
   * @param {string} args.likeOwner
   * @returns {Promise<{documents:object[]}>}
   */
  async createBookLike({ bookId, likeOwner }) {
    const userUuid = await resolveSupabaseUserId(likeOwner);
    if (!userUuid) throw new Error("createBookLike: cannot resolve user");
    const bookUuid = await resolveBookUuid(bookId);
    if (!bookUuid) throw new Error("createBookLike: cannot resolve book");
    const { error } = await supabase.from("book_likes").insert({ book_id: bookUuid, user_id: userUuid });
    if (error && error.code !== "23505") throw error;
    return { $id: `${bookUuid}::${userUuid}` };
  }

  /**
   * Remove a like. Caller passes the synthesized `${bookId}::${userId}`
   * id from getBookLikeByOwner. Routes through `submit_book_unlike` RPC.
   * @param {object} args
   * @param {string} args.bookLikeId   `${bookId}::${userId}` composite.
   * @returns {Promise<void>}
   */
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
  // The "Library" UI is the user's saved-books shelf. Legacy schema
  // called the storage table `book_libraries`; the Supabase migration
  // renamed it `book_bookmarks` for clarity. Method names retain the
  // legacy "library" verb so consumers don't have to rename.

  /**
   * All bookmark records for a book. "Who bookmarked this" / counts.
   * @param {object} args
   * @param {string} args.bookId
   * @returns {Promise<{documents:object[],total:number}>}
   */
  async getBookLibraries({ bookId }) {
    if (!bookId) return { documents: [], total: 0 };
    const bookUuid = await resolveBookUuid(bookId);
    if (!bookUuid) return { documents: [], total: 0 };
    const { data, error } = await supabase
      .from("book_bookmarks")
      .select("book_id, user_id, created_at")
      .eq("book_id", bookUuid);
    if (error) throw error;
    const documents = (data || []).map((row) => ({
      $id: `${row.user_id}::${row.book_id}`,
      book: row.book_id,
      user: row.user_id,
      $createdAt: row.created_at,
    }));
    return { documents, total: documents.length };
  }

  /**
   * Returns the caller's bookmark record for a book, or empty if not bookmarked.
   * Drives the bookmark icon's filled/empty state.
   *
   * (Note: method name preserves the legacy typo "Libray" — kept so we
   * don't have to chase ~10 call sites in book-info / BookLibraryCard.)
   *
   * @param {object} args
   * @param {string} args.bookId
   * @param {string} args.userId
   * @returns {Promise<{documents:object[]}>}
   */
  async getBookLibrayByUser({ bookId, userId }) {
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid || !bookId) return { documents: [] };
    const bookUuid = await resolveBookUuid(bookId);
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

  /**
   * Add a bookmark. Routes through `submit_book_bookmark` RPC; idempotent.
   * @param {object} args
   * @param {string} args.bookId
   * @param {string} args.userId
   * @returns {Promise<{documents:object[]}>}
   */
  async createBookLibrary({ bookId, userId }) {
    const userUuid = await resolveSupabaseUserId(userId);
    if (!userUuid) throw new Error("createBookLibrary: cannot resolve user");
    const bookUuid = await resolveBookUuid(bookId);
    if (!bookUuid) throw new Error("createBookLibrary: cannot resolve book");
    const { error } = await supabase.from("book_bookmarks").insert({ user_id: userUuid, book_id: bookUuid });
    if (error && error.code !== "23505") throw error;
    return { $id: `${userUuid}::${bookUuid}` };
  }

  /**
   * Remove a bookmark. Caller passes `${bookId}::${userId}` composite id.
   * Routes through `submit_book_unbookmark` RPC.
   * @param {object} args
   * @param {string} args.bookLibraryId   Composite id from getBookLibrayByUser.
   * @returns {Promise<void>}
   */
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

  /**
   * Full-text-ish search across book title + tags. Backs the search
   * tab's books results. Cursor-based pagination via `cursorId`.
   *
   * @param {object} args
   * @param {string} [args.searchQuery=""]
   * @param {number} [args.limit=10]
   * @param {string|null} [args.cursorId]
   * @returns {Promise<{documents:object[],lastId:string|null,hasMore:boolean}>}
   */
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
        .eq(idColumnFor(cursorId), cursorId)
        .maybeSingle();
      if (cursorRow?.created_at) q = q.lt("created_at", cursorRow.created_at);
    }
    const { data, error } = await q;
    if (error) throw error;
    return { documents: (data || []).map(mapRowToBook) };
  }

  // ── Continue reading ──

  /**
   * Books the user has started but not finished — drives the home-tab
   * "Continue Reading" rail. Reads `book_reads` joined with `books`,
   * sorted by last-read timestamp.
   *
   * @param {object} args
   * @param {string} args.userId
   * @returns {Promise<object[]>}
   */
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
  /**
   * Per-book continue-reading record — used by book-info to surface the
   * "Resume Chapter X" CTA when a user revisits a book they've started.
   * Returns null when there's no progress for this user/book pair.
   *
   * @param {object} args
   * @param {string} args.userId
   * @param {string} args.bookId
   * @returns {Promise<object|null>}
   */
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

  // ── Chapter comments ──
  // Book-level comment proxies (getBookComments / fetchBookComments /
  // createBookComment) were removed May 2026 — book-level comments are
  // no longer surfaced anywhere in the app, the BookInfoStats Comments
  // button now opens an aggregator over chapter_comments instead. The
  // chapter-comment proxies below stay because they're still consumed
  // by BookChapterCommentModal in the reading flow.
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

  // Chapter likes — native Supabase. Backed by the chapter_likes table
  // (migration_chapter_likes.sql), composite PK (chapter_id, user_id)
  // prevents double-likes. The denormalized chapters.likes_count is
  // maintained by trg_chapter_likes_count so callers that need a count
  // can read it directly off the chapter row.
  //
  // Legacy callers pass either Appwrite hex IDs or UUIDs for both the
  // chapter and the owner. Resolve to UUIDs before any write/read.
  async _resolveChapterUuidSb(rawId) {
    if (!rawId) return null;
    if (UUID_RE.test(rawId)) return rawId;
    const { data } = await supabase
      .from("chapters")
      .select("id")
      .eq("legacy_appwrite_id", rawId)
      .maybeSingle();
    return data?.id || null;
  }

  // ── Chapter-level engagement (chapter_likes) ──

  /**
   * All likes on a specific chapter.
   * @param {object} args
   * @param {string} args.bookChapterId
   * @returns {Promise<{documents:object[],total:number}>}
   */
  async getBookChapterLikes({ bookChapterId }) {
    const chapterUuid = await this._resolveChapterUuidSb(bookChapterId);
    if (!chapterUuid) return { documents: [], total: 0 };
    const { data, count, error } = await supabase
      .from("chapter_likes")
      .select("user_id, created_at", { count: "exact" })
      .eq("chapter_id", chapterUuid);
    if (error) {
      console.error("[books-supabase] getBookChapterLikes:", error.message);
      return { documents: [], total: 0 };
    }
    // Appwrite-shaped envelope so legacy consumers (which may read
    // `.documents.length` or iterate `.documents`) keep working.
    return { documents: (data || []).map((r) => ({ likeOwner: r.user_id, $createdAt: r.created_at })), total: count ?? (data?.length || 0) };
  }

  /**
   * Caller's like record for a chapter, or empty if not liked.
   * BookChapterFooter's heart icon reads this on chapter open.
   * @param {object} args
   * @param {string} args.bookChapterId
   * @param {string} args.likeOwner
   * @returns {Promise<{documents:object[]}>}
   */
  async getBookChapterLikeByOwner({ bookChapterId, likeOwner }) {
    const [chapterUuid, userUuid] = await Promise.all([
      this._resolveChapterUuidSb(bookChapterId),
      resolveSupabaseUserId(likeOwner),
    ]);
    if (!chapterUuid || !userUuid) return { documents: [], total: 0 };
    const { data, error } = await supabase
      .from("chapter_likes")
      .select("user_id, created_at")
      .eq("chapter_id", chapterUuid)
      .eq("user_id", userUuid)
      .maybeSingle();
    if (error) {
      console.error("[books-supabase] getBookChapterLikeByOwner:", error.message);
      return { documents: [], total: 0 };
    }
    if (!data) return { documents: [], total: 0 };
    // Synthesize a stable composite "id" so callers that key off
    // doc.$id for delete (legacy uses $id) can still target the row.
    const composite = `${chapterUuid}:${userUuid}`;
    return {
      documents: [{ $id: composite, likeOwner: data.user_id, $createdAt: data.created_at, _chapter_id: chapterUuid, _user_id: userUuid }],
      total: 1,
    };
  }

  /**
   * Add a chapter like. Idempotent via `submit_chapter_like` RPC.
   * @param {object} args
   * @param {string} args.bookChapterId
   * @param {string} args.likeOwner
   * @returns {Promise<{documents:object[]}>}
   */
  async createBookChapterLike({ bookChapterId, likeOwner }) {
    const [chapterUuid, userUuid] = await Promise.all([
      this._resolveChapterUuidSb(bookChapterId),
      resolveSupabaseUserId(likeOwner),
    ]);
    if (!chapterUuid || !userUuid) {
      console.error("[books-supabase] createBookChapterLike: cannot resolve chapter or user");
      return null;
    }
    const { error } = await supabase
      .from("chapter_likes")
      .upsert({ chapter_id: chapterUuid, user_id: userUuid }, { onConflict: "chapter_id,user_id", ignoreDuplicates: true });
    if (error) {
      console.error("[books-supabase] createBookChapterLike:", error.message);
      return null;
    }
    return { $id: `${chapterUuid}:${userUuid}`, likeOwner: userUuid, _chapter_id: chapterUuid, _user_id: userUuid };
  }

  /**
   * Remove a chapter like. Caller passes the composite id from
   * getBookChapterLikeByOwner; bookChapterId/likeOwner are accepted
   * for legacy-callers compat but the RPC is keyed off the composite.
   *
   * @param {object} args
   * @param {string} args.bookChapterLikeId   `${chapterId}::${userId}` composite.
   * @param {string} [args.bookChapterId]     Legacy compat.
   * @param {string} [args.likeOwner]         Legacy compat.
   * @returns {Promise<void>}
   */
  async deleteBookChapterLike({ bookChapterLikeId, bookChapterId, likeOwner } = {}) {
    // Two call shapes: legacy passes a synthetic composite id ("chapterUuid:userUuid")
    // OR explicit chapter+owner. Accept both so existing callers don't
    // need to change.
    let chapterUuid = null;
    let userUuid = null;
    if (typeof bookChapterLikeId === "string" && bookChapterLikeId.includes(":")) {
      const [c, u] = bookChapterLikeId.split(":");
      chapterUuid = UUID_RE.test(c) ? c : await this._resolveChapterUuidSb(c);
      userUuid = UUID_RE.test(u) ? u : await resolveSupabaseUserId(u);
    } else {
      [chapterUuid, userUuid] = await Promise.all([
        this._resolveChapterUuidSb(bookChapterId),
        resolveSupabaseUserId(likeOwner),
      ]);
    }
    if (!chapterUuid || !userUuid) {
      console.error("[books-supabase] deleteBookChapterLike: cannot resolve chapter or user");
      return null;
    }
    const { error } = await supabase
      .from("chapter_likes")
      .delete()
      .eq("chapter_id", chapterUuid)
      .eq("user_id", userUuid);
    if (error) {
      console.error("[books-supabase] deleteBookChapterLike:", error.message);
      return null;
    }
    return { ok: true };
  }
}
