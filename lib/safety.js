import { ID, Query } from "react-native-appwrite";
import { appwriteConfig, databases } from "./appwrite";
import supabase from "./supabase";

const missingConfig = (key) => {
  console.warn(`[safety] Missing Appwrite config for ${key}. Please set it in secrets before enabling this feature.`);
  return null;
};

// Dual-write reports to BOTH Appwrite (legacy) AND Supabase (new unified
// content_reports table) during the migration window.
//
// Why dual-write:
//   • Old admin tooling still reads Appwrite — keep filling it so nothing
//     breaks while the admin UI is updated to read Supabase.
//   • New admin tooling (and the unified queue across posts/videos/books/
//     chat) reads Supabase — fill it from now on so moderators see the
//     full picture going forward.
//
// When Appwrite is fully retired (admin UI 100% on Supabase + historical
// post_reports backfilled), drop the Appwrite half.
//
// Failure semantics: each write is best-effort with its own try/catch.
// A failure on EITHER side doesn't block the other — the user's report
// still lands somewhere as long as one backend is reachable.
export const reportContent = async ({ contentId, contentType, reporterId, ownerId, reason, notes }) => {
  // Fire both writes in parallel — they're independent.
  const [appwriteRes, supabaseRes] = await Promise.allSettled([
    writeAppwriteReport({ contentId, contentType, reporterId, ownerId, reason, notes }),
    writeSupabaseReport({ contentId, contentType, reporterId, ownerId, reason, notes }),
  ]);

  // Surface the most useful return value:
  //   • Prefer the Supabase result (the new source of truth).
  //   • Fall back to the Appwrite document on error.
  //   • Log any individual failures so we can monitor migration health.
  if (appwriteRes.status === "rejected") {
    console.log("[safety] Appwrite report write failed:", appwriteRes.reason?.message);
  }
  if (supabaseRes.status === "rejected") {
    console.log("[safety] Supabase report write failed:", supabaseRes.reason?.message);
  }
  if (supabaseRes.status === "fulfilled" && supabaseRes.value) {
    return supabaseRes.value;
  }
  if (appwriteRes.status === "fulfilled" && appwriteRes.value) {
    return appwriteRes.value;
  }
  throw new Error("Failed to submit report (both backends unavailable)");
};

const writeAppwriteReport = async ({ contentId, contentType, reporterId, ownerId, reason, notes }) => {
  if (!appwriteConfig.contentReportsCollectionId) return missingConfig("contentReportsCollectionId");
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.contentReportsCollectionId, ID.unique(), {
    contentId,
    contentType,
    reporterId,
    ownerId,
    reason,
    notes,
    status: "open",
  });
};

const writeSupabaseReport = async ({ contentId, contentType, reporterId, ownerId, reason, notes }) => {
  if (!contentId || !contentType || !reporterId) return null;
  // Map any Appwrite-specific content types to the canonical Supabase set.
  // The DB CHECK constraint accepts: post, video, book, chapter, comment,
  // user, message. Anything outside that gets normalized so the INSERT
  // doesn't reject.
  const allowed = new Set(["post", "video", "book", "chapter", "comment", "user", "message"]);
  const normalizedType = allowed.has(contentType) ? contentType : "post";

  const { data, error } = await supabase.rpc("submit_content_report", {
    p_content_id: String(contentId),
    p_content_type: normalizedType,
    p_reporter_id: String(reporterId),
    p_owner_id: ownerId ? String(ownerId) : null,
    p_reason: reason || null,
    p_notes: notes || null,
  });
  if (error) throw error;
  // RPC returns the new row's UUID, or null when the dedup window blocked
  // a duplicate submission. Either case is "success" from the caller's
  // perspective — they just don't get a row id back on dedup.
  return data ? { id: data, contentId, contentType, status: "open" } : null;
};

// blockUser: dual-writes the block to BOTH Appwrite (legacy) AND Supabase
// (new unified user_blocks table) during the migration window. Same
// pattern as reportContent above.
//
// Why dual-write here too:
//   • Appwrite still backs some legacy mobile screens until the rest of
//     the migration completes.
//   • Web reads from Supabase only (user_blocks). Without the Supabase
//     write, a block done on mobile is invisible to web — the user is
//     "blocked" on mobile but not on web. Cross-platform safety hole.
//
// IDs: Appwrite uses hex IDs; Supabase uses UUIDs. We resolve both ids
// through profiles.legacy_appwrite_id at write time so the Supabase row
// uses the canonical UUIDs the rest of the Supabase schema expects.
export const blockUser = async ({ blockerId, blockedUserId, contentId, contentType, reason }) => {
  // Fire both writes in parallel — they're independent.
  const [appwriteRes, supabaseRes] = await Promise.allSettled([
    writeAppwriteBlock({ blockerId, blockedUserId, contentId, contentType, reason }),
    writeSupabaseBlock({ blockerId, blockedUserId }),
  ]);
  if (appwriteRes.status === "rejected") {
    console.log("[safety] Appwrite block write failed:", appwriteRes.reason?.message);
  }
  if (supabaseRes.status === "rejected") {
    console.log("[safety] Supabase block write failed:", supabaseRes.reason?.message);
  }
  if (appwriteRes.status === "fulfilled" && appwriteRes.value) return appwriteRes.value;
  if (supabaseRes.status === "fulfilled" && supabaseRes.value) return supabaseRes.value;
  throw new Error("Failed to block (both backends unavailable)");
};

const writeAppwriteBlock = async ({ blockerId, blockedUserId, contentId, contentType, reason }) => {
  if (!appwriteConfig.userBlocksCollectionId) return missingConfig("userBlocksCollectionId");
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.userBlocksCollectionId, ID.unique(), {
    blockerId,
    blockedUserId,
    contentId,
    contentType,
    reason,
  });
};

const writeSupabaseBlock = async ({ blockerId, blockedUserId }) => {
  const blockerUuid = await resolveAppwriteHexToUuid(blockerId);
  const blockedUuid = await resolveAppwriteHexToUuid(blockedUserId);
  if (!blockerUuid || !blockedUuid) {
    // Either user isn't on Supabase yet (post-migration signup gap, or
    // the block target is a brand-new account). Skip rather than raise —
    // the Appwrite half already wrote, and the Supabase row would be
    // unresolvable anyway.
    return null;
  }
  // Idempotent on the (user_id, blocked_user_id) PK — Postgres rejects
  // a duplicate INSERT with 23505, treated as success here.
  const { data, error } = await supabase
    .from("user_blocks")
    .upsert({ user_id: blockerUuid, blocked_user_id: blockedUuid }, {
      onConflict: "user_id,blocked_user_id",
      ignoreDuplicates: true,
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
};

export const unblockUser = async ({ blockerId, blockedUserId }) => {
  // Same dual-write pattern in reverse — delete on both sides.
  const [appwriteRes, supabaseRes] = await Promise.allSettled([
    deleteAppwriteBlock({ blockerId, blockedUserId }),
    deleteSupabaseBlock({ blockerId, blockedUserId }),
  ]);
  if (appwriteRes.status === "rejected") {
    console.log("[safety] Appwrite unblock failed:", appwriteRes.reason?.message);
  }
  if (supabaseRes.status === "rejected") {
    console.log("[safety] Supabase unblock failed:", supabaseRes.reason?.message);
  }
  // Either succeeding is enough.
  return appwriteRes.status === "fulfilled" || supabaseRes.status === "fulfilled";
};

const deleteAppwriteBlock = async ({ blockerId, blockedUserId }) => {
  if (!appwriteConfig.userBlocksCollectionId) return missingConfig("userBlocksCollectionId");

  const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.userBlocksCollectionId, [
    Query.equal("blockerId", blockerId),
    Query.equal("blockedUserId", blockedUserId),
  ]);

  if (res.documents.length === 0) return null;

  const deletions = res.documents.map((doc) => databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.userBlocksCollectionId, doc.$id));
  await Promise.all(deletions);
  return true;
};

const deleteSupabaseBlock = async ({ blockerId, blockedUserId }) => {
  const blockerUuid = await resolveAppwriteHexToUuid(blockerId);
  const blockedUuid = await resolveAppwriteHexToUuid(blockedUserId);
  if (!blockerUuid || !blockedUuid) return null;
  const { error } = await supabase
    .from("user_blocks")
    .delete()
    .eq("user_id", blockerUuid)
    .eq("blocked_user_id", blockedUuid);
  if (error) throw error;
  return true;
};

// ─────────────────────────────────────────────────────────────────────────
// ID resolution helper — Appwrite hex → Supabase UUID via the migration's
// profiles.legacy_appwrite_id mirror column. UUIDs pass through as-is.
//
// Cached per-id for the lifetime of the JS bundle. The mapping is
// immutable (a profile's legacy_appwrite_id never changes), so the
// cache never goes stale.
// ─────────────────────────────────────────────────────────────────────────
const _appwriteToUuidCache = new Map();
const _UUID_RE_SAFETY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resolveAppwriteHexToUuid = async (rawId) => {
  if (!rawId) return null;
  if (_UUID_RE_SAFETY.test(rawId)) return rawId;
  if (_appwriteToUuidCache.has(rawId)) return _appwriteToUuidCache.get(rawId);
  const { data, error } = await supabase.from("profiles").select("id").eq("legacy_appwrite_id", rawId).maybeSingle();
  if (error) {
    console.log("[safety] resolveAppwriteHexToUuid failed:", error.message);
    return null;
  }
  const resolved = data?.id || null;
  if (resolved) _appwriteToUuidCache.set(rawId, resolved);
  return resolved;
};

export const listBlockedUsers = async ({ blockerId }) => {
  if (!appwriteConfig.userBlocksCollectionId) return [];

  const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.userBlocksCollectionId, [Query.equal("blockerId", blockerId)]);
  return res.documents.map((doc) => doc.blockedUserId);
};

export const listUserReports = async ({ reporterId }) => {
  if (!appwriteConfig.contentReportsCollectionId) return [];

  const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.contentReportsCollectionId, [
    Query.equal("reporterId", reporterId),
  ]);
  return res.documents.map((doc) => doc.contentId);
};

export const recordEulaAcceptance = async ({ userId, version, acceptedAt }) => {
  if (!appwriteConfig.userAgreementsCollectionId) return missingConfig("userAgreementsCollectionId");

  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.userAgreementsCollectionId, ID.unique(), {
    userId,
    version,
    acceptedAt,
  });
};

// hideContent dual-writes to BOTH Appwrite (legacy userHiddenContent) AND
// Supabase (post_hides) during the migration window. Same dual-write
// pattern as blockUser/reportContent above.
//
// Note: post_hides is post-only. If contentType is 'video' or 'book',
// the Supabase write is skipped — we don't have a unified hides table
// for those yet. Mobile already wrote to Appwrite which can stay the
// source of truth for non-post hides for now.
export const hideContent = async ({ userId, contentId, contentType }) => {
  const [appwriteRes, supabaseRes] = await Promise.allSettled([
    writeAppwriteHide({ userId, contentId, contentType }),
    contentType === "post" ? writeSupabaseHide({ userId, postId: contentId }) : Promise.resolve(null),
  ]);
  if (appwriteRes.status === "rejected") {
    console.log("[safety] Appwrite hide write failed:", appwriteRes.reason?.message);
  }
  if (supabaseRes.status === "rejected") {
    console.log("[safety] Supabase hide write failed:", supabaseRes.reason?.message);
  }
  if (appwriteRes.status === "fulfilled" && appwriteRes.value) return appwriteRes.value;
  if (supabaseRes.status === "fulfilled" && supabaseRes.value) return supabaseRes.value;
  // No throw on hides — best-effort local UX. Failure to persist still
  // suppresses in-session via the cached filter set update at call site.
  return null;
};

const writeAppwriteHide = async ({ userId, contentId, contentType }) => {
  if (!appwriteConfig.userHiddenContentCollectionId) return missingConfig("userHiddenContentCollectionId");
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.userHiddenContentCollectionId, ID.unique(), {
    userId,
    contentId,
    contentType,
  });
};

const writeSupabaseHide = async ({ userId, postId }) => {
  const userUuid = await resolveAppwriteHexToUuid(userId);
  if (!userUuid || !postId) return null;
  const { data, error } = await supabase
    .from("post_hides")
    .upsert({ user_id: userUuid, post_id: postId }, {
      onConflict: "user_id,post_id",
      ignoreDuplicates: true,
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
};

export const listHiddenContent = async ({ userId }) => {
  if (!appwriteConfig.userHiddenContentCollectionId) return [];

  const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.userHiddenContentCollectionId, [Query.equal("userId", userId)]);
  return res.documents.map((doc) => doc.contentId);
};

// Snoozes a creator for a fixed duration. Supabase-only — Appwrite
// doesn't have a snooze table and we don't need to backfill (this is a
// new mobile-side action; web has had it for a while).
//
// `durationDays` defaults to 30 to match web's Messenger-style
// "snooze for 30 days" affordance. Pass null to clear an existing
// snooze.
export const snoozeUser = async ({ userId, targetUserId, durationDays = 30 }) => {
  const userUuid = await resolveAppwriteHexToUuid(userId);
  const targetUuid = await resolveAppwriteHexToUuid(targetUserId);
  if (!userUuid || !targetUuid) {
    throw new Error("Could not resolve users for snooze");
  }
  if (durationDays == null) {
    const { error } = await supabase
      .from("user_snoozes")
      .delete()
      .eq("user_id", userUuid)
      .eq("target_user_id", targetUuid);
    if (error) throw error;
    return null;
  }
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
  // Upsert so an existing snooze gets its expiry refreshed instead of
  // failing with a unique-violation. Web does the same.
  const { data, error } = await supabase
    .from("user_snoozes")
    .upsert({ user_id: userUuid, target_user_id: targetUuid, expires_at: expiresAt }, {
      onConflict: "user_id,target_user_id",
    })
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
};
