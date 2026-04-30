import { ID, Query } from "react-native-appwrite";
import secrets from "../private/secrets";
import { databases } from "./appwrite";
import { createTtlCache } from "./utils/createTtlCache";
import logger from "./utils/logger";

const getUserId = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.$id ?? null;
};

// Cache for FollowService.isFollowing. Each profile-row mount used to fire
// its own check; with this, a viewer scrolling a list of 30 creators only
// queries once per (viewer, target) pair.
//
// 1-minute TTL — short enough that a follow/unfollow elsewhere in the app
// surfaces fast even before invalidation reaches the cache; the explicit
// invalidation below handles same-session writes.
const FOLLOW_STATUS_CACHE = createTtlCache({ ttlMs: 60 * 1000, maxEntries: 1000 });
const followKey = (followerId, followingId) => `${followerId}::${followingId}`;

export class FollowService {
  static async followUser({ followerId, followingId }) {
    try {
      const res = await databases.createDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.followsCollectionId, ID.unique(), {
        followerId,
        followingId,
      });
      // Update the cache eagerly so the heart/Follow button flips state
      // without waiting for TTL expiry.
      FOLLOW_STATUS_CACHE.set(followKey(followerId, followingId), true);
      return res;
    } catch (error) {
      logger.error("FollowService", "followUser failed", error);
      throw error;
    }
  }

  static async unfollowUser({ followerId, followingId }) {
    try {
      const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.followsCollectionId, [
        Query.equal("followerId", followerId),
        Query.equal("followingId", followingId),
      ]);

      if (res.documents.length > 0) {
        await databases.deleteDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.followsCollectionId, res.documents[0].$id);
      }
      FOLLOW_STATUS_CACHE.set(followKey(followerId, followingId), false);
    } catch (error) {
      logger.error("FollowService", "unfollowUser failed", error);
      throw error;
    }
  }

  static async isFollowing({ followerId, followingId }) {
    if (!followerId || !followingId) return false;
    const key = followKey(followerId, followingId);
    const cached = FOLLOW_STATUS_CACHE.get(key);
    if (typeof cached === "boolean") return cached;

    try {
      const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.followsCollectionId, [
        Query.equal("followerId", followerId),
        Query.equal("followingId", followingId),
        Query.limit(1),
      ]);
      const isFollowing = res.total > 0;
      FOLLOW_STATUS_CACHE.set(key, isFollowing);
      return isFollowing;
    } catch (error) {
      logger.error("FollowService", "isFollowing failed", error);
      throw error;
    }
  }

  static async getFollowRelations({ currentUserId, otherUserIds, knownIFollowIds = [], knownTheyFollowIds = [] }) {
    try {
      const uniqueIds = [...new Set((otherUserIds || []).filter(Boolean))];

      if (!currentUserId || uniqueIds.length === 0) {
        return {};
      }

      const iFollowIds = new Set(knownIFollowIds);
      const theyFollowIds = new Set(knownTheyFollowIds);
      const iFollowLookupIds = uniqueIds.filter((id) => !iFollowIds.has(id));
      const theyFollowLookupIds = uniqueIds.filter((id) => !theyFollowIds.has(id));

      const [iFollowRes, theyFollowRes] = await Promise.all([
        iFollowLookupIds.length > 0
          ? databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.followsCollectionId, [
              Query.equal("followerId", currentUserId),
              Query.equal("followingId", iFollowLookupIds),
              Query.limit(iFollowLookupIds.length),
            ])
          : { documents: [] },
        theyFollowLookupIds.length > 0
          ? databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.followsCollectionId, [
              Query.equal("followerId", theyFollowLookupIds),
              Query.equal("followingId", currentUserId),
              Query.limit(theyFollowLookupIds.length),
            ])
          : { documents: [] },
      ]);

      for (const doc of iFollowRes.documents) {
        const followingId = getUserId(doc.followingId);
        if (followingId) iFollowIds.add(followingId);
      }

      for (const doc of theyFollowRes.documents) {
        const followerId = getUserId(doc.followerId);
        if (followerId) theyFollowIds.add(followerId);
      }

      return uniqueIds.reduce((acc, id) => {
        acc[id] = {
          iFollow: iFollowIds.has(id),
          theyFollow: theyFollowIds.has(id),
        };
        return acc;
      }, {});
    } catch (error) {
      console.error("Get follow relations error:", error);
      throw error;
    }
  }

  static async getFollowersCount({ userId }) {
    try {
      const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.followsCollectionId, [
        Query.equal("followingId", userId),
        Query.limit(1),
      ]);
      return res.total;
    } catch (error) {
      console.error("Get followers error:", error);
      throw error;
    }
  }

  static async getFollowingCount({ userId }) {
    try {
      const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.followsCollectionId, [
        Query.equal("followerId", userId),
        Query.limit(1),
      ]);
      return res.total;
    } catch (error) {
      console.error("Get following error:", error);
      throw error;
    }
  }

  static async getFollowers({ userId, limit, cursor }) {
    try {
      const queries = [Query.equal("followingId", userId)];

      // If limit is provided → use paginated mode
      if (limit) {
        queries.push(Query.limit(limit));
        if (cursor) {
          queries.push(Query.cursorAfter(cursor));
        }

        const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.followsCollectionId, queries);

        return {
          documents: res.documents,
          hasMore: res.documents.length === limit,
        };
      }

      // No limit provided → use original full fetch
      const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.followsCollectionId, queries);

      return res.documents;
    } catch (error) {
      console.error("Get followers error:", error);
      throw error;
    }
  }

  static async getFollowing({ userId, limit, cursor }) {
    try {
      const queries = [Query.equal("followerId", userId)];

      // ✅If limit is provided → use paginated mode
      if (limit) {
        queries.push(Query.limit(limit));
        if (cursor) {
          queries.push(Query.cursorAfter(cursor));
        }

        const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.followsCollectionId, queries);

        return {
          documents: res.documents,
          hasMore: res.documents.length === limit,
        };
      }

      //  No limit provided → use original full fetch
      const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.followsCollectionId, queries);

      return res.documents;
    } catch (error) {
      console.error("Get following error:", error);
      throw error;
    }
  }

  static async getMutualFollows({ userId }) {
    try {
      const following = await this.getFollowing(userId);
      const followers = await this.getFollowers(userId);

      const followingIds = new Set(following.map((f) => f.followingId));
      const mutuals = followers.filter((f) => followingIds.has(f.followerId));

      return mutuals;
    } catch (error) {
      console.error("Get mutual follows error:", error);
      throw error;
    }
  }
}
