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

export const blockUser = async ({ blockerId, blockedUserId, contentId, contentType, reason }) => {
  if (!appwriteConfig.userBlocksCollectionId) return missingConfig("userBlocksCollectionId");

  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.userBlocksCollectionId, ID.unique(), {
    blockerId,
    blockedUserId,
    contentId,
    contentType,
    reason,
  });
};

export const unblockUser = async ({ blockerId, blockedUserId }) => {
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

export const hideContent = async ({ userId, contentId, contentType }) => {
  if (!appwriteConfig.userHiddenContentCollectionId) return missingConfig("userHiddenContentCollectionId");

  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.userHiddenContentCollectionId, ID.unique(), {
    userId,
    contentId,
    contentType,
  });
};

export const listHiddenContent = async ({ userId }) => {
  if (!appwriteConfig.userHiddenContentCollectionId) return [];

  const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.userHiddenContentCollectionId, [Query.equal("userId", userId)]);
  return res.documents.map((doc) => doc.contentId);
};
