// Books dual-write helpers — covers create/update/delete + engagement
// (likes, library, reads, ratings) + comments (book + chapter top-level
// and replies). Mobile reads books from Appwrite (USE_SUPABASE_BOOKS=false
// in production), but every Appwrite write also lands in Supabase via
// these helpers so web can see mobile activity. Mirrors the dual-write
// pattern used by safety / notifications / video / posts.
//
// Why this lives in its own file:
//   The books surface has the most sub-features of any feature
//   (uploads, chapters, likes, reads, ratings, comments, unlocks,
//   library/bookmarks, downloads). Each Appwrite-side write needs a
//   matching Supabase write. Centralizing the resolver caches +
//   write helpers in one module:
//     • Avoids duplicating the same hex→UUID resolver code in 8+ files
//     • Gives every dual-write the same behavior (best-effort, log-on-fail,
//       cached resolution)
//     • Makes the eventual `USE_SUPABASE_BOOKS=true` flag flip a one-time
//       grep ("remove dualWrite* calls") instead of an audit through 8 files
//
// All write helpers are best-effort:
//   • Resolution failure (legacy_appwrite_id missing → no UUID) → skip
//   • Supabase error → log only, never throw
//   • Caller's Appwrite write is never blocked by anything in here
//
// The helpers don't take a Supabase row id back — callers don't need it
// because mobile reads from Appwrite. If a caller needs the Supabase id
// (e.g., for a parent_id linkage on replies), they use the resolveX
// helpers directly via legacy_appwrite_id.

// Lazy-load the Supabase client to avoid module-load cycles between
// the books-*-appwrite.js files and the supabase singleton.
let _supabaseClient = null;
const getSupabase = async () => {
  if (_supabaseClient) return _supabaseClient;
  const mod = await import("./supabase");
  _supabaseClient = mod.default;
  return _supabaseClient;
};

const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _isUuid = (s) => typeof s === "string" && _UUID_RE.test(s);

// ─── Resolution caches ──────────────────────────────────────────────────
// Each cache: hex string → uuid string | null.
// The `null` value means "we looked it up and there's no Supabase mirror"
// — we cache that too so we don't re-query for known-absent rows.
const _profileCache = new Map();
const _bookCache = new Map();
const _chapterCache = new Map();
const _commentCache = new Map();           // book_comments parent lookups
const _chapterCommentCache = new Map();    // chapter_comments parent lookups

const _makeResolver = (table, cache, label) => async (rawId) => {
  if (!rawId) return null;
  if (_isUuid(rawId)) return rawId;
  if (cache.has(rawId)) return cache.get(rawId);
  try {
    const sb = await getSupabase();
    const { data, error } = await sb.from(table).select("id").eq("legacy_appwrite_id", rawId).maybeSingle();
    if (error) {
      console.error(`[books-dual-write] resolve ${label} failed:`, error.message);
      return null;
    }
    const resolved = data?.id || null;
    cache.set(rawId, resolved);
    return resolved;
  } catch (e) {
    console.error(`[books-dual-write] resolve ${label} threw:`, e?.message);
    return null;
  }
};

// Resolvers — internal to this module. They're not exported because every
// caller has a higher-level dualWrite* helper to use. Exporting them would
// invite call sites that bypass the dual-write contract (best-effort,
// log-on-fail) and fan out unbounded resolver round-trips.
//
// NOTE: Supabase table for chapters is `chapters` (not `book_chapters` —
// every *-supabase.js file in this repo references `chapters`).
const resolveProfileToUuid = _makeResolver("profiles", _profileCache, "profile");
const resolveBookToUuid = _makeResolver("books", _bookCache, "book");
const resolveChapterToUuid = _makeResolver("chapters", _chapterCache, "chapter");
const resolveBookCommentToUuid = _makeResolver("book_comments", _commentCache, "book-comment");
const resolveChapterCommentToUuid = _makeResolver("chapter_comments", _chapterCommentCache, "chapter-comment");

// Generic best-effort upsert. Returns null on resolution failure or
// Supabase error; never throws.
const _bestEffortUpsert = async (table, row, conflictTarget, onSuccessMap) => {
  try {
    const sb = await getSupabase();
    const { data, error } = await sb
      .from(table)
      .upsert(row, { onConflict: conflictTarget, ignoreDuplicates: false })
      .select("id")
      .maybeSingle();
    if (error) {
      console.error(`[books-dual-write] ${table} upsert error:`, error.message);
      return null;
    }
    if (data?.id && onSuccessMap) onSuccessMap(data.id);
    return data?.id || null;
  } catch (e) {
    console.error(`[books-dual-write] ${table} upsert threw:`, e?.message);
    return null;
  }
};

// ─── Book metadata ──────────────────────────────────────────────────────
// Mirrors web's books schema (see /Selebox/js/app.js around the books
// insert paths). Web uses cover_url; mobile's Appwrite shape uses
// `thumbnail`. We pass through whichever the caller provides.
//
// Status case-folding: mobile uses Capitalized strings ("Draft", "Publish",
// "Ongoing", "Completed"), web's insert defaults to lowercase 'draft' and
// the filter queries use 'completed'. Lowercase here so cross-platform
// status filters match. Also map "Publish" → "ongoing" (web doesn't have
// a "publish" status — published = !draft, status describes serial state).
const _MOBILE_TO_SUPABASE_BOOK_STATUS = {
  draft: "draft",
  publish: "ongoing",
  published: "ongoing",
  ongoing: "ongoing",
  completed: "completed",
};
const _normalizeBookStatus = (s) => {
  if (typeof s !== "string") return "draft";
  return _MOBILE_TO_SUPABASE_BOOK_STATUS[s.toLowerCase()] || "draft";
};

export const dualWriteBook = async ({
  appwriteDocId,
  uploaderAppwriteId,
  title,
  synopsis,
  description,
  thumbnail,
  coverUrl,
  status,
  tags,
  genre,
  isPublic,
}) => {
  if (!appwriteDocId || !uploaderAppwriteId) return null;
  const authorUuid = await resolveProfileToUuid(uploaderAppwriteId);
  if (!authorUuid) return null;
  const normalizedStatus = _normalizeBookStatus(status);
  const id = await _bestEffortUpsert(
    "books",
    {
      author_id: authorUuid,
      title: title || null,
      description: synopsis || description || null,
      cover_url: coverUrl || thumbnail || null,
      status: normalizedStatus,
      // published_at gets set when status flips out of draft. Web's
      // publishBook() handles the same transition for its own writes.
      ...(normalizedStatus !== "draft" ? { published_at: new Date().toISOString() } : {}),
      tags: Array.isArray(tags) ? tags : null,
      genre: genre || null,
      is_public: isPublic !== false,
      legacy_appwrite_id: appwriteDocId,
    },
    "legacy_appwrite_id",
    (uuid) => _bookCache.set(appwriteDocId, uuid),
  );
  return id;
};

// updateBook — partial UPDATE keyed by legacy_appwrite_id. Only writes
// the columns the caller passed; the Appwrite-side update is the source
// of truth so we mirror exactly what mobile changed. Skips quietly if
// the book hasn't been mirrored yet (e.g., dual-write was added after
// the book was created).
export const dualWriteUpdateBook = async ({ appwriteDocId, props = {} }) => {
  if (!appwriteDocId) return;
  // Build the update payload from the props the mobile caller passed.
  // Only include keys that have a meaningful translation; ignore the rest
  // so the SB row's other columns (counts, trending_score, etc.) stay
  // untouched.
  const update = {};
  if ("title" in props) update.title = props.title || null;
  if ("synopsis" in props) update.description = props.synopsis || null;
  if ("description" in props) update.description = props.description || null;
  if ("thumbnail" in props) update.cover_url = props.thumbnail || null;
  if ("cover_url" in props) update.cover_url = props.cover_url || null;
  if ("tags" in props) update.tags = Array.isArray(props.tags) ? props.tags : null;
  if ("genre" in props) update.genre = props.genre || null;
  if ("is_public" in props) update.is_public = props.is_public !== false;
  if ("status" in props) {
    const s = _normalizeBookStatus(props.status);
    update.status = s;
    if (s !== "draft") update.published_at = new Date().toISOString();
  }
  if (Object.keys(update).length === 0) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb.from("books").update(update).eq("legacy_appwrite_id", appwriteDocId);
    if (error) console.error("[books-dual-write] books update error:", error.message);
  } catch (e) {
    console.error("[books-dual-write] books update threw:", e?.message);
  }
};

export const dualWriteDeleteBook = async ({ appwriteDocId }) => {
  if (!appwriteDocId) return;
  try {
    const sb = await getSupabase();
    // Delete by legacy_appwrite_id. Cascade deletes (ON DELETE CASCADE
    // on chapters/likes/etc. FKs) clean up children automatically — same
    // semantics web's delete uses.
    const { error } = await sb.from("books").delete().eq("legacy_appwrite_id", appwriteDocId);
    if (error) console.error("[books-dual-write] books delete error:", error.message);
    _bookCache.delete(appwriteDocId);
  } catch (e) {
    console.error("[books-dual-write] books delete threw:", e?.message);
  }
};

// ─── Chapters ───────────────────────────────────────────────────────────
// Schema mapping (mobile/Appwrite → Supabase `chapters`):
//   title       → title
//   content     → content
//   thumbnail   → cover_url
//   order       → chapter_number
//   status      → is_published (boolean: status === "Publish")
// Web reads `is_published` as a boolean and `chapter_number` for ordering.
// Mobile passes status as the legacy strings "Draft" / "Publish".
export const dualWriteBookChapter = async ({
  appwriteDocId,
  bookAppwriteId,
  title,
  content,
  thumbnail,
  status,
  order,
}) => {
  if (!appwriteDocId || !bookAppwriteId) return null;
  const bookUuid = await resolveBookToUuid(bookAppwriteId);
  if (!bookUuid) return null;
  const id = await _bestEffortUpsert(
    "chapters",
    {
      book_id: bookUuid,
      title: title || null,
      content: content || null,
      cover_url: thumbnail || null,
      is_published: typeof status === "string" ? status.toLowerCase() === "publish" || status.toLowerCase() === "published" : false,
      chapter_number: typeof order === "number" ? order : null,
      legacy_appwrite_id: appwriteDocId,
    },
    "legacy_appwrite_id",
    (uuid) => _chapterCache.set(appwriteDocId, uuid),
  );
  return id;
};

export const dualWriteUpdateBookChapter = async ({ appwriteDocId, props = {} }) => {
  if (!appwriteDocId) return;
  const update = {};
  if ("title" in props) update.title = props.title || null;
  if ("content" in props) update.content = props.content || null;
  if ("thumbnail" in props) update.cover_url = props.thumbnail || null;
  if ("cover_url" in props) update.cover_url = props.cover_url || null;
  if ("order" in props) update.chapter_number = typeof props.order === "number" ? props.order : null;
  if ("status" in props) {
    update.is_published =
      typeof props.status === "string" ? props.status.toLowerCase() === "publish" || props.status.toLowerCase() === "published" : false;
  }
  if (Object.keys(update).length === 0) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb.from("chapters").update(update).eq("legacy_appwrite_id", appwriteDocId);
    if (error) console.error("[books-dual-write] chapters update error:", error.message);
  } catch (e) {
    console.error("[books-dual-write] chapters update threw:", e?.message);
  }
};

export const dualWriteDeleteBookChapter = async ({ appwriteDocId }) => {
  if (!appwriteDocId) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb.from("chapters").delete().eq("legacy_appwrite_id", appwriteDocId);
    if (error) console.error("[books-dual-write] chapters delete error:", error.message);
    _chapterCache.delete(appwriteDocId);
  } catch (e) {
    console.error("[books-dual-write] chapters delete threw:", e?.message);
  }
};

// ─── Engagement: likes / reads / ratings / library ──────────────────────
// Composite-PK tables (book_id, user_id) — upsert with ignoreDuplicates
// makes re-likes/re-reads a no-op.

export const dualWriteBookLike = async ({ bookAppwriteId, userAppwriteId }) => {
  const [bookUuid, userUuid] = await Promise.all([
    resolveBookToUuid(bookAppwriteId),
    resolveProfileToUuid(userAppwriteId),
  ]);
  if (!bookUuid || !userUuid) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb
      .from("book_likes")
      .upsert({ book_id: bookUuid, user_id: userUuid }, { onConflict: "book_id,user_id", ignoreDuplicates: true });
    if (error) console.error("[books-dual-write] book_likes upsert error:", error.message);
  } catch (e) {
    console.error("[books-dual-write] book_likes upsert threw:", e?.message);
  }
};

export const dualWriteRemoveBookLike = async ({ bookAppwriteId, userAppwriteId }) => {
  const [bookUuid, userUuid] = await Promise.all([
    resolveBookToUuid(bookAppwriteId),
    resolveProfileToUuid(userAppwriteId),
  ]);
  if (!bookUuid || !userUuid) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb.from("book_likes").delete().eq("book_id", bookUuid).eq("user_id", userUuid);
    if (error) console.error("[books-dual-write] book_likes delete error:", error.message);
  } catch (e) {
    console.error("[books-dual-write] book_likes delete threw:", e?.message);
  }
};

// Chapter likes — composite PK (chapter_id, user_id) on the chapter_likes
// table created in migration_chapter_likes.sql. Same upsert/delete pattern
// as book_likes; the trigger on the table maintains chapters.likes_count.
export const dualWriteChapterLike = async ({ chapterAppwriteId, userAppwriteId }) => {
  const [chapterUuid, userUuid] = await Promise.all([
    resolveChapterToUuid(chapterAppwriteId),
    resolveProfileToUuid(userAppwriteId),
  ]);
  if (!chapterUuid || !userUuid) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb
      .from("chapter_likes")
      .upsert({ chapter_id: chapterUuid, user_id: userUuid }, { onConflict: "chapter_id,user_id", ignoreDuplicates: true });
    if (error) console.error("[books-dual-write] chapter_likes upsert error:", error.message);
  } catch (e) {
    console.error("[books-dual-write] chapter_likes upsert threw:", e?.message);
  }
};

export const dualWriteRemoveChapterLike = async ({ chapterAppwriteId, userAppwriteId }) => {
  const [chapterUuid, userUuid] = await Promise.all([
    resolveChapterToUuid(chapterAppwriteId),
    resolveProfileToUuid(userAppwriteId),
  ]);
  if (!chapterUuid || !userUuid) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb.from("chapter_likes").delete().eq("chapter_id", chapterUuid).eq("user_id", userUuid);
    if (error) console.error("[books-dual-write] chapter_likes delete error:", error.message);
  } catch (e) {
    console.error("[books-dual-write] chapter_likes delete threw:", e?.message);
  }
};

// Chapter reads — composite PK (chapter_id, user_id) on the chapter_reads
// table created in migration_chapter_reads.sql. First read inserts with
// read_count = incrementBy (default 1); subsequent reads bump read_count
// + last_read_at via the read-modify-write pair below. Mirrors Appwrite's
// booksChaptersRead semantics where each (user, chapter) pair has one
// row whose readCount increments on re-reads.
//
// `incrementBy` lets the offline-sync flush mirror its accumulated
// count in one shot instead of N separate calls — keeps Supabase in
// sync with the Appwrite-side `readCount: doc.readCount + count`
// behavior.
export const dualWriteChapterRead = async ({ chapterAppwriteId, userAppwriteId, incrementBy = 1 }) => {
  const [chapterUuid, userUuid] = await Promise.all([
    resolveChapterToUuid(chapterAppwriteId),
    resolveProfileToUuid(userAppwriteId),
  ]);
  if (!chapterUuid || !userUuid) return;
  try {
    const sb = await getSupabase();
    // Try insert first. If the row exists, the unique-PK conflict triggers
    // the update branch which bumps read_count and last_read_at without
    // resetting created_at. Doing this in two statements (rather than
    // upsert with a CASE expression) keeps the SQL simple and lets the
    // row's `read_count` increment relative to its current value — upsert
    // can't easily express "set read_count = chapter_reads.read_count + 1"
    // through PostgREST.
    const bump = Math.max(1, Math.floor(incrementBy) || 1);
    const { error: insertErr } = await sb
      .from("chapter_reads")
      .insert({ chapter_id: chapterUuid, user_id: userUuid, read_count: bump, last_read_at: new Date().toISOString() });
    if (!insertErr) return;
    // 23505 = unique_violation → row exists, fall through to bump.
    if (insertErr.code !== "23505") {
      console.error("[books-dual-write] chapter_reads insert error:", insertErr.message);
      return;
    }
    // Re-read: increment read_count via an RPC if you have one set up,
    // or fall back to a read-modify-write pair. The pair has a tiny race
    // (two concurrent re-reads from the same user could lose one count)
    // but chapter re-reads from the same user in the same millisecond
    // are vanishingly rare. If it ever matters, swap to a Postgres RPC
    // that does `update ... set read_count = read_count + 1 returning *`.
    const { data: existing, error: readErr } = await sb
      .from("chapter_reads")
      .select("read_count")
      .eq("chapter_id", chapterUuid)
      .eq("user_id", userUuid)
      .maybeSingle();
    if (readErr || !existing) {
      if (readErr) console.error("[books-dual-write] chapter_reads re-read fetch error:", readErr.message);
      return;
    }
    const { error: updateErr } = await sb
      .from("chapter_reads")
      .update({ read_count: (existing.read_count || 1) + bump, last_read_at: new Date().toISOString() })
      .eq("chapter_id", chapterUuid)
      .eq("user_id", userUuid);
    if (updateErr) console.error("[books-dual-write] chapter_reads update error:", updateErr.message);
  } catch (e) {
    console.error("[books-dual-write] chapter_reads dual-write threw:", e?.message);
  }
};

// Reads — upsert on (user_id, book_id). Schema columns: user_id, book_id,
// last_chapter_id, last_chapter_number, progress_pct, last_read_at.
// Mobile callers pass the chapter id; we resolve it here. We don't have
// chapter_number / progress_pct on the mobile side without an extra query
// so we leave those nullable — web's "Continue Reading" widget tolerates
// nulls and falls back to the chapter row's own chapter_number.
export const dualWriteBookRead = async ({ bookAppwriteId, userAppwriteId, chapterAppwriteId, chapterNumber, progressPct }) => {
  const [bookUuid, userUuid] = await Promise.all([
    resolveBookToUuid(bookAppwriteId),
    resolveProfileToUuid(userAppwriteId),
  ]);
  if (!bookUuid || !userUuid) return;
  let chapterUuid = null;
  if (chapterAppwriteId) chapterUuid = await resolveChapterToUuid(chapterAppwriteId);
  try {
    const sb = await getSupabase();
    const row = {
      book_id: bookUuid,
      user_id: userUuid,
      last_read_at: new Date().toISOString(),
    };
    if (chapterUuid) row.last_chapter_id = chapterUuid;
    if (typeof chapterNumber === "number") row.last_chapter_number = chapterNumber;
    if (typeof progressPct === "number") row.progress_pct = progressPct;
    // onConflict order matches lib/book-reads-supabase.js so postgrest
    // infers the same unique constraint either way; keeping them aligned
    // makes future schema renames a single grep.
    const { error } = await sb.from("book_reads").upsert(row, { onConflict: "user_id,book_id" });
    if (error) console.error("[books-dual-write] book_reads upsert error:", error.message);
  } catch (e) {
    console.error("[books-dual-write] book_reads upsert threw:", e?.message);
  }
};

export const dualWriteBookRating = async ({ bookAppwriteId, userAppwriteId, rating, review }) => {
  const [bookUuid, userUuid] = await Promise.all([
    resolveBookToUuid(bookAppwriteId),
    resolveProfileToUuid(userAppwriteId),
  ]);
  if (!bookUuid || !userUuid) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb
      .from("book_ratings")
      .upsert(
        { book_id: bookUuid, user_id: userUuid, rating: typeof rating === "number" ? rating : null, review: review || null },
        { onConflict: "book_id,user_id" },
      );
    if (error) console.error("[books-dual-write] book_ratings upsert error:", error.message);
  } catch (e) {
    console.error("[books-dual-write] book_ratings upsert threw:", e?.message);
  }
};

// Library / bookmarks. Web's table is `book_bookmarks`; per
// books-supabase.js the composite PK is (user_id, book_id) — note the
// order. PostgREST infers the constraint either way but matching the
// actual PK keeps dev-tools error messages readable.
export const dualWriteBookLibrary = async ({ bookAppwriteId, userAppwriteId }) => {
  const [bookUuid, userUuid] = await Promise.all([
    resolveBookToUuid(bookAppwriteId),
    resolveProfileToUuid(userAppwriteId),
  ]);
  if (!bookUuid || !userUuid) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb
      .from("book_bookmarks")
      .upsert({ book_id: bookUuid, user_id: userUuid }, { onConflict: "user_id,book_id", ignoreDuplicates: true });
    if (error) console.error("[books-dual-write] book_bookmarks upsert error:", error.message);
  } catch (e) {
    console.error("[books-dual-write] book_bookmarks upsert threw:", e?.message);
  }
};

export const dualWriteRemoveBookLibrary = async ({ bookAppwriteId, userAppwriteId }) => {
  const [bookUuid, userUuid] = await Promise.all([
    resolveBookToUuid(bookAppwriteId),
    resolveProfileToUuid(userAppwriteId),
  ]);
  if (!bookUuid || !userUuid) return;
  try {
    const sb = await getSupabase();
    const { error } = await sb.from("book_bookmarks").delete().eq("book_id", bookUuid).eq("user_id", userUuid);
    if (error) console.error("[books-dual-write] book_bookmarks delete error:", error.message);
  } catch (e) {
    console.error("[books-dual-write] book_bookmarks delete threw:", e?.message);
  }
};

// ─── Comments (book / chapter / inline) ─────────────────────────────────
// Each has its own table. Same parent-resolution pattern as
// reply→parent in posts/videos comments.

export const dualWriteBookComment = async ({
  appwriteDocId,
  bookAppwriteId,
  userAppwriteId,
  body,
  parentAppwriteId,
}) => {
  if (!appwriteDocId) return null;
  let parentUuid = null;
  let bookUuidFromParent = null;
  if (parentAppwriteId) {
    parentUuid = await resolveBookCommentToUuid(parentAppwriteId);
    if (!parentUuid) return null; // parent not yet in Supabase — skip; backfill catches it
    // Derive book_id from the parent row when caller didn't pass it. Saves
    // the reply path from having to hand-fetch the parent comment to find
    // its bookId — typical for the createReplyComment flow which only knows
    // the parent comment id.
    if (!bookAppwriteId) {
      try {
        const sb = await getSupabase();
        const { data } = await sb.from("book_comments").select("book_id").eq("id", parentUuid).maybeSingle();
        bookUuidFromParent = data?.book_id || null;
      } catch (e) {
        console.error("[books-dual-write] derive bookId from parent failed:", e?.message);
      }
    }
  }
  const [resolvedBookUuid, userUuid] = await Promise.all([
    bookAppwriteId ? resolveBookToUuid(bookAppwriteId) : Promise.resolve(bookUuidFromParent),
    resolveProfileToUuid(userAppwriteId),
  ]);
  const bookUuid = resolvedBookUuid || bookUuidFromParent;
  if (!bookUuid || !userUuid) return null;
  return _bestEffortUpsert(
    "book_comments",
    {
      book_id: bookUuid,
      user_id: userUuid,
      // Schema column is `content` (verified against book-comments-supabase.js
      // COMMENT_SELECT). Earlier draft used `body` from a misread of web.
      content: (body || "").trim(),
      parent_id: parentUuid,
      legacy_appwrite_id: appwriteDocId,
    },
    "legacy_appwrite_id",
    (uuid) => _commentCache.set(appwriteDocId, uuid),
  );
};

export const dualWriteChapterComment = async ({
  appwriteDocId,
  chapterAppwriteId,
  userAppwriteId,
  body,
  parentAppwriteId,
}) => {
  if (!appwriteDocId) return null;
  let parentUuid = null;
  let chapterUuidFromParent = null;
  if (parentAppwriteId) {
    parentUuid = await resolveChapterCommentToUuid(parentAppwriteId);
    if (!parentUuid) return null;
    if (!chapterAppwriteId) {
      try {
        const sb = await getSupabase();
        const { data } = await sb.from("chapter_comments").select("chapter_id").eq("id", parentUuid).maybeSingle();
        chapterUuidFromParent = data?.chapter_id || null;
      } catch (e) {
        console.error("[books-dual-write] derive chapterId from parent failed:", e?.message);
      }
    }
  }
  const [resolvedChapterUuid, userUuid] = await Promise.all([
    chapterAppwriteId ? resolveChapterToUuid(chapterAppwriteId) : Promise.resolve(chapterUuidFromParent),
    resolveProfileToUuid(userAppwriteId),
  ]);
  const chapterUuid = resolvedChapterUuid || chapterUuidFromParent;
  if (!chapterUuid || !userUuid) return null;
  return _bestEffortUpsert(
    "chapter_comments",
    {
      chapter_id: chapterUuid,
      user_id: userUuid,
      content: (body || "").trim(),
      parent_id: parentUuid,
      legacy_appwrite_id: appwriteDocId,
    },
    "legacy_appwrite_id",
    (uuid) => _chapterCommentCache.set(appwriteDocId, uuid),
  );
};

// Inline comments — INTENTIONALLY NOT DUAL-WRITTEN.
//
// Mobile and Supabase use fundamentally different anchor models:
//   • Mobile/Appwrite stores per-comment fields anchorKey + anchorOrdinal
//     + anchorPath + textHash. The "thread" is implicit (anchorKey hashes
//     to a deterministic doc id).
//   • Supabase requires a parent row in `chapter_inline_comment_threads`
//     keyed by (chapter_id, start_offset, end_offset, anchor_text), and
//     `chapter_inline_comments.thread_id` is a hard FK. There is no
//     `anchor` jsonb column.
//
// Faithfully bridging the two needs an offset-resolution pass (turning
// anchorKey + ordinal back into character offsets for the chapter's
// rendered content) which can't run from the mobile client without
// shipping the same DOM-walk logic web uses. Mobile inline comments stay
// Appwrite-only until a dedicated anchor→offset migration lands. No
// dualWriteInlineComment helper here on purpose — call sites should
// stay obviously-Appwrite-only rather than silently no-op'ing.
