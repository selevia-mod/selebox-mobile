export const LEGACY_MENTION_REGEX = /@([a-zA-Z0-9._-]+)/g;
export const MENTION_MARKUP_REGEX = /@\[(.+?)\]\(([a-zA-Z0-9_-]+)\)/g;
export const URL_REGEX = /\b((?:https?:\/\/|www\.)[^\s<]+)/gi;
export const MENTION_SEARCH_DEBOUNCE_MS = 1000;

export const normalizeMentionToken = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
export const normalizeMentionSearchQuery = (value) => normalizeMentionToken(String(value || "").replace(/\s+/g, " "));
export const normalizeMentionCompactQuery = (value) => normalizeMentionToken(String(value || "").replace(/\s+/g, ""));

export const sanitizeMentionLabel = (value) =>
  String(value || "")
    .replace(/[\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const stripMentionMarkup = (text) =>
  String(text || "").replace(new RegExp(MENTION_MARKUP_REGEX.source, "g"), (_raw, label) => sanitizeMentionLabel(label));

export const escapeRegExp = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const normalizeExternalUrl = (value) => {
  const rawValue = String(value || "").trim();
  if (!rawValue) return "";
  return /^https?:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`;
};

export const splitTrailingUrlPunctuation = (value) => {
  let url = String(value || "");
  let trailingText = "";

  while (url) {
    const lastChar = url.slice(-1);
    if (/[.,!?;:]/.test(lastChar)) {
      trailingText = `${lastChar}${trailingText}`;
      url = url.slice(0, -1);
      continue;
    }
    if (lastChar === ")" && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
      trailingText = `${lastChar}${trailingText}`;
      url = url.slice(0, -1);
      continue;
    }
    if (lastChar === "]" && (url.match(/\[/g) || []).length < (url.match(/\]/g) || []).length) {
      trailingText = `${lastChar}${trailingText}`;
      url = url.slice(0, -1);
      continue;
    }
    break;
  }

  return { url, trailingText };
};

export const hasMentionLabelInText = (text, label) => {
  const normalizedLabel = sanitizeMentionLabel(label);
  if (!normalizedLabel) return false;
  const mentionRegex = new RegExp(`(^|[\\s([{])@?${escapeRegExp(normalizedLabel)}(?=$|[\\s.,!?;:)}\\]])`, "i");
  return mentionRegex.test(String(text || ""));
};

export const extractMentionTargetsFromMarkup = (text) => {
  const targets = [];
  for (const match of String(text || "").matchAll(new RegExp(MENTION_MARKUP_REGEX.source, "g"))) {
    const rawLabel = match?.[1];
    const userId = String(match?.[2] || "").trim();
    const label = sanitizeMentionLabel(rawLabel);
    if (!userId || !label) continue;
    targets.push({ userId, label });
  }
  return targets;
};

export const extractMentionUsernames = (text) => {
  const usernames = new Set();
  const textWithoutStructuredMentions = String(text || "").replace(new RegExp(MENTION_MARKUP_REGEX.source, "g"), " ");
  for (const match of textWithoutStructuredMentions.matchAll(new RegExp(LEGACY_MENTION_REGEX.source, "g"))) {
    const token = normalizeMentionToken(match?.[1]);
    if (token) usernames.add(token);
  }
  return Array.from(usernames);
};

export const serializeMentionsForStorage = (text, mentionedUsers = []) => {
  let output = String(text || "");
  if (!output) return output;

  const users = Array.from(new Map((mentionedUsers || []).filter((user) => user?.$id).map((user) => [String(user.$id), user])).values())
    .map((user) => ({
      ...user,
      mentionLabel: sanitizeMentionLabel(user?.username || user?.name || ""),
    }))
    .filter((user) => user.mentionLabel)
    .sort((a, b) => b.mentionLabel.length - a.mentionLabel.length);

  users.forEach((mentionedUser) => {
    const encodedMention = `@[${mentionedUser.mentionLabel}](${mentionedUser.$id})`;
    const mentionRegex = new RegExp(`(^|[\\s([{])@?${escapeRegExp(mentionedUser.mentionLabel)}(?=$|[\\s.,!?;:)}\\]])`, "gi");
    output = output.replace(mentionRegex, (_fullMatch, prefix) => `${prefix}${encodedMention}`);
  });

  return output;
};

export const buildMentionTextParts = (value) => {
  const text = String(value || "");
  if (!text) return [];

  const parts = [];
  const appendPlainPartsFromChunk = (chunkText) => {
    if (!chunkText) return;

    const chunkPattern = new RegExp(`${URL_REGEX.source}|${LEGACY_MENTION_REGEX.source}`, "gi");
    let chunkLastIndex = 0;

    for (const chunkMatch of chunkText.matchAll(chunkPattern)) {
      const rawMatch = chunkMatch?.[0];
      const matchIndex = chunkMatch?.index ?? -1;
      if (!rawMatch || matchIndex < 0) continue;

      if (matchIndex > chunkLastIndex) {
        parts.push({
          type: "text",
          value: chunkText.slice(chunkLastIndex, matchIndex),
        });
      }

      if (rawMatch.startsWith("@")) {
        const username = rawMatch.slice(1);
        parts.push({
          type: "mention",
          value: sanitizeMentionLabel(username),
          username: normalizeMentionToken(username),
          userId: null,
        });
      } else {
        const { url, trailingText } = splitTrailingUrlPunctuation(rawMatch);
        if (url) parts.push({ type: "link", value: url });
        if (trailingText) parts.push({ type: "text", value: trailingText });
      }

      chunkLastIndex = matchIndex + rawMatch.length;
    }

    if (chunkLastIndex < chunkText.length) {
      parts.push({
        type: "text",
        value: chunkText.slice(chunkLastIndex),
      });
    }
  };

  let markupLastIndex = 0;
  for (const markupMatch of text.matchAll(new RegExp(MENTION_MARKUP_REGEX.source, "g"))) {
    const rawMarkup = markupMatch?.[0];
    const rawLabel = markupMatch?.[1];
    const userId = String(markupMatch?.[2] || "").trim();
    const markupIndex = markupMatch?.index ?? -1;
    if (!rawMarkup || !rawLabel || !userId || markupIndex < 0) continue;

    if (markupIndex > markupLastIndex) {
      appendPlainPartsFromChunk(text.slice(markupLastIndex, markupIndex));
    }

    parts.push({
      type: "mention",
      value: sanitizeMentionLabel(rawLabel),
      username: null,
      userId,
    });
    markupLastIndex = markupIndex + rawMarkup.length;
  }

  if (markupLastIndex < text.length) {
    appendPlainPartsFromChunk(text.slice(markupLastIndex));
  }

  return parts;
};

export const buildComposerMentionParts = (value, selectedMentionUsers = []) => {
  const text = String(value || "");
  if (!text) return [];

  const mentionEntries = (selectedMentionUsers || [])
    .map((selectedUser) => ({
      userId: selectedUser?.$id ? String(selectedUser.$id) : "",
      label: sanitizeMentionLabel(selectedUser?.username || selectedUser?.name || ""),
    }))
    .filter((entry) => entry.userId && entry.label)
    .sort((a, b) => b.label.length - a.label.length);

  if (mentionEntries.length === 0) {
    return [{ type: "text", value: text }];
  }

  const mentionLabelPattern = mentionEntries.map((entry) => escapeRegExp(entry.label)).join("|");
  const mentionMatcher = new RegExp(`(^|[\\s([{])(${mentionLabelPattern})(?=$|[\\s.,!?;:)}\\]])`, "gi");
  const mentionsByLabel = new Map(mentionEntries.map((entry) => [normalizeMentionToken(entry.label), entry]));
  const parts = [];
  let cursor = 0;

  for (const match of text.matchAll(mentionMatcher)) {
    const index = match?.index ?? -1;
    const prefix = match?.[1] || "";
    const matchedValue = match?.[2] || "";
    if (index < 0 || !matchedValue) continue;

    if (index > cursor) {
      parts.push({
        type: "text",
        value: text.slice(cursor, index),
      });
    }

    if (prefix) {
      parts.push({
        type: "text",
        value: prefix,
      });
    }

    const mentionEntry = mentionsByLabel.get(normalizeMentionToken(matchedValue));
    parts.push({
      type: "mention",
      value: matchedValue,
      userId: mentionEntry?.userId || "",
      username: null,
    });

    cursor = index + prefix.length + matchedValue.length;
  }

  if (cursor < text.length) {
    parts.push({
      type: "text",
      value: text.slice(cursor),
    });
  }

  return parts;
};

export const findComposerMentionAtPosition = (value, selectedMentionUsers = [], position) => {
  const text = String(value || "");
  const cursor = Math.max(0, Math.min(text.length, Number(position) || 0));
  const parts = buildComposerMentionParts(text, selectedMentionUsers);
  let offset = 0;

  for (const part of parts) {
    const partValue = String(part?.value || "");
    const nextOffset = offset + partValue.length;

    if (part?.type === "mention" && cursor >= offset && cursor < nextOffset) {
      return part;
    }

    offset = nextOffset;
  }

  return null;
};

export const buildMentionSearchTerms = (value) => {
  const normalizedQuery = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalizedQuery) return [];

  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  const firstToken = tokens[0] || "";
  const lastToken = tokens.at(-1) || "";

  return Array.from(
    new Set(
      [
        normalizedQuery,
        normalizedQuery.toLowerCase(),
        compactQuery,
        compactQuery.toLowerCase(),
        firstToken,
        firstToken.toLowerCase(),
        lastToken,
        lastToken.toLowerCase(),
      ].filter(Boolean),
    ),
  );
};

const getMentionTokenMatchScore = (candidateToken, queryToken, { exact, startsWith, includes }) => {
  if (!candidateToken || !queryToken) return 0;
  if (candidateToken === queryToken) return exact;
  if (candidateToken.startsWith(queryToken)) return startsWith;
  if (candidateToken.includes(queryToken)) return includes;
  return 0;
};

export const getMentionUsernameMatchScore = (candidate, normalizedQuery) => {
  const normalizedSpacedQuery = normalizeMentionSearchQuery(normalizedQuery);
  const normalizedCompactQuery = normalizeMentionCompactQuery(normalizedQuery);
  const usernameToken = normalizeMentionToken(candidate?.username);
  const compactUsernameToken = normalizeMentionCompactQuery(candidate?.username);
  const nameToken = normalizeMentionToken(candidate?.name);
  const compactNameToken = normalizeMentionCompactQuery(candidate?.name);

  return Math.max(
    getMentionTokenMatchScore(usernameToken, normalizedSpacedQuery, { exact: 8, startsWith: 7, includes: 6 }),
    getMentionTokenMatchScore(compactUsernameToken, normalizedCompactQuery, { exact: 7, startsWith: 6, includes: 5 }),
    getMentionTokenMatchScore(nameToken, normalizedSpacedQuery, { exact: 5, startsWith: 4, includes: 3 }),
    getMentionTokenMatchScore(compactNameToken, normalizedCompactQuery, { exact: 4, startsWith: 3, includes: 2 }),
  );
};

export const rankMentionCandidatesByUsername = (candidates = [], query, excludedUserId = null) => {
  const normalizedQuery = normalizeMentionSearchQuery(query);
  const usersById = new Map();

  candidates.forEach((candidate) => {
    const candidateId = String(candidate?.$id || "");
    if (!candidateId || (excludedUserId && candidateId === String(excludedUserId))) return;
    usersById.set(candidateId, candidate);
  });

  if (!normalizedQuery) {
    return Array.from(usersById.values());
  }

  return Array.from(usersById.values())
    .map((candidate) => ({
      candidate,
      score: getMentionUsernameMatchScore(candidate, normalizedQuery),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aUsername = String(a.candidate?.username || "").toLowerCase();
      const bUsername = String(b.candidate?.username || "").toLowerCase();
      return aUsername.localeCompare(bUsername);
    })
    .map(({ candidate }) => candidate);
};
