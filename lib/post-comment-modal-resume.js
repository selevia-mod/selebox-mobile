const RESUME_TTL_MS = 2 * 60 * 1000;
const DRAFT_TTL_MS = 5 * 60 * 1000;

const pendingResumeByScope = new Map();
const draftByToken = new Map();

const normalizeToken = (value) => String(value || "").trim();
const isExpired = (createdAt, ttlMs) => !createdAt || Date.now() - createdAt > ttlMs;

const createResumeToken = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const hasDraftContent = (draft = {}) =>
  Boolean(
    String(draft?.text || "").trim() || (Array.isArray(draft?.selectedMentionUsers) && draft.selectedMentionUsers.length > 0) || draft?.replyTarget,
  );

export const queuePostCommentModalResume = ({ scope, postId, postSnapshot = null, draft = null }) => {
  const normalizedScope = normalizeToken(scope);
  const normalizedPostId = normalizeToken(postId);
  if (!normalizedScope || !normalizedPostId) return null;

  const token = createResumeToken();
  const createdAt = Date.now();

  pendingResumeByScope.set(normalizedScope, {
    scope: normalizedScope,
    postId: normalizedPostId,
    postSnapshot: postSnapshot && typeof postSnapshot === "object" ? postSnapshot : null,
    token,
    createdAt,
  });

  if (draft && hasDraftContent(draft)) {
    draftByToken.set(token, {
      postId: normalizedPostId,
      text: String(draft?.text || ""),
      selectedMentionUsers: Array.isArray(draft?.selectedMentionUsers) ? draft.selectedMentionUsers : [],
      replyTarget: draft?.replyTarget || null,
      createdAt,
    });
  }

  return token;
};

export const consumePostCommentModalResume = (scope) => {
  const normalizedScope = normalizeToken(scope);
  if (!normalizedScope) return null;

  const payload = pendingResumeByScope.get(normalizedScope);
  pendingResumeByScope.delete(normalizedScope);
  if (!payload) return null;
  if (isExpired(payload.createdAt, RESUME_TTL_MS)) {
    draftByToken.delete(payload.token);
    return null;
  }

  return payload;
};

export const consumePostCommentModalDraft = ({ token, postId }) => {
  const normalizedToken = normalizeToken(token);
  const normalizedPostId = normalizeToken(postId);
  if (!normalizedToken || !normalizedPostId) return null;

  const payload = draftByToken.get(normalizedToken);
  draftByToken.delete(normalizedToken);
  if (!payload) return null;
  if (isExpired(payload.createdAt, DRAFT_TTL_MS)) return null;
  if (normalizeToken(payload.postId) !== normalizedPostId) return null;

  return payload;
};
