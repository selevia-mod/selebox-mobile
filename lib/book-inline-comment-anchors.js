export const INLINE_COMMENT_ANCHOR_VERSION = "v1";

export const INLINE_COMMENT_ATTRS = {
  paragraphIndex: "data-inline-comment-paragraph-index",
  key: "data-inline-comment-key",
  ordinal: "data-inline-comment-ordinal",
  path: "data-inline-comment-path",
  preview: "data-inline-comment-preview",
  tag: "data-inline-comment-tag",
  textHash: "data-inline-comment-text-hash",
  trigger: "data-inline-comment-trigger",
  version: "data-inline-comment-version",
};

export const INLINE_COMMENTABLE_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "li", "div"];
export const INLINE_COMMENT_TRIGGER_TAGS = ["p", "blockquote", "pre", "li", "div"];
export const INLINE_COMMENT_WORD_THRESHOLD = 50;
export const INLINE_COMMENT_WORD_THRESHOLD_SETTING_KEYS = ["INLINE_COMMENT_WORD_THRESHOLD", "BOOKS_INLINE_COMMENT_WORD_THRESHOLD"];

const COMMENTABLE_TAG_SET = new Set(INLINE_COMMENTABLE_TAGS);
const TRIGGER_TAG_SET = new Set(INLINE_COMMENT_TRIGGER_TAGS);
const IGNORED_TEXT_TAGS = new Set(["img", "script", "style", "svg", "video", "audio", "iframe"]);
const BLOCK_BREAK_TAGS = new Set(["p", "div", "li", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "br"]);

const isElementNode = (node) => node?.type === "tag";
const isTextNode = (node) => node?.type === "text";
const getTagName = (node) => String(node?.name || "").toLowerCase();

export const normalizeInlineCommentText = (value = "") =>
  value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const shortenInlineCommentText = (value = "", maxLength = 180) => {
  const normalized = normalizeInlineCommentText(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(maxLength - 1, 0)).trimEnd()}...`;
};

export const countInlineCommentWords = (value = "") => {
  const normalized = normalizeInlineCommentText(value);
  return normalized ? normalized.split(/\s+/).filter(Boolean).length : 0;
};

const normalizeInlineCommentWordThreshold = (value, fallback = INLINE_COMMENT_WORD_THRESHOLD) => {
  const threshold = Number(value);
  return Number.isFinite(threshold) && threshold > 0 ? Math.floor(threshold) : fallback;
};

export const resolveInlineCommentWordThreshold = (globalSettings = {}, fallback = INLINE_COMMENT_WORD_THRESHOLD) => {
  for (const settingKey of INLINE_COMMENT_WORD_THRESHOLD_SETTING_KEYS) {
    if (globalSettings?.[settingKey] !== undefined && globalSettings?.[settingKey] !== null) {
      return normalizeInlineCommentWordThreshold(globalSettings[settingKey], fallback);
    }
  }

  return normalizeInlineCommentWordThreshold(fallback, INLINE_COMMENT_WORD_THRESHOLD);
};

export const fnv1aHash = (value = "") => {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36);
};

const collectTextFragments = (node, fragments) => {
  if (!node) return;

  if (isTextNode(node)) {
    if (node.data) fragments.push(node.data);
    return;
  }

  if (!isElementNode(node)) return;

  const tagName = getTagName(node);
  if (!tagName || IGNORED_TEXT_TAGS.has(tagName)) return;

  if (tagName === "br") {
    fragments.push("\n");
    return;
  }

  for (const child of node.children || []) {
    collectTextFragments(child, fragments);
  }

  if (BLOCK_BREAK_TAGS.has(tagName)) {
    fragments.push("\n");
  }
};

const extractElementText = (element) => {
  const fragments = [];
  collectTextFragments(element, fragments);
  return normalizeInlineCommentText(fragments.join(" "));
};

const hasNestedCommentableDescendant = (element) => {
  for (const child of element.children || []) {
    if (!isElementNode(child)) continue;

    const childTagName = getTagName(child);
    if (COMMENTABLE_TAG_SET.has(childTagName) && extractElementText(child)) {
      return true;
    }

    if (hasNestedCommentableDescendant(child)) {
      return true;
    }
  }

  return false;
};

const getSiblingTagIndex = (element) => {
  const parentChildren = element?.parent?.children || [];
  let siblingIndex = 0;

  for (const sibling of parentChildren) {
    if (!isElementNode(sibling)) continue;
    if (getTagName(sibling) !== getTagName(element)) continue;
    if (sibling === element) return siblingIndex;
    siblingIndex += 1;
  }

  return siblingIndex;
};

const getElementDomPath = (element) => {
  const segments = [];
  let current = element;

  while (current && isElementNode(current)) {
    segments.unshift(`${getTagName(current)}[${getSiblingTagIndex(current)}]`);
    current = current.parent;
  }

  return segments.join("/");
};

const getCommentableElementInfo = (element) => {
  const tagName = getTagName(element);
  if (!COMMENTABLE_TAG_SET.has(tagName)) return null;
  if (hasNestedCommentableDescendant(element)) return null;

  const normalizedText = extractElementText(element);
  return {
    tagName,
    normalizedText,
    shouldTrackThreshold: TRIGGER_TAG_SET.has(tagName),
  };
};

export const buildInlineCommentParagraphPlan = (
  paragraphs = [],
  { globalSettings, wordThreshold = resolveInlineCommentWordThreshold(globalSettings) } = {},
) => {
  let cumulativeWordCount = 0;
  const resolvedWordThreshold = normalizeInlineCommentWordThreshold(wordThreshold);

  return paragraphs.map((paragraph, paragraphIndex) => {
    const wordCount = countInlineCommentWords(paragraph);
    const shouldTriggerComment = wordCount > 0 && cumulativeWordCount + wordCount >= resolvedWordThreshold;

    if (wordCount > 0) {
      cumulativeWordCount += wordCount;
    }

    if (shouldTriggerComment) {
      cumulativeWordCount = 0;
    }

    return {
      paragraphIndex,
      wordCount,
      shouldTriggerComment,
    };
  });
};

const createInlineCommentParagraphTracker = ({ globalSettings, wordThreshold = resolveInlineCommentWordThreshold(globalSettings) } = {}) => {
  let paragraphIndex = 0;
  let cumulativeWordCount = 0;
  const resolvedWordThreshold = normalizeInlineCommentWordThreshold(wordThreshold);

  return {
    consumeParagraph(text = "") {
      const nextParagraphIndex = paragraphIndex;
      paragraphIndex += 1;

      const wordCount = countInlineCommentWords(text);
      if (wordCount === 0) {
        return {
          paragraphIndex: nextParagraphIndex,
          wordCount,
          shouldTriggerComment: false,
        };
      }

      cumulativeWordCount += wordCount;
      const shouldTriggerComment = cumulativeWordCount >= resolvedWordThreshold;

      if (shouldTriggerComment) {
        cumulativeWordCount = 0;
      }

      return {
        paragraphIndex: nextParagraphIndex,
        wordCount,
        shouldTriggerComment,
      };
    },
  };
};

export const createInlineCommentDomVisitors = ({ globalSettings, wordThreshold } = {}) => {
  const duplicateOrdinalBySignature = new Map();
  const paragraphTracker = createInlineCommentParagraphTracker({ globalSettings, wordThreshold });

  return {
    onElement(element) {
      const commentableElementInfo = getCommentableElementInfo(element);
      if (!commentableElementInfo) return;

      const { tagName, normalizedText, shouldTrackThreshold } = commentableElementInfo;
      const paragraphMetadata = shouldTrackThreshold ? paragraphTracker.consumeParagraph(normalizedText) : null;
      const nextAttribs = {
        ...(element.attribs || {}),
      };

      if (paragraphMetadata) {
        nextAttribs[INLINE_COMMENT_ATTRS.paragraphIndex] = String(paragraphMetadata.paragraphIndex);
        nextAttribs[INLINE_COMMENT_ATTRS.trigger] = paragraphMetadata.shouldTriggerComment ? "1" : "0";
      }

      if (!normalizedText) {
        element.attribs = nextAttribs;
        return;
      }

      const textHash = fnv1aHash(normalizedText);
      const signature = `${tagName}_${textHash}`;
      const ordinal = duplicateOrdinalBySignature.get(signature) || 0;

      duplicateOrdinalBySignature.set(signature, ordinal + 1);

      element.attribs = {
        ...nextAttribs,
        [INLINE_COMMENT_ATTRS.key]: `${INLINE_COMMENT_ANCHOR_VERSION}_${tagName}_${textHash}_${ordinal}`,
        [INLINE_COMMENT_ATTRS.ordinal]: String(ordinal),
        [INLINE_COMMENT_ATTRS.path]: getElementDomPath(element),
        [INLINE_COMMENT_ATTRS.preview]: shortenInlineCommentText(normalizedText),
        [INLINE_COMMENT_ATTRS.tag]: tagName,
        [INLINE_COMMENT_ATTRS.textHash]: textHash,
        [INLINE_COMMENT_ATTRS.version]: INLINE_COMMENT_ANCHOR_VERSION,
      };
    },
  };
};

export const getInlineCommentThreadDocumentId = (bookChapterId, anchorKey) => {
  const safeChapterId = String(bookChapterId || "chapter")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 20);
  const anchorHash = fnv1aHash(anchorKey || "anchor")
    .padStart(7, "0")
    .slice(0, 7);

  return `bic_${safeChapterId}_${anchorHash}`;
};
