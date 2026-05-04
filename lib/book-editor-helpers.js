// lib/book-editor-helpers.js
//
// Pure helpers shared by the chapter-editor + book-introduction-editor
// surfaces. Both files used to declare these locally — byte-identical
// duplicates — and any fix made to one had to be hand-copied to the
// other or the editors would silently drift (e.g., the introduction
// guard inconsistency we caught during the audit).
//
// Everything here is a pure function (or constant). No React, no
// supabase, no navigation — safe to import from anywhere on the
// content path. Reader screens (book-reading.jsx) keep their own
// `sanitizeImageTag` because the read-side rules are deliberately
// different (preserve the original tag when src is http(s); editors
// reassemble to a sanitized minimal form).

import { normalizeBookContentToHtml } from "./book-content";

// ─────────────────────────────────────────────────────────────────────────
// HTML sanitizers
// ─────────────────────────────────────────────────────────────────────────

// Editor variant — strips every attribute except a normalized src.
// Drops any data:/file:/blob: src so a base64 placeholder can't survive
// the round-trip through Redux/MMKV. Reader path uses a different
// variant; do not consolidate them.
export const sanitizeImageTag = (tag = "") => {
  const srcMatch = tag.match(/\ssrc=(["'])(.*?)\1/i);
  const src = srcMatch?.[2]?.trim();
  if (!src || !/^https?:\/\//i.test(src)) return "";
  return `<img src="${src.replace(/"/g, "&quot;")}" />`;
};

// Strips inline `background`, `font-size`, `font-family`, `color` style
// rules so author-pasted content adopts the reader's theme instead of
// imposing whatever color/font the source had. Also flattens <font> →
// <span> and unwraps anchors (we don't allow links in chapter content).
export const stripBackgroundStyles = (html = "") => {
  if (!html) return html;
  const cleanStyle = (styleText = "") => {
    const cleaned = styleText
      .split(";")
      .map((rule) => rule.trim())
      .filter(
        (rule) =>
          rule &&
          !rule.toLowerCase().startsWith("background") &&
          !rule.toLowerCase().startsWith("font-size") &&
          !rule.toLowerCase().startsWith("font-family") &&
          !rule.toLowerCase().startsWith("color"),
      )
      .join("; ");
    return cleaned;
  };

  const stripStyleAttribute = (match, styleText) => {
    const cleaned = cleanStyle(styleText);
    return cleaned ? `style="${cleaned}"` : "";
  };

  return html
    .replace(/<font\b[^>]*>/gi, "<span>")
    .replace(/<\/font>/gi, "</span>")
    .replace(/<img\b[^>]*>/gi, sanitizeImageTag)
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/style="([^"]*)"/gi, stripStyleAttribute)
    .replace(/style='([^']*)'/gi, (match, styleText) => {
      const cleaned = cleanStyle(styleText);
      return cleaned ? `style='${cleaned}'` : "";
    })
    .replace(/\sstyle=(["'])(\s*)\1/gi, "");
};

export const hasInlineImage = (html = "") => /<img\b[^>]*>/i.test(html);

export const stripHtml = (value = "") =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

export const escapeHtmlAttribute = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// ─────────────────────────────────────────────────────────────────────────
// Inline image rendering — base style + pending placeholder style
// ─────────────────────────────────────────────────────────────────────────

export const INLINE_IMAGE_BASE_STYLE =
  "max-width:100%; height:auto; display:block; margin:12px auto; border-radius:12px; object-fit:cover;";

export const INLINE_IMAGE_PENDING_STYLE = `${INLINE_IMAGE_BASE_STYLE} filter: blur(8px); opacity: 0.6;`;

// Removes any inline <img> tag that's still in the "pending upload"
// state — either it carries a `data-upload-id` attribute (the editor is
// waiting for the upload to resolve) or its `src` is a base64 `data:`
// URI we used as a placeholder while uploading.
//
// Base64 blobs can run several megabytes and, when persisted (Redux +
// MMKV stringify, Appwrite/Supabase POST body), can freeze the JS thread
// or hang the upload — observed to crash or soft-lock the app during
// save / publish. Stripping these tags before persistence guarantees a
// save never carries a multi-MB inline payload.
export const stripPendingInlineImages = (html = "") => {
  if (!html) return html;
  return html
    .replace(/<img\b[^>]*data-upload-id=[^>]*>/gi, "")
    .replace(/<img\b[^>]*\ssrc=(["'])data:[^>]*?\1[^>]*>/gi, "");
};

// ─────────────────────────────────────────────────────────────────────────
// Local-draft key helpers
// ─────────────────────────────────────────────────────────────────────────
//
// Two key shapes share a `bookDraft:<userId>:` prefix so the catalog
// can `.startsWith()`-filter them out of the user's general localDrafts
// map without inspecting each value:
//
//   bookDraft:<userId>:local:<ts>:<rand>   — brand-new book, no $id yet
//   bookDraft:<userId>:book:<bookId>       — existing server book
//
// Both helpers return "" when prerequisites are missing so callers can
// short-circuit without null-checking.

export const createLocalDraftKey = ({ userId }) => {
  if (!userId) return "";
  return `bookDraft:${userId}:local:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
};

export const createExistingBookDraftKey = ({ userId, bookId }) => {
  if (!userId || !bookId) return "";
  return `bookDraft:${userId}:book:${bookId}`;
};

// ─────────────────────────────────────────────────────────────────────────
// Local chapter id resolver
// ─────────────────────────────────────────────────────────────────────────
//
// A chapter inside a local draft needs a stable id even before it gets a
// server $id. We pick the first available source in this order:
//   1. existing localId on the form / chapter record
//   2. a synthesized "server:<$id>" key for chapters that already have
//      a server id (round-tripping back through draft state)
//   3. a fresh "localChapter:<ts>:<rand>" id generated on the fly
//
// The stable id lets persistEntryToLocalDraft / clearSavedLocalDraftChapter
// match the same chapter across re-renders and post-save reconciliation.

export const resolveLocalChapterId = ({ chapterForm, chapter } = {}) => {
  if (chapterForm?.localId) return chapterForm.localId;
  if (chapter?.localId) return chapter.localId;
  if (chapterForm?.$id) return `server:${chapterForm.$id}`;
  if (chapter?.$id) return `server:${chapter.$id}`;
  return `localChapter:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
};

// ─────────────────────────────────────────────────────────────────────────
// Chapter content shaping
// ─────────────────────────────────────────────────────────────────────────
//
// Single canonical "is this content safe to persist?" pipeline used
// before every save and before checking "does this entry have anything
// in it" (hasFilledEntry). The pipeline runs in this order:
//   1. normalizeBookContentToHtml — coerce the editor's representation
//      into clean HTML.
//   2. stripBackgroundStyles — drop background / font / color rules.
//   3. stripPendingInlineImages — drop any data: / pending-upload <img>
//      tag so a multi-MB base64 blob never reaches Redux/MMKV/Supabase.

export const getSanitizedChapterContent = (content = "") =>
  stripPendingInlineImages(stripBackgroundStyles(normalizeBookContentToHtml(content)));

// "Does this entry contain anything worth saving?" — used by handleSave
// to skip empty drafts that the user paged past without typing.
// Treats title / sanitized content / thumbnail as independent signals;
// any one of them is enough to count as filled.
export const isChapterEntryFilled = (entry) => {
  const title = String(entry?.title || "").trim();
  const content = getSanitizedChapterContent(entry?.content ?? "");
  const hasContent = Boolean(stripHtml(content)?.length || hasInlineImage(content));
  const hasThumbnail = Boolean(entry?.thumbnail?.uri || entry?.thumbnail);
  return Boolean(title || hasContent || hasThumbnail);
};

// ─────────────────────────────────────────────────────────────────────────
// Local-draft pruning
// ─────────────────────────────────────────────────────────────────────────
//
// Used by both editors after a chapter has been saved online — we want
// to drop the local-only entry for THIS chapter so the table of contents
// doesn't show it twice (once from the server, once from the lingering
// MMKV draft). Match priority:
//   1. `localId` exact match — the explicit case
//   2. `(isIntroductionEntry && isIntroductionChapter(item))` — the
//      intro-only sub-case the book-introduction-editor needs so a
//      first-time-published intro clears its own draft slot even if
//      the localId regenerated. chapter-editor passes
//      `isIntroductionEntry: false` so this guard is a no-op there.
//   3. (title, order) shadow match — covers chapters that were just
//      published online for the first time. Their freshly-minted
//      localId has no match in any older draft entry, so without the
//      shadow check the same chapter would appear twice in the TOC
//      (once from the new server entry, once from the orphaned local
//      draft) and "delete one delete all" because both point at the
//      same server $id once tapped.
//
// Returns null when the whole draft should be removed (no chapters
// remain after the prune). Otherwise returns the next draft object the
// caller should upsert. The caller still owns the dispatch — keeps this
// helper Redux-free.
//
// Defining this here also fixes the audit's finding #2 (the chapter-
// editor's local copy was missing the introduction guard from the
// intro-editor's copy — drift risk). Single source of truth now.
//
// Required ambient: imports getBookChapterOrder + isIntroductionChapter
// from lib/books, which both editors already use directly.

import { getBookChapterOrder, isIntroductionChapter } from "./books";

export const pruneChapterFromDraft = ({
  existingDraft,
  chapterForm,
  chapter,
  resolvedChapterTotal,
  isIntroductionEntry = false,
}) => {
  // No draft = nothing to keep, no work to do.
  if (!existingDraft) return null;

  const existingChapters = Array.isArray(existingDraft?.chapters)
    ? existingDraft.chapters
    : existingDraft?.chapterForm
      ? [existingDraft.chapterForm]
      : [];
  const chapterLocalId = resolveLocalChapterId({ chapterForm, chapter });
  const chapterTitle = String(chapterForm?.title || "").trim();
  const chapterOrder = Number(resolvedChapterTotal);

  const remainingChapters = existingChapters.filter((item) => {
    if (item?.localId && chapterLocalId && item.localId === chapterLocalId) return false;
    if (isIntroductionEntry && isIntroductionChapter(item)) return false;
    const itemTitle = String(item?.title || "").trim();
    const itemOrder = Number(getBookChapterOrder(item));
    const titleMatches = chapterTitle && itemTitle === chapterTitle;
    const orderMatches = Number.isFinite(chapterOrder) && itemOrder === chapterOrder;
    if (titleMatches && orderMatches) return false;
    return true;
  });

  if (!remainingChapters.length) return null;

  return {
    ...existingDraft,
    chapterForm: remainingChapters[0],
    chapters: remainingChapters,
    meta: {
      ...(existingDraft?.meta || {}),
      chaptersTotal: remainingChapters.length,
    },
    updatedAt: Date.now(),
  };
};
