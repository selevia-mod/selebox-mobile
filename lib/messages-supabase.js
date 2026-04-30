// Supabase chat service — Phase D of the Appwrite → Supabase migration.
//
// What this replaces:
//   `lib/stream.js` + `lib/stream-connection-manager.js` (Stream Chat) AND
//   the existing `lib/messages.js` Appwrite service. Mobile has been on
//   Stream Chat backed by an Appwrite chats/messages collection; web has
//   been on a Supabase-native chat for a while. This module is a faithful
//   port of the web's chat operations (see Selebox/js/app.js around the
//   dmState section) so mobile can read and write the same `conversations`
//   / `messages` / `message_reactions` tables the web is using. Once the
//   chat UI is ported in a follow-up session, mobile and web users see
//   each other's DMs in real time.
//
// Why this lives alongside the existing lib/messages.js:
//   The existing file (Appwrite-flavored) is still consumed by the chat UI
//   that ships today. Deleting it before the UI port would break things.
//   When the UI is rewritten on top of THIS module, lib/messages.js can be
//   deleted in the same OTA.
//
// Schema (already live on Supabase, used by web in production):
//   conversations
//     - id (uuid)
//     - user_a, user_b (uuid, nullable for group conversations)
//     - is_group (bool)
//     - name, avatar_url (group conversations only)
//     - created_by (uuid)
//     - last_message_at, last_message_preview, last_message_sender
//     - archived_by_a, archived_by_b (per-side archive flag)
//     - muted_until_a, muted_until_b (per-side mute timestamp)
//     - created_at
//   conversation_participants
//     - conversation_id, user_id (composite PK; only populated for groups)
//   messages
//     - id, conversation_id, sender_id
//     - body (text), image_url (nullable)
//     - reply_to_id (nullable, references messages.id)
//     - edited_at, deleted_at (nullable, soft-delete pattern)
//     - read_at (nullable, set by the recipient)
//     - created_at
//   message_reactions
//     - message_id, user_id, emoji (composite PK)
//
// RPCs:
//   mark_conversation_read(p_conversation_id uuid) — sets read_at on every
//   unread message in the conversation that the caller didn't send. Already
//   defined on the Supabase project (used by web).
//
// Ownership of session:
//   The chat backend (Supabase) stores conversations + messages keyed by
//   Supabase UUIDs. The mobile app, however, can be on either auth path:
//     • USE_SUPABASE_AUTH = true  → `supabase.auth.getUser()` returns the
//       canonical user with `.id` already a Supabase UUID.
//     • USE_SUPABASE_AUTH = false → Appwrite is the auth source. There is
//       NO Supabase session, so `supabase.auth.getUser()` returns null and
//       chat ops would fail outright.
//   For the Appwrite path we accept an explicit override via
//   `setMessagesAppwriteUser(appwriteId)` — global-provider calls this on
//   bootstrap / auth-change, the function resolves the Appwrite hex ID to
//   the canonical Supabase UUID via `profiles.legacy_appwrite_id`, and
//   `requireUser()` returns that UUID when no Supabase session exists.

import supabase from "./supabase";
import { convertToWebP } from "./utils/image-utils";

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

// Module-level cache populated by `setMessagesAppwriteUser`. Holds the
// Supabase UUID for the current Appwrite-authenticated user so requireUser()
// can answer without a live Supabase session.
let __appwriteSupabaseUserId = null;
let __appwriteSourceId = null;

const __UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Called by global-provider whenever the auth state changes. Resolves the
// raw user identifier (which may be either an Appwrite hex ID or already a
// Supabase UUID) to the canonical Supabase UUID and stashes it so chat ops
// can find it. Pass null on logout.
export const setMessagesAppwriteUser = async (rawId) => {
  if (!rawId) {
    __appwriteSupabaseUserId = null;
    __appwriteSourceId = null;
    return null;
  }
  // Already a UUID — common when USE_SUPABASE_AUTH is on. No round-trip.
  if (__UUID_RE.test(rawId)) {
    __appwriteSupabaseUserId = rawId;
    __appwriteSourceId = rawId;
    return rawId;
  }
  // Don't re-resolve the same Appwrite ID on every nav.
  if (__appwriteSourceId === rawId && __appwriteSupabaseUserId) {
    return __appwriteSupabaseUserId;
  }
  try {
    const { data } = await supabase.from("profiles").select("id").eq("legacy_appwrite_id", rawId).maybeSingle();
    if (data?.id) {
      __appwriteSourceId = rawId;
      __appwriteSupabaseUserId = data.id;
      return data.id;
    }
  } catch (error) {
    console.warn("[messages-supabase] resolve Appwrite → Supabase failed:", error?.message);
  }
  return null;
};

// Lets callers read the resolved id synchronously after the bootstrap
// resolve has completed. Returns null until `setMessagesAppwriteUser` lands.
export const getMessagesUserId = () => __appwriteSupabaseUserId;

const requireUser = async () => {
  // Priority order matters here. The explicit override populated by
  // global-provider via setMessagesAppwriteUser MUST win over whatever
  // supabase.auth.getUser() returns, because:
  //   - On the Appwrite-only path (USE_SUPABASE_AUTH=false) there is
  //     never a Supabase session, so getUser() returns null — the cache
  //     is the only answer.
  //   - On the Supabase-Auth path the cache is seeded with the same id
  //     getUser() would return, so they agree.
  //   - But if a user previously had a Supabase session that wasn't
  //     fully cleared (e.g. from a prior test build, or a half-finished
  //     sign-out), getUser() can still return that stale identity even
  //     though the active app session is now a different account on the
  //     Appwrite path. Trusting the cache first eliminates that class
  //     of bug — global-provider seeds it on every auth state change.
  if (__appwriteSupabaseUserId) {
    return { id: __appwriteSupabaseUserId };
  }
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) return user;
  } catch (_) { /* no session — fall through to error */ }
  throw new Error("Not signed in");
};

// "Other side" of a 1:1 conversation, given the row + the current user id.
//
// Returns null when `myId` is neither `user_a` nor `user_b`. The previous
// implementation silently defaulted to `user_a` in that case, which would
// label any foreign conversation that slipped through the filter with
// user_a's username — and that's exactly the symptom that caused the
// "duplicate Kwento ni Kuya" bug to look like duplication when it was
// actually a foreign row leaking in. Returning null here ensures the
// caller can detect and skip the row instead of mis-rendering it.
const resolveOtherUserId = (conversation, myId) => {
  if (!conversation || conversation.is_group) return null;
  if (conversation.user_a === myId) return conversation.user_b;
  if (conversation.user_b === myId) return conversation.user_a;
  return null;
};

// Per-side archive / mute fields. Conversations have two columns each —
// `archived_by_a` / `archived_by_b` and `muted_until_a` / `muted_until_b`.
// Each user touches the column matching their position in the row.
const sideKeys = (conversation, myId) => {
  const isA = conversation?.user_a === myId;
  return {
    archive: isA ? "archived_by_a" : "archived_by_b",
    mute: isA ? "muted_until_a" : "muted_until_b",
  };
};

// Fetches the unread message count per conversation, scoped to messages
// where the caller is NOT the sender and `read_at` is still NULL. Used
// by `loadConversations` to enrich each row with `unread`, and by
// useTotalUnreadCount to compute the bottom-tab badge.
//
// We deliberately filter `deleted_at IS NULL` so soft-deleted messages
// don't keep counting as "unread forever" — same shape as the web's
// `fetchUnreadCounts` (Selebox/js/app.js).
export const fetchUnreadCounts = async (conversationIds) => {
  if (!conversationIds || !conversationIds.length) return {};
  const me = await requireUser();
  const { data, error } = await supabase
    .from("messages")
    .select("conversation_id, sender_id")
    .in("conversation_id", conversationIds)
    .is("read_at", null)
    .is("deleted_at", null)
    .neq("sender_id", me.id);
  if (error) {
    console.log("[supabase-chat] fetchUnreadCounts failed:", error.message);
    return {};
  }
  const counts = {};
  for (const row of data || []) {
    counts[row.conversation_id] = (counts[row.conversation_id] || 0) + 1;
  }
  return counts;
};

// ─────────────────────────────────────────────────────────────────────────
// Conversations list
// ─────────────────────────────────────────────────────────────────────────

// Fetches the current user's conversations (1:1 + groups), already enriched
// with the other user's profile (1:1) or member list (group). Sorted by
// last_message_at desc. Mirrors the web's conversation-list bootstrap.
export const loadConversations = async () => {
  const me = await requireUser();

  // 1:1 conversations — user is either user_a or user_b.
  const { data: oneOnOne, error: oneError } = await supabase
    .from("conversations")
    .select(
      "id, user_a, user_b, is_group, name, avatar_url, created_by, last_message_at, last_message_preview, last_message_sender, archived_by_a, archived_by_b, muted_until_a, muted_until_b, created_at",
    )
    .eq("is_group", false)
    .or(`user_a.eq.${me.id},user_b.eq.${me.id}`)
    .order("last_message_at", { ascending: false, nullsFirst: false });
  if (oneError) throw oneError;

  // Group conversations — joined via conversation_participants.
  //
  // We MUST filter the joined conversation row to is_group=true here.
  // Without that filter, any stale participant row pointing at a 1:1
  // conversation (e.g., from an old web import or a participant insert
  // that ran before the is_group convention solidified) would be returned
  // here as a "group" and concatenated into the user's conversation list
  // — even when the user isn't actually user_a / user_b on that 1:1 row.
  // Symptom: a conversation belonging to a DIFFERENT account leaks into
  // your list and shows up as a duplicate of the other side's name.
  // The `!inner` modifier turns the join into an INNER JOIN so the
  // is_group filter on the joined table actually prunes parents.
  const { data: groupParts, error: groupError } = await supabase
    .from("conversation_participants")
    .select(
      "conversation_id, conversations!inner(id, user_a, user_b, is_group, name, avatar_url, created_by, last_message_at, last_message_preview, last_message_sender, archived_by_a, archived_by_b, muted_until_a, muted_until_b, created_at)",
    )
    .eq("user_id", me.id)
    .eq("conversations.is_group", true);
  if (groupError) throw groupError;
  const groups = (groupParts || []).map((p) => p.conversations).filter(Boolean);

  // Defensive merge: dedup by id AND drop any 1:1 row where the current
  // user isn't actually on user_a or user_b. The dedup guards against the
  // same conversation appearing via both queries; the membership check
  // guards against a 1:1 row sneaking in from anywhere (a stale
  // participant row, an off-by-one in a future query, etc.) and getting
  // mis-labeled with user_a's username — that mis-labeling is what made
  // the duplicate "Kwento ni Kuya" bug look like profile duplication when
  // it was actually a foreign row leaking through.
  const seenIds = new Set();
  const allConversations = [...(oneOnOne || []), ...groups].filter((c) => {
    if (!c?.id || seenIds.has(c.id)) return false;
    seenIds.add(c.id);
    if (!c.is_group) {
      // 1:1 — current user must be on either side. Otherwise it's a
      // foreign row we shouldn't be rendering.
      if (c.user_a !== me.id && c.user_b !== me.id) {
        if (__DEV__) {
          console.log("[supabase-chat] dropping foreign 1:1 row:", c.id, "me=", me.id, "ua=", c.user_a, "ub=", c.user_b);
        }
        return false;
      }
    }
    return true;
  });

  // Enrich: for 1:1, hydrate the other user's profile. For groups, hydrate
  // member profiles.
  const otherIds = new Set();
  for (const c of allConversations) {
    if (!c.is_group) {
      const otherId = resolveOtherUserId(c, me.id);
      if (otherId) otherIds.add(otherId);
    }
  }

  const groupIds = allConversations.filter((c) => c.is_group).map((c) => c.id);
  const memberMap = {};
  if (groupIds.length) {
    const { data: members } = await supabase.from("conversation_participants").select("conversation_id, user_id").in("conversation_id", groupIds);
    for (const m of members || []) {
      if (!memberMap[m.conversation_id]) memberMap[m.conversation_id] = [];
      memberMap[m.conversation_id].push(m.user_id);
      otherIds.add(m.user_id);
    }
  }

  // Hydrate profiles + unread counts in parallel — both touch independent
  // tables and the page render needs both before paint anyway.
  const conversationIdList = allConversations.map((c) => c.id);
  const [profilesRes, unreadByConv] = await Promise.all([
    otherIds.size
      ? supabase.from("profiles").select("id, username, avatar_url, is_guest").in("id", Array.from(otherIds))
      : Promise.resolve({ data: [] }),
    fetchUnreadCounts(conversationIdList),
  ]);
  const profileMap = {};
  for (const p of profilesRes?.data || []) profileMap[p.id] = p;

  return allConversations.map((c) => {
    const sides = sideKeys(c, me.id);
    const archived = Boolean(c[sides.archive]);
    const mutedUntil = c[sides.mute] || null;
    const muted = mutedUntil ? new Date(mutedUntil) > new Date() : false;
    const unread = unreadByConv[c.id] || 0;

    if (c.is_group) {
      const memberIds = memberMap[c.id] || [];
      const members = memberIds.map((id) => profileMap[id]).filter(Boolean);
      return {
        ...c,
        archived,
        muted,
        mutedUntil,
        unread,
        members,
        memberCount: members.length,
      };
    }
    const otherId = resolveOtherUserId(c, me.id);
    return {
      ...c,
      archived,
      muted,
      mutedUntil,
      unread,
      otherUser: otherId ? profileMap[otherId] || { id: otherId, username: "Unknown", avatar_url: null } : null,
    };
  });
};

// Loads a single conversation by id, enriched with the same shape
// `loadConversations` returns (otherUser for 1:1, members for groups,
// per-side archived/muted resolved). Used by the thread screen so it can
// render the header avatar + name + online dot when the user navigates
// directly to a thread (notification, deep link, profile Message button)
// without going through the conversations list first.
export const loadConversationById = async (conversationId) => {
  if (!conversationId) return null;
  const me = await requireUser();

  const { data: conversation, error } = await supabase
    .from("conversations")
    .select(
      "id, user_a, user_b, is_group, name, avatar_url, created_by, last_message_at, last_message_preview, last_message_sender, archived_by_a, archived_by_b, muted_until_a, muted_until_b, created_at",
    )
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw error;
  if (!conversation) return null;

  const sides = sideKeys(conversation, me.id);
  const archived = Boolean(conversation[sides.archive]);
  const mutedUntil = conversation[sides.mute] || null;
  const muted = mutedUntil ? new Date(mutedUntil) > new Date() : false;

  if (conversation.is_group) {
    const { data: parts } = await supabase.from("conversation_participants").select("user_id").eq("conversation_id", conversationId);
    const memberIds = (parts || []).map((p) => p.user_id);
    const { data: profiles } = memberIds.length
      ? await supabase.from("profiles").select("id, username, avatar_url, is_guest").in("id", memberIds)
      : { data: [] };
    return {
      ...conversation,
      archived,
      muted,
      mutedUntil,
      members: profiles || [],
      memberCount: (profiles || []).length,
    };
  }

  const otherId = resolveOtherUserId(conversation, me.id);
  let otherUser = { id: otherId, username: "Unknown", avatar_url: null };
  if (otherId) {
    const { data: profile } = await supabase.from("profiles").select("id, username, avatar_url, is_guest").eq("id", otherId).maybeSingle();
    if (profile) otherUser = profile;
  }

  return {
    ...conversation,
    archived,
    muted,
    mutedUntil,
    otherUser,
  };
};

// Resolves the existing 1:1 conversation between the current user and
// `otherUserId`, or creates one. Used when the user taps "Message" on a
// profile.
export const getOrCreate1to1Conversation = async (otherUserId) => {
  const me = await requireUser();
  // The caller (e.g. profile screen "Message" button) may hand us either a
  // Supabase UUID (native profiles) or a legacy Appwrite hex ID. Resolve the
  // hex case via the legacy_appwrite_id mirror column so the conversation
  // row carries the canonical UUID.
  //
  // If resolution fails (no Supabase profile is linked to this Appwrite
  // user — i.e. the target hasn't been migrated), we MUST throw an explicit
  // error here. Falling through with the raw hex would pass it to the
  // INSERT below, which would fail with "invalid input syntax for type
  // uuid" — that's the silent failure that's been hiding the real cause.
  let resolvedOther = otherUserId;
  if (otherUserId && !__UUID_RE.test(otherUserId)) {
    let lookupErr = null;
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("id")
        .eq("legacy_appwrite_id", otherUserId)
        .maybeSingle();
      if (error) lookupErr = error;
      if (data?.id) {
        resolvedOther = data.id;
      } else {
        // No profile row mirrors this Appwrite ID. Surface a clear error
        // so the UI can show something better than the generic "could not
        // start conversation" — this user simply isn't on the new chat
        // system yet.
        throw new Error("This user isn't available for chat yet");
      }
    } catch (e) {
      // Re-throw user-facing errors as-is, wrap unexpected ones.
      if (e?.message === "This user isn't available for chat yet") throw e;
      throw new Error(`Could not resolve target profile: ${e?.message || lookupErr?.message || "unknown"}`);
    }
  }
  if (!resolvedOther || resolvedOther === me.id) {
    throw new Error("Cannot start a conversation with yourself");
  }
  // From here on the local var carries the canonical UUID; the rest of the
  // function uses `resolvedOther` so existing-conversation lookup + insert
  // both store and match by the canonical id.
  const otherForQueries = resolvedOther;

  // The conversations table has a `conv_canonical_order` CHECK constraint
  // that enforces user_a < user_b for 1:1 rows — this prevents the same
  // pair from existing in two orderings (which would create duplicate
  // 1:1 conversations). Sort the two UUIDs before SELECT and INSERT so
  // we always store the canonical (smaller, larger) tuple.
  const [canonicalA, canonicalB] = me.id < otherForQueries
    ? [me.id, otherForQueries]
    : [otherForQueries, me.id];

  // Look up an existing 1:1 row in the canonical orientation. Because
  // every row in this table is stored canonically, we don't need to
  // check both directions — just one comparison.
  const lookupExisting = async () => {
    const { data } = await supabase
      .from("conversations")
      .select("*")
      .eq("is_group", false)
      .eq("user_a", canonicalA)
      .eq("user_b", canonicalB)
      .maybeSingle();
    return data;
  };

  const existing = await lookupExisting();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from("conversations")
    .insert({
      user_a: canonicalA,
      user_b: canonicalB,
      is_group: false,
      // `created_by` always reflects who initiated the conversation, NOT
      // the canonical-A side — those are different concepts. Keep me.id
      // here so the audit trail is correct.
      created_by: me.id,
    })
    .select()
    .single();
  if (!error) return created;

  // Race: two clients SELECTed no row, both INSERTed. Postgres' unique
  // index on (user_a, user_b) for is_group=false rejects the second.
  // Code 23505 = unique_violation. Re-SELECT and return the winner.
  if (error.code === "23505") {
    const winner = await lookupExisting();
    if (winner) return winner;
  }
  throw error;
};

// Creates a group conversation with the given member IDs (which must NOT
// include the creator — we add them automatically). All members get a row
// in conversation_participants. Members can be added later by inserting
// more participant rows; that's not exposed in v1.
//
// `name` and `avatarUrl` are optional but strongly recommended. If `name`
// is empty we synthesize one from the first 3 member usernames as a
// fallback.
export const createGroupConversation = async ({ memberIds = [], name = "", avatarUrl = null } = {}) => {
  const me = await requireUser();
  if (!Array.isArray(memberIds) || memberIds.length < 2) {
    throw new Error("Pick at least 2 people for a group");
  }

  // Resolve any legacy Appwrite IDs to canonical Supabase UUIDs so the
  // participant rows always store the canonical id. Mixed input is fine.
  const resolvedMembers = [];
  for (const raw of memberIds) {
    if (!raw) continue;
    if (__UUID_RE.test(raw)) {
      resolvedMembers.push(raw);
      continue;
    }
    try {
      const { data } = await supabase.from("profiles").select("id").eq("legacy_appwrite_id", raw).maybeSingle();
      if (data?.id) resolvedMembers.push(data.id);
    } catch (_) { /* skip unresolvable */ }
  }
  // Dedupe + drop the creator if they accidentally selected themselves.
  const memberSet = new Set(resolvedMembers.filter((id) => id && id !== me.id));
  if (memberSet.size < 2) throw new Error("Pick at least 2 people for a group");

  // Synthesize a fallback name when none was provided.
  let finalName = (name || "").trim();
  if (!finalName) {
    const sampleIds = Array.from(memberSet).slice(0, 3);
    const { data: profiles } = await supabase.from("profiles").select("username").in("id", sampleIds);
    const usernames = (profiles || []).map((p) => p.username).filter(Boolean);
    finalName = usernames.length ? usernames.join(", ") : "New group";
  }

  // Insert the group conversation row. user_a/user_b are NULL for groups
  // (the unique-pair index is partial — only enforced where is_group=false).
  const { data: created, error } = await supabase
    .from("conversations")
    .insert({
      is_group: true,
      name: finalName,
      avatar_url: avatarUrl,
      created_by: me.id,
    })
    .select()
    .single();
  if (error) throw error;

  // Add participants — creator first, then the rest. Concurrent INSERTs
  // would be fine but a single batch is simpler.
  const participantRows = [{ conversation_id: created.id, user_id: me.id }];
  for (const id of memberSet) {
    participantRows.push({ conversation_id: created.id, user_id: id });
  }
  const { error: pErr } = await supabase.from("conversation_participants").insert(participantRows);
  if (pErr) {
    // Best-effort cleanup so we don't leave orphan rooms with no participants.
    await supabase.from("conversations").delete().eq("id", created.id);
    throw pErr;
  }
  return created;
};

// ─────────────────────────────────────────────────────────────────────────
// Messages within a conversation
// ─────────────────────────────────────────────────────────────────────────

// Fetches the most recent `limit` messages for a conversation, ordered
// chronologically (oldest first) so the UI can render top-to-bottom.
export const loadMessages = async (conversationId, { limit = 50 } = {}) => {
  if (!conversationId) return { messages: [], reactions: {} };

  const { data: messages, error } = await supabase
    .from("messages")
    .select("id, conversation_id, sender_id, body, image_url, reply_to_id, edited_at, deleted_at, read_at, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const ordered = (messages || []).slice().reverse();
  const messageIds = ordered.map((m) => m.id);

  const { data: reactionRows } = messageIds.length
    ? await supabase.from("message_reactions").select("message_id, user_id, emoji").in("message_id", messageIds)
    : { data: [] };
  const reactions = {};
  for (const r of reactionRows || []) {
    if (!reactions[r.message_id]) reactions[r.message_id] = [];
    reactions[r.message_id].push(r);
  }

  return { messages: ordered, reactions };
};

// Uploads a local image (from expo-image-picker) to Supabase Storage and
// returns the public URL. Used by the chat composer's "+" button when the
// user attaches a photo. Stored under chat-images/<conversationId>/<filename>
// in the existing public 'images' bucket — same bucket the web client and
// post composer use, so we reuse its CORS + size policies.
//
// Compression: a phone camera typically produces a 4–8 MB JPEG. Without
// compression every chat photo would burn that much data on the sender's
// uplink AND on every recipient's downlink, every render. We run the
// picked URI through the same `convertToWebP` helper the rest of the
// app uses (posts, avatars) — caps width at 1200px, encodes WebP at 0.7
// quality, which lands a typical photo at 100–250 KB. Worth the extra
// 300–800 ms on the sender's device on first send; it's a one-time cost
// per photo and saves multiples of that on every later view.
export const uploadChatImage = async (localUri, conversationId) => {
  if (!localUri) throw new Error("localUri is required");
  if (!conversationId) throw new Error("conversationId is required");
  const me = await requireUser();

  // Best-effort compression. If the helper fails for any reason it
  // returns the original URI untouched, so we still have something to
  // upload. We accept the larger payload over a hard failure.
  const { uri: compressedUri } = await convertToWebP(localUri, {
    compress: 0.7,
    maxWidth: 1200,
  });

  // Convert URI → ArrayBuffer. expo-image-picker's URI on iOS/Android is
  // either file:// or ph:// (iOS asset library). fetch() handles both.
  // After convertToWebP the URI is a file:// pointing into the app's
  // cache directory — fetch handles that too.
  const response = await fetch(compressedUri);
  if (!response.ok) throw new Error(`Failed to read local image: ${response.status}`);
  const blob = await response.blob();
  // Read as ArrayBuffer for Supabase Storage's upload — passing the blob
  // directly works on web but not in React Native, where blobs are
  // basically just URI references.
  const arrayBuffer = await new Response(blob).arrayBuffer();

  // Use a stable .webp extension when we successfully converted, else
  // fall back to whatever the source had. Math.random suffix is just
  // for filename uniqueness — not security-sensitive.
  const isWebP = compressedUri !== localUri;
  const ext = isWebP
    ? "webp"
    : (localUri.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const filename = `chat-images/${conversationId}/${me.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error } = await supabase.storage.from("images").upload(filename, arrayBuffer, {
    contentType: isWebP ? "image/webp" : (blob.type || `image/${ext}`),
    cacheControl: "3600",
    upsert: false,
  });
  if (error) throw error;

  const { data } = supabase.storage.from("images").getPublicUrl(filename);
  if (!data?.publicUrl) throw new Error("Could not resolve public URL for uploaded image");
  return data.publicUrl;
};

// Sends a text message. `replyToId` and `imageUrl` are optional. Returns
// the inserted row so the UI can swap an optimistic temp message for the
// canonical row in place.
//
// We deliberately let the server assign `id` (via the column's default
// UUID generator) rather than supplying our own. The thread component
// uses the awaited row's id to swap its `temp-<ts>` optimistic, mirroring
// the web's proven pattern. Passing a client-generated id would work for
// the common case but breaks silently if a trigger or constraint ever
// overrides it — the awaited-response swap is failure-safe.
export const sendMessage = async ({ conversationId, body, replyToId = null, imageUrl = null }) => {
  if (!conversationId) throw new Error("conversationId is required");
  const trimmed = (body || "").trim();
  if (!trimmed && !imageUrl) throw new Error("Empty message");
  const me = await requireUser();

  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_id: me.id,
      body: trimmed,
      reply_to_id: replyToId,
      image_url: imageUrl,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Updates an existing message's body. Server stamps `edited_at`. Caller
// should optimistically render the new body and roll back on error.
//
// Defense in depth: scope the UPDATE to the caller's own messages by
// matching `sender_id` server-side. RLS should already enforce this
// on a tighter `USING` clause, but the explicit filter means a
// misconfigured policy can't expand our blast radius — at worst the
// UPDATE matches zero rows and we get a "no row returned" error from
// .single() which the caller surfaces.
export const editMessage = async (messageId, newBody) => {
  if (!messageId) throw new Error("messageId is required");
  const trimmed = (newBody || "").trim();
  if (!trimmed) throw new Error("Empty message");
  const me = await requireUser();

  const { data, error } = await supabase
    .from("messages")
    .update({ body: trimmed, edited_at: new Date().toISOString() })
    .eq("id", messageId)
    .eq("sender_id", me.id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Soft-deletes a message — the row stays so reply chains aren't broken,
// but the UI renders it as "Message deleted". Mirrors the web's pattern.
//
// Same defense-in-depth as editMessage: caller can only delete their own.
export const deleteMessage = async (messageId) => {
  if (!messageId) throw new Error("messageId is required");
  const me = await requireUser();
  const { error } = await supabase
    .from("messages")
    .update({ deleted_at: new Date().toISOString(), body: "" })
    .eq("id", messageId)
    .eq("sender_id", me.id);
  if (error) throw error;
};

// ─────────────────────────────────────────────────────────────────────────
// Reactions
// ─────────────────────────────────────────────────────────────────────────

// Toggles a reaction for the current user on a given message. If the user
// already reacted with the same emoji, the reaction is removed; otherwise
// any existing reaction is replaced (one emoji per user per message).
export const toggleReaction = async (messageId, emoji) => {
  if (!messageId || !emoji) throw new Error("messageId and emoji required");
  const me = await requireUser();

  const { data: existing } = await supabase.from("message_reactions").select("emoji").eq("message_id", messageId).eq("user_id", me.id).maybeSingle();

  if (existing) {
    if (existing.emoji === emoji) {
      const { error } = await supabase.from("message_reactions").delete().eq("message_id", messageId).eq("user_id", me.id);
      if (error) throw error;
      return { action: "removed", emoji };
    }
    const { error } = await supabase.from("message_reactions").update({ emoji }).eq("message_id", messageId).eq("user_id", me.id);
    if (error) throw error;
    return { action: "changed", emoji };
  }

  const { error } = await supabase.from("message_reactions").insert({ message_id: messageId, user_id: me.id, emoji });
  if (error) throw error;
  return { action: "added", emoji };
};

// ─────────────────────────────────────────────────────────────────────────
// Read tracking
// ─────────────────────────────────────────────────────────────────────────

// RPC call. Sets `read_at` on every unread message in the conversation
// that the caller didn't send. Defined on the Supabase project; mirrors
// the web's mark-as-read flow.
//
// The RPC uses auth.uid() server-side, which is NULL for our Appwrite
// users. Rather than letting that silently bubble up and break the
// thread load, we swallow the error here — read tracking is a non-
// critical "nice to have" in the migration window. The thread itself
// always loads fine because messages are independent of read state.
export const markConversationRead = async (conversationId) => {
  if (!conversationId) return;
  try {
    const { error } = await supabase.rpc("mark_conversation_read", { p_conversation_id: conversationId });
    if (error) {
      // Log but don't throw — read tracking failure shouldn't block chat.
      console.log("[supabase-chat] markConversationRead skipped:", error?.message);
    }
  } catch (e) {
    console.log("[supabase-chat] markConversationRead exception:", e?.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Per-conversation settings (archive, mute)
// ─────────────────────────────────────────────────────────────────────────

// Toggles the per-side archive flag on a conversation.
export const setArchived = async (conversation, archived) => {
  if (!conversation?.id) throw new Error("conversation required");
  const me = await requireUser();
  const { archive } = sideKeys(conversation, me.id);
  const { error } = await supabase
    .from("conversations")
    .update({ [archive]: Boolean(archived) })
    .eq("id", conversation.id);
  if (error) throw error;
};

// Leaves a group conversation by removing the caller's row from
// `conversation_participants`. Mirrors the web's `leave_conversation` RPC.
// 1:1 conversations are intentionally NOT supported here — for a 1:1 the
// equivalent action is "Delete conversation" which sets the per-side
// archived flag (see setArchived below). A user leaving a 1:1 outright
// would need a schema-level membership change beyond this OTA's scope.
export const leaveGroup = async (conversationId) => {
  if (!conversationId) throw new Error("conversationId required");
  const me = await requireUser();
  const { error } = await supabase
    .from("conversation_participants")
    .delete()
    .eq("conversation_id", conversationId)
    .eq("user_id", me.id);
  if (error) throw error;
};

// Sets a mute expiration for the current side. Pass null to unmute, or a
// Date / ISO string for "muted until then".
export const setMutedUntil = async (conversation, until) => {
  if (!conversation?.id) throw new Error("conversation required");
  const me = await requireUser();
  const { mute } = sideKeys(conversation, me.id);
  const value = until instanceof Date ? until.toISOString() : until || null;
  const { error } = await supabase
    .from("conversations")
    .update({ [mute]: value })
    .eq("id", conversation.id);
  if (error) throw error;
};

// ─────────────────────────────────────────────────────────────────────────
// Realtime subscriptions
// ─────────────────────────────────────────────────────────────────────────

// Subscribes to live updates within a conversation thread (new messages,
// edits, deletes, reactions). Handlers receive the changed row. Returns
// an unsubscribe function. Mirrors the web's subscribeToThread pattern.
export const subscribeToConversation = (conversationId, handlers = {}) => {
  if (!conversationId) return () => {};
  const channel = supabase
    .channel(`conv-thread-${conversationId}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` }, (payload) =>
      handlers.onMessageInsert?.(payload.new),
    )
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` }, (payload) =>
      handlers.onMessageUpdate?.(payload.new, payload.old),
    )
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "message_reactions" }, (payload) => handlers.onReactionInsert?.(payload.new))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "message_reactions" }, (payload) =>
      handlers.onReactionUpdate?.(payload.new, payload.old),
    )
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "message_reactions" }, (payload) => handlers.onReactionDelete?.(payload.old))
    .subscribe();

  return () => {
    // Defensive: removeChannel can throw on some SDK versions when the
    // channel never finished subscribing (e.g., the user closed the screen
    // before SUBSCRIBED fired). Swallow so cleanup never crashes the
    // unmount path.
    try {
      if (channel) supabase.removeChannel(channel);
    } catch (error) {
      console.log("[supabase-chat] channel cleanup failed:", error?.message);
    }
  };
};

// Subscribes to inbox-wide events (any new message in any of my conversations)
// for the unread badge / push fallback. The web uses this to bump unread
// counts on the conversation list without re-fetching. We don't filter by
// conversation here because the user is in many — let the handler decide
// which conversation got the new message and update state accordingly.
export const subscribeToInbox = (handler) => {
  const channel = supabase
    .channel("inbox")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
      handler?.(payload.new);
    })
    .subscribe();
  return () => {
    // Defensive: removeChannel can throw on some SDK versions when the
    // channel never finished subscribing (e.g., the user closed the screen
    // before SUBSCRIBED fired). Swallow so cleanup never crashes the
    // unmount path.
    try {
      if (channel) supabase.removeChannel(channel);
    } catch (error) {
      console.log("[supabase-chat] channel cleanup failed:", error?.message);
    }
  };
};

// Subscribes to a presence + typing channel for a single conversation.
// Mirrors the web's `subscribeToPresenceAndTyping(convId)` so the typing
// dots + online indicator stay synced across web and mobile clients.
//
// What this is NOT: postgres_changes. That's `subscribeToConversation` —
// these two channels are separate by design. Postgres-changes carries
// authoritative DB events (messages, edits, deletes, reactions), while
// this presence channel carries ephemeral broadcast traffic that doesn't
// need to be persisted (typing dots, online dot).
//
// `currentUserId` is required so we can `track()` ourselves into the
// presence state and ignore our own typing broadcasts. `handlers` is the
// same shape as `subscribeToConversation` — pass the slices you care about.
export const subscribeToPresenceAndTyping = (conversationId, currentUserId, handlers = {}) => {
  if (!conversationId || !currentUserId) return () => {};
  const channel = supabase.channel(`conv-presence-${conversationId}`, {
    config: { presence: { key: currentUserId } },
  });

  channel
    .on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      // Build a Set of user IDs currently present (excluding ourselves)
      // so the consumer can render an "online" dot for any of them.
      const onlineUserIds = Object.keys(state).filter((id) => id !== currentUserId);
      handlers.onPresenceSync?.(onlineUserIds);
    })
    .on("broadcast", { event: "typing" }, (payload) => {
      const fromId = payload?.payload?.userId;
      // Drop our own typing echo. Only consumers should see the OTHER
      // side typing.
      if (!fromId || fromId === currentUserId) return;
      handlers.onTyping?.(fromId);
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        // Track ourselves into the presence state. Web does the same on
        // SUBSCRIBED so both clients see each other immediately on the
        // next sync event.
        try {
          await channel.track({ userId: currentUserId, online_at: new Date().toISOString() });
        } catch (error) {
          console.log("[supabase-chat] presence track failed:", error?.message);
        }
      }
    });

  return () => {
    // Defensive: removeChannel can throw on some SDK versions when the
    // channel never finished subscribing (e.g., the user closed the screen
    // before SUBSCRIBED fired). Swallow so cleanup never crashes the
    // unmount path.
    try {
      if (channel) supabase.removeChannel(channel);
    } catch (error) {
      console.log("[supabase-chat] channel cleanup failed:", error?.message);
    }
  };
};

// Broadcasts a typing event on the presence channel. Mobile callers should
// throttle this — once every 1.5–2 seconds while the composer has changes
// is plenty (the receiver clears the indicator after 3.5s of silence).
// We accept the channel reference instead of looking it up each time so
// the caller doesn't fight `supabase.channel()` for the same name.
export const sendTypingBroadcast = async (conversationId, currentUserId) => {
  if (!conversationId || !currentUserId) return;
  // Reuse the same channel name the subscription uses. Realtime channels
  // are idempotent — if we already have a channel by that name, this call
  // returns the existing instance.
  const channel = supabase.channel(`conv-presence-${conversationId}`);
  try {
    await channel.send({
      type: "broadcast",
      event: "typing",
      payload: { userId: currentUserId, at: Date.now() },
    });
  } catch (error) {
    console.log("[supabase-chat] typing broadcast failed:", error?.message);
  }
};
