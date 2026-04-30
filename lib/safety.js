import { ID, Query } from "react-native-appwrite";
import { appwriteConfig, databases } from "./appwrite";

const missingConfig = (key) => {
  console.warn(`[safety] Missing Appwrite config for ${key}. Please set it in secrets before enabling this feature.`);
  return null;
};

export const reportContent = async ({ contentId, contentType, reporterId, ownerId, reason, notes }) => {
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
