#!/usr/bin/env node
/* eslint-disable no-console */

/*
  scripts/backfill-books.js
  ─────────────────────────────────────────────────────────────────────────
  One-shot reconciliation: copy historical Appwrite books +
  chapters + engagement (likes, reads, ratings, bookmarks) +
  comments (book / chapter / inline) into Supabase.

  Run after lib/books-dual-write.js + the wiring in books-appwrite.js,
  book-reads-appwrite.js, book-rating-appwrite.js, book-comments-appwrite.js,
  and book-inline-comments-appwrite.js have shipped — so historical data
  converges with newly dual-written rows.

  Passes (run in order — children require parents to exist):
    1  books         → public.books             (PK on legacy_appwrite_id)
    2  chapters      → public.chapters          (PK on legacy_appwrite_id)
    3  book_likes    → public.book_likes        (composite PK book_id,user_id)
    4  reads         → SKIPPED (Appwrite booksReads is per-book aggregate;
                                chapter_reads is the source of truth for
                                per-book totals — sum read_count grouped
                                by chapter.book_id)
    5  book_ratings  → public.book_ratings      (composite PK book_id,user_id)
    6  bookmarks     → public.book_bookmarks    (composite PK book_id,user_id)
    7  comments      → public.book_comments     (PK on legacy_appwrite_id)
    8  chap_comments → public.chapter_comments  (PK on legacy_appwrite_id)
    9  chap_likes    → public.chapter_likes     (composite PK chapter_id,user_id)
    10 chap_reads    → public.chapter_reads     (composite PK chapter_id,user_id)
    11 inline        → SKIPPED (anchor model mismatch — see books-dual-write.js)

  Migration prereq: the relevant Supabase tables must already have
  `legacy_appwrite_id text` columns where this script writes them. Most
  of them were added during earlier migrations; if a column is missing,
  the script logs the failed pass and continues.

  Usage:
    APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1 \
    APPWRITE_PROJECT_ID=66b8be7400121b5d4697 \
    APPWRITE_API_KEY=server-key-with-databases-read \
    APPWRITE_DATABASE_ID=66b32b3600246bc34956 \
    APPWRITE_BOOKS_COLLECTION_ID=... \
    APPWRITE_BOOK_CHAPTERS_COLLECTION_ID=... \
    APPWRITE_BOOK_LIKES_COLLECTION_ID=... \
    APPWRITE_BOOK_READS_COLLECTION_ID=... \
    APPWRITE_BOOK_RATINGS_COLLECTION_ID=... \
    APPWRITE_BOOK_LIBRARY_COLLECTION_ID=... \
    APPWRITE_BOOK_COMMENTS_COLLECTION_ID=... \
    APPWRITE_BOOK_CHAPTER_COMMENTS_COLLECTION_ID=... \
    APPWRITE_BOOK_CHAPTER_LIKES_COLLECTION_ID=... \
    APPWRITE_BOOK_CHAPTER_READS_COLLECTION_ID=... \
    APPWRITE_BOOK_INLINE_COMMENTS_COLLECTION_ID=... \
    SUPABASE_URL=https://your-project.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=eyJhbGc... \
    node scripts/backfill-books.js

    Optional:
      DRY_RUN=1   No writes; walk + resolve only.
      LIMIT=500   First N rows from each collection (smoke).
      VERBOSE=1   Log every skipped row.
      ONLY=books|chapters|likes|reads|ratings|bookmarks|comments|chap_comments|chap_likes|chap_reads|inline
                  Run just one pass (chain via & to run several specific ones).

  Idempotency:
    All passes use ON CONFLICT (legacy_appwrite_id or composite PK).
    Re-running is safe; metadata edits propagate via upsert-with-update on
    pass 1/2/7/8/9, while engagement passes use ignoreDuplicates so we
    don't trample later web-side rating edits.

  Security:
    Requires SUPABASE_SERVICE_ROLE_KEY — RLS would otherwise block these
    inserts. Treat the key like a root credential.
*/

const { Client, Databases, Query } = require("node-appwrite");
const { createClient } = require("@supabase/supabase-js");

const env = (k, fallback) => {
  const v = process.env[k];
  if (v) return v;
  if (fallback !== undefined) return fallback;
  console.error(`Missing env var: ${k}`);
  process.exit(1);
};

const APPWRITE_ENDPOINT = env("APPWRITE_ENDPOINT", "https://fra.cloud.appwrite.io/v1");
const APPWRITE_PROJECT_ID = env("APPWRITE_PROJECT_ID");
const APPWRITE_API_KEY = env("APPWRITE_API_KEY");
const APPWRITE_DATABASE_ID = env("APPWRITE_DATABASE_ID");
const COLL = {
  books: env("APPWRITE_BOOKS_COLLECTION_ID"),
  chapters: process.env.APPWRITE_BOOK_CHAPTERS_COLLECTION_ID || null,
  likes: process.env.APPWRITE_BOOK_LIKES_COLLECTION_ID || null,
  reads: process.env.APPWRITE_BOOK_READS_COLLECTION_ID || null,
  ratings: process.env.APPWRITE_BOOK_RATINGS_COLLECTION_ID || null,
  bookmarks: process.env.APPWRITE_BOOK_LIBRARY_COLLECTION_ID || null,
  comments: process.env.APPWRITE_BOOK_COMMENTS_COLLECTION_ID || null,
  chapComments: process.env.APPWRITE_BOOK_CHAPTER_COMMENTS_COLLECTION_ID || null,
  chapLikes: process.env.APPWRITE_BOOK_CHAPTER_LIKES_COLLECTION_ID || null,
  chapReads: process.env.APPWRITE_BOOK_CHAPTER_READS_COLLECTION_ID || null,
  inline: process.env.APPWRITE_BOOK_INLINE_COMMENTS_COLLECTION_ID || null,
};
const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : null;
const VERBOSE = process.env.VERBOSE === "1";
const ONLY = (process.env.ONLY || "").toLowerCase();

const PAGE_SIZE = 100;
// Default 500 works for most passes (small rows). For chapters, content
// blobs can be huge — Postgres statement_timeout fires before 500 rows
// finish upserting. Override with UPSERT_BATCH_SIZE=20 (or smaller) for
// the chapters pass specifically.
const UPSERT_BATCH_SIZE = process.env.UPSERT_BATCH_SIZE
  ? Number(process.env.UPSERT_BATCH_SIZE)
  : 500;

const aw = new Client().setEndpoint(APPWRITE_ENDPOINT).setProject(APPWRITE_PROJECT_ID).setKey(APPWRITE_API_KEY);
const awDb = new Databases(aw);
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Per-table hex→uuid resolution caches. Filled lazily as each pass walks
// rows, then reused by every subsequent pass that joins against the same
// parent (e.g., chapters filling profileCache helps the comments passes).
const profileCache = new Map();
const bookCache = new Map();
const chapterCache = new Map();
const bookCommentCache = new Map();
const chapterCommentCache = new Map();
const inlineCommentCache = new Map();

const resolveBatch = async (table, hexIds, cache) => {
  const unresolved = hexIds.filter((h) => h && !cache.has(h));
  if (!unresolved.length) return;
  for (let i = 0; i < unresolved.length; i += 1000) {
    const slice = unresolved.slice(i, i + 1000);
    const { data, error } = await sb.from(table).select("id, legacy_appwrite_id").in("legacy_appwrite_id", slice);
    if (error) throw new Error(`${table} lookup failed: ${error.message}`);
    const found = new Map();
    for (const r of data || []) found.set(r.legacy_appwrite_id, r.id);
    for (const h of slice) cache.set(h, found.get(h) || null);
  }
};

async function* iterAppwrite(collectionId) {
  let cursor = null;
  while (true) {
    const queries = [Query.limit(PAGE_SIZE), Query.orderAsc("$id")];
    if (cursor) queries.push(Query.cursorAfter(cursor));
    const response = await awDb.listDocuments(APPWRITE_DATABASE_ID, collectionId, queries);
    const docs = response?.documents || [];
    if (!docs.length) break;
    for (const d of docs) yield d;
    cursor = docs[docs.length - 1].$id;
    if (docs.length < PAGE_SIZE) break;
  }
}

const extractRel = (v) => {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return extractRel(v[0]);
  return v?.$id || v?.id || null;
};

// Generic streaming pass: walks an Appwrite collection, resolves
// foreign-key hexes via supplied resolvers, and upserts mapped rows
// into a Supabase table. Passes return per-stage counters for the
// summary at the end.
async function runPass({
  label,
  collectionId,
  table,
  conflictTarget,
  ignoreDuplicates = false,
  resolveSpec, // { hex_field: [resolverTable, cache, requiredKey] }
  buildRow,
}) {
  if (!collectionId) {
    console.log(`[${label}] skipping — collection id not set`);
    return { scanned: 0, prepared: 0, upserted: 0, skippedNoMap: 0, errors: 0 };
  }
  console.log(`[${label}] starting`);
  let scanned = 0,
    prepared = 0,
    skippedNoMap = 0,
    upserted = 0,
    errors = 0;
  let buffer = [];
  let pending = [];

  const flush = async () => {
    if (!buffer.length) return;
    if (DRY_RUN) {
      upserted += buffer.length;
      buffer = [];
      return;
    }
    const { error } = await sb.from(table).upsert(buffer, { onConflict: conflictTarget, ignoreDuplicates });
    if (error) {
      errors += 1;
      console.error(`[${label}] upsert failed (${buffer.length}):`, error.message);
    } else {
      upserted += buffer.length;
    }
    buffer = [];
  };

  const processBatch = async () => {
    if (!pending.length) return;
    // Collect all hex ids needed across all FK fields, batch-resolve,
    // then apply per-row.
    const hexBuckets = {};
    for (const [field, [resolverTable, cache]] of Object.entries(resolveSpec)) {
      hexBuckets[field] = { table: resolverTable, cache, hexes: new Set() };
    }
    for (const d of pending) {
      for (const field of Object.keys(resolveSpec)) {
        const hex = extractRel(d[field]);
        if (hex) hexBuckets[field].hexes.add(hex);
      }
    }
    await Promise.all(
      Object.values(hexBuckets).map((b) => resolveBatch(b.table, [...b.hexes], b.cache)),
    );

    for (const d of pending) {
      const resolved = {};
      let missing = false;
      for (const [field, [, cache, requiredKey]] of Object.entries(resolveSpec)) {
        const hex = extractRel(d[field]);
        const uuid = hex ? cache.get(hex) : null;
        resolved[requiredKey] = uuid;
        if (!uuid) missing = true;
      }
      if (missing) {
        skippedNoMap += 1;
        if (VERBOSE) {
          const summary = Object.entries(resolved)
            .map(([k, v]) => `${k}=${v ? "ok" : "?"}`)
            .join(" ");
          console.log(`  skip ${label} ${d.$id}: ${summary}`);
        }
        continue;
      }
      const row = buildRow(d, resolved);
      if (!row) {
        skippedNoMap += 1;
        continue;
      }
      prepared += 1;
      buffer.push(row);
      if (buffer.length >= UPSERT_BATCH_SIZE) await flush();
    }
    pending = [];
  };

  for await (const doc of iterAppwrite(collectionId)) {
    scanned += 1;
    pending.push(doc);
    if (pending.length >= PAGE_SIZE) await processBatch();
    if (LIMIT && scanned >= LIMIT) break;
  }
  await processBatch();
  await flush();

  console.log(
    `[${label}] scanned=${scanned} prepared=${prepared} upserted=${upserted} skippedNoMap=${skippedNoMap} errors=${errors}`,
  );
  return { scanned, prepared, upserted, skippedNoMap, errors };
}

// ── Pass 1: books ────────────────────────────────────────────────────────
// Status case-folding: mobile/Appwrite stores "Draft" / "Publish" /
// "Ongoing" / "Completed"; web/Supabase uses lowercase 'draft' /
// 'ongoing' / 'completed' (no 'publish' — published_at flips instead).
const MOBILE_TO_SUPABASE_BOOK_STATUS = {
  draft: "draft",
  publish: "ongoing",
  published: "ongoing",
  ongoing: "ongoing",
  completed: "completed",
};
const normalizeBookStatus = (s) => {
  if (typeof s !== "string") return "draft";
  return MOBILE_TO_SUPABASE_BOOK_STATUS[s.toLowerCase()] || "draft";
};

const passBooks = () =>
  runPass({
    label: "books",
    collectionId: COLL.books,
    table: "books",
    conflictTarget: "legacy_appwrite_id",
    resolveSpec: { uploader: ["profiles", profileCache, "author_id"] },
    buildRow: (d, { author_id }) => {
      const status = normalizeBookStatus(d.status);
      return {
        legacy_appwrite_id: d.$id,
        author_id,
        title: d.title || null,
        description: d.synopsis || d.description || null,
        cover_url: d.thumbnail || d.cover_url || null,
        status,
        // For non-draft historical rows, seed published_at from the
        // Appwrite $createdAt — close enough for the "published books"
        // filter to find them. Real publish-time data isn't stored on
        // Appwrite so this is the best-effort fallback.
        ...(status !== "draft" ? { published_at: d.$createdAt || new Date().toISOString() } : {}),
        tags: Array.isArray(d.tags) ? d.tags : null,
        genre: d.genre || null,
        is_public: d.is_public !== false,
      };
    },
  });

// ── Pass 2: chapters ─────────────────────────────────────────────────────
// Schema (per books-supabase.js): table is `chapters`. Columns include
// chapter_number (NOT order), is_published bool (NOT status string), and
// cover_url (NOT thumbnail). Translate the Appwrite shape on the way in.
const passChapters = () =>
  runPass({
    label: "chapters",
    collectionId: COLL.chapters,
    table: "chapters",
    conflictTarget: "legacy_appwrite_id",
    resolveSpec: { book: ["books", bookCache, "book_id"] },
    buildRow: (d, { book_id }) => ({
      legacy_appwrite_id: d.$id,
      book_id,
      title: d.title || null,
      content: d.content || null,
      cover_url: d.thumbnail || null,
      is_published:
        typeof d.status === "string"
          ? d.status.toLowerCase() === "publish" || d.status.toLowerCase() === "published"
          : false,
      chapter_number: typeof d.order === "number" ? d.order : null,
    }),
  });

// ── Pass 3: book_likes ───────────────────────────────────────────────────
const passLikes = () =>
  runPass({
    label: "likes",
    collectionId: COLL.likes,
    table: "book_likes",
    conflictTarget: "book_id,user_id",
    ignoreDuplicates: true,
    resolveSpec: {
      book: ["books", bookCache, "book_id"],
      likeOwner: ["profiles", profileCache, "user_id"],
    },
    buildRow: (_d, { book_id, user_id }) => ({ book_id, user_id }),
  });

// ── Pass 4: book_reads (SKIPPED) ─────────────────────────────────────────
// The Appwrite `booksReads` collection is a PER-BOOK aggregate (one row
// per book, with totalReads / monthlyReads / lastReadAt — populated by a
// server-side function). It has NO user field, so it can't be unfolded
// into Supabase's composite-PK book_reads table (user_id, book_id).
//
// The chap_reads pass (#10 below) captures the per-user-chapter history
// instead. Anywhere the legacy code asked "how many times has book X
// been read", consumers should sum chapter_reads.read_count grouped by
// the chapter's parent book_id — that's strictly better than the old
// per-book aggregate because it's derivable on demand and stays in sync
// without a separate maintenance path.
//
// The Supabase book_reads table still receives live writes from
// dualWriteBookRead (called on every chapter open), so the
// "Continue Reading" widget continues to work for users who open a
// chapter post-flip. We deliberately do NOT historically reconstruct
// book_reads from chapter_reads — for old readers, "Continue Reading"
// will populate the moment they next open any chapter.
const passReads = async () => {
  console.log("[reads] skipped — booksReads is per-book aggregate; chapter_reads is the source of truth for read activity (sum read_count grouped by chapter.book_id for per-book totals)");
  return { scanned: 0, prepared: 0, upserted: 0, skippedNoMap: 0, errors: 0 };
};

// ── Pass 5: book_ratings ─────────────────────────────────────────────────
const passRatings = () =>
  runPass({
    label: "ratings",
    collectionId: COLL.ratings,
    table: "book_ratings",
    conflictTarget: "book_id,user_id",
    ignoreDuplicates: true, // Don't clobber later web-side edits.
    resolveSpec: {
      book: ["books", bookCache, "book_id"],
      user: ["profiles", profileCache, "user_id"],
    },
    buildRow: (d, { book_id, user_id }) => ({
      book_id,
      user_id,
      rating: typeof d.rating === "number" ? d.rating : null,
      review: d.review || null,
    }),
  });

// ── Pass 6: bookmarks (library) ──────────────────────────────────────────
const passBookmarks = () =>
  runPass({
    label: "bookmarks",
    collectionId: COLL.bookmarks,
    table: "book_bookmarks",
    conflictTarget: "user_id,book_id",
    ignoreDuplicates: true,
    resolveSpec: {
      book: ["books", bookCache, "book_id"],
      user: ["profiles", profileCache, "user_id"],
    },
    buildRow: (_d, { book_id, user_id }) => ({ book_id, user_id }),
  });

// ── Pass 7: book_comments ────────────────────────────────────────────────
const passComments = () =>
  runPass({
    label: "comments",
    collectionId: COLL.comments,
    table: "book_comments",
    conflictTarget: "legacy_appwrite_id",
    resolveSpec: {
      book: ["books", bookCache, "book_id"],
      commentOwner: ["profiles", profileCache, "user_id"],
    },
    buildRow: (d, { book_id, user_id }) => ({
      legacy_appwrite_id: d.$id,
      book_id,
      user_id,
      content: d.comment || "",
      // Top-level comments only on this pass. Appwrite stored replies in
      // booksCommentRepliesCollectionId — a separate collection not wired
      // into this backfill. New replies converge via the live dual-write;
      // historical replies are a follow-up backfill if/when needed.
      parent_id: null,
    }),
  });

// ── Pass 8: chapter_comments ─────────────────────────────────────────────
// Resolves chapters from `chapters` (not `book_chapters` — see notes in
// lib/books-dual-write.js).
const passChapterComments = () =>
  runPass({
    label: "chap_comments",
    collectionId: COLL.chapComments,
    table: "chapter_comments",
    conflictTarget: "legacy_appwrite_id",
    resolveSpec: {
      booksChapter: ["chapters", chapterCache, "chapter_id"],
      commentOwner: ["profiles", profileCache, "user_id"],
    },
    buildRow: (d, { chapter_id, user_id }) => ({
      legacy_appwrite_id: d.$id,
      chapter_id,
      user_id,
      content: d.comment || "",
      parent_id: null,
    }),
  });

// ── Pass 9: chapter_likes ───────────────────────────────────────────────
// Mirrors the book_likes pass for chapter-level likes. Appwrite's
// booksChaptersLike collection stores docs with `booksChapter` (chapter
// rel) + `likeOwner` (user rel). The Supabase table is chapter_likes —
// composite PK (chapter_id, user_id) — created by
// migration_chapter_likes.sql. Re-runs are no-ops thanks to
// ignoreDuplicates on the composite PK; the trigger on the destination
// table maintains chapters.likes_count automatically.
const passChapterLikes = () =>
  runPass({
    label: "chap_likes",
    collectionId: COLL.chapLikes,
    table: "chapter_likes",
    conflictTarget: "chapter_id,user_id",
    ignoreDuplicates: true,
    resolveSpec: {
      booksChapter: ["chapters", chapterCache, "chapter_id"],
      likeOwner: ["profiles", profileCache, "user_id"],
    },
    buildRow: (_d, { chapter_id, user_id }) => ({ chapter_id, user_id }),
  });

// ── Pass 10: chapter_reads ──────────────────────────────────────────────
// Per-(user, chapter) read tracking. Each Appwrite booksChaptersRead doc
// has user / book / chapter relationships + a readCount integer that
// bumps on re-reads. The Supabase chapter_reads table mirrors that with
// a composite PK (chapter_id, user_id) + read_count + last_read_at.
//
// `book` rel is captured by Appwrite for analytics convenience but the
// Supabase row only needs (chapter_id, user_id, read_count) — the chapter
// already knows its parent book via chapters.book_id, so we drop `book`
// from the resolveSpec and skip rows whose chapter mirror isn't found.
//
// last_read_at uses the Appwrite doc's $updatedAt where available
// (captures the latest read), falling back to $createdAt.
const passChapterReads = () =>
  runPass({
    label: "chap_reads",
    collectionId: COLL.chapReads,
    table: "chapter_reads",
    conflictTarget: "chapter_id,user_id",
    ignoreDuplicates: true, // Don't clobber post-flip live reads.
    resolveSpec: {
      chapter: ["chapters", chapterCache, "chapter_id"],
      user: ["profiles", profileCache, "user_id"],
    },
    buildRow: (d, { chapter_id, user_id }) => ({
      chapter_id,
      user_id,
      read_count: typeof d.readCount === "number" && d.readCount > 0 ? d.readCount : 1,
      last_read_at: d.$updatedAt || d.$createdAt || new Date().toISOString(),
    }),
  });

// ── Pass 11: inline (SKIPPED) ───────────────────────────────────────────
// Anchor model mismatch — Mobile/Appwrite uses anchorKey + ordinal, web's
// chapter_inline_comments requires a thread_id pointing at a row keyed by
// (chapter_id, start_offset, end_offset, anchor_text). Bridging needs a
// one-shot anchor→offset migration that's out of scope for this pass.
const passInline = async () => {
  console.log("[inline] skipped — anchor model mismatch (see books-dual-write.js for details)");
  return { scanned: 0, prepared: 0, upserted: 0, skippedNoMap: 0, errors: 0 };
};

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[backfill-books] dryRun=${DRY_RUN} limit=${LIMIT ?? "none"} only=${ONLY || "all"}`);
  console.log(`[backfill-books] supabase ${SUPABASE_URL}`);

  const reports = {};
  const want = (k) => !ONLY || ONLY === k;

  // Order matters: parents before children. The bookCache + chapterCache
  // populated in passes 1+2 make the comment passes O(1) per row.
  if (want("books")) reports.books = await passBooks();
  if (want("chapters")) reports.chapters = await passChapters();
  if (want("likes")) reports.likes = await passLikes();
  if (want("reads")) reports.reads = await passReads();
  if (want("ratings")) reports.ratings = await passRatings();
  if (want("bookmarks")) reports.bookmarks = await passBookmarks();
  if (want("comments")) reports.comments = await passComments();
  if (want("chap_comments")) reports.chap_comments = await passChapterComments();
  if (want("chap_likes")) reports.chap_likes = await passChapterLikes();
  if (want("chap_reads")) reports.chap_reads = await passChapterReads();
  if (want("inline")) reports.inline = await passInline();

  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  for (const [k, r] of Object.entries(reports)) {
    console.log(
      `${k.padEnd(14)}  scanned=${r.scanned}  upserted=${r.upserted}  skippedNoMap=${r.skippedNoMap}  errors=${r.errors}`,
    );
  }
  console.log("──────────────────────────────────────────────");
  if (Object.values(reports).some((r) => r.errors > 0)) process.exit(1);
})().catch((e) => {
  console.error("Fatal:", e?.message || e);
  process.exit(1);
});
