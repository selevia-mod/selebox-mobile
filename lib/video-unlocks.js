import { ID, Query } from "react-native-appwrite";
import { appwriteConfig, databases } from "./appwrite";

const UNLOCK_VIDEO_API = "https://694261e70015341e2427.fra.appwrite.run";

export class VideoUnlocksService {
  /**
   * ---------------------------------------------------------
   * Unlock video (SERVER-AUTHORITATIVE)
   * ---------------------------------------------------------
   * All billing logic lives in the Appwrite Function.
   * Client only receives the result.
   */
  async unlockVideo({ videoId, userId, contentOwnerId }) {
    try {
      const response = await fetch(UNLOCK_VIDEO_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          videoId,
          userId,
          contentOwnerId: contentOwnerId?.$id || contentOwnerId,
        }),
      });

      // 🔴 Network / server-level failure
      if (!response.ok) {
        throw new Error(`Unlock request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.log("unlock response", data);

      // 🟡 App-level failure (handled by backend logic)
      if (!data?.success) {
        return {
          success: false,
          requirePurchase: data?.requirePurchase ?? false,
          message: data?.message || "Unlock failed",
        };
      }

      // 🟢 Success
      return {
        success: true,
        unlockId: data.unlockId,
        used: data.used, // "stars" | "coins"
        cost: data.cost,
      };
    } catch (error) {
      console.error("❌ Video unlock function error:", error?.message || error);

      return {
        success: false,
        message: "Network or server error",
      };
    }
  }

  /**
   * ---------------------------------------------------------
   * Check if user already unlocked the video
   * (Optional fast-path to avoid re-unlocking)
   * ---------------------------------------------------------
   */
  async getUserUnlockedVideo({ videoId, userId }) {
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.unlockedVideosCollectionId, [
      Query.equal("video", videoId),
      Query.equal("unlockBy", userId),
    ]);
  }

  /**
   * ---------------------------------------------------------
   * Manual/local unlock (DEV / ADMIN / FREE CONTENT)
   * ---------------------------------------------------------
   * ⚠️ Should NOT be used for monetized content
   */
  async saveLocalUnlock({ videoId, userId }) {
    return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.unlockedVideosCollectionId, ID.unique(), {
      video: videoId,
      unlockBy: userId,
      unlockedAt: new Date().toISOString(),
    });
  }

  /**
   * ---------------------------------------------------------
   * Helper: Determine lock state
   * ---------------------------------------------------------
   */
  static isVideoLocked({ unlocks }) {
    return !unlocks || unlocks.total === 0;
  }
}
