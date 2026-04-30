import { ID, Query } from "react-native-appwrite";
import { appwriteConfig, databases } from "./appwrite";

const UNLOCK_VIDEO_API = "https://694261e70015341e2427.fra.appwrite.run";

export class VideoUnlocksService {
  /**
   * ---------------------------------------------------------
   * Unlock video (SERVER-AUTHORITATIVE)
   * ---------------------------------------------------------
   * All billing logic lives in the Appwrite Function. The client now passes
   * the user's chosen currency and the threshold being paid for so the server
   * can match the web's `unlock_video_threshold` semantics:
   *   - currency: "coin" | "star" — coin = permanent, star = 10-min window
   *   - threshold: seconds in the video this payment unlocks past
   *
   * Until the server function is updated to honor these params, they're a
   * no-op on the wire and the server falls back to its existing currency-
   * picking logic. Including them in the body now lets the client UX go live
   * before the backend lands.
   */
  async unlockVideo({ videoId, userId, contentOwnerId, currency, threshold }) {
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
          // New params — server should treat these as authoritative once
          // updated; legacy server ignores them harmlessly.
          ...(currency ? { currency } : {}),
          ...(Number.isFinite(threshold) ? { threshold } : {}),
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
        // Mirror the web's `mode` field when present — "permanent" for coin
        // path, "window" for star path. Falls back to inferring from `used`.
        mode: data.mode || (data.used === "coins" ? "permanent" : data.used === "stars" ? "window" : null),
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
   * Pay-as-you-go progress (per user/video)
   * ---------------------------------------------------------
   * Mirrors the web's `video_progress.paid_through_seconds` column. Tracks
   * how far into a video the user has paid for under the star (window) model
   * so re-watching below that mark is free and the next threshold compute
   * starts from the right place after sign-in / reinstall.
   *
   * The collection is referenced via `appwriteConfig.videoProgressCollectionId`.
   * If that key isn't set yet (collection not provisioned in Appwrite), these
   * methods short-circuit safely so the rest of the unlock flow keeps working
   * — paid_through is just treated as 0 (every threshold is fresh) until the
   * backend lands.
   *
   * Schema (when provisioned):
   *   - userId:   string  (indexed)
   *   - videoId:  string  (indexed)
   *   - paidThroughSeconds: integer
   *   - updatedAt: ISO string
   *   - composite unique index on (userId, videoId) so upserts have a
   *     deterministic target.
   */
  async getPaidThroughSeconds({ videoId, userId }) {
    const collectionId = appwriteConfig.videoProgressCollectionId;
    if (!collectionId || !videoId || !userId) return 0;
    try {
      const res = await databases.listDocuments(appwriteConfig.databaseId, collectionId, [
        Query.equal("userId", userId),
        Query.equal("videoId", videoId),
        Query.limit(1),
      ]);
      const doc = res.documents?.[0];
      const value = Number(doc?.paidThroughSeconds);
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (error) {
      // Missing collection / permissions / network — treat as zero so the
      // unlock UX still works rather than crashing the player.
      console.log("getPaidThroughSeconds (defensive fallback):", error?.message || error);
      return 0;
    }
  }

  async setPaidThroughSeconds({ videoId, userId, seconds }) {
    const collectionId = appwriteConfig.videoProgressCollectionId;
    if (!collectionId || !videoId || !userId) return null;
    const payload = {
      userId,
      videoId,
      paidThroughSeconds: Math.max(0, Math.floor(Number(seconds) || 0)),
      updatedAt: new Date().toISOString(),
    };
    try {
      // Try to find an existing row first (Appwrite has no native upsert).
      const existing = await databases.listDocuments(appwriteConfig.databaseId, collectionId, [
        Query.equal("userId", userId),
        Query.equal("videoId", videoId),
        Query.limit(1),
      ]);
      const existingDoc = existing.documents?.[0];
      if (existingDoc?.$id) {
        return databases.updateDocument(appwriteConfig.databaseId, collectionId, existingDoc.$id, payload);
      }
      return databases.createDocument(appwriteConfig.databaseId, collectionId, ID.unique(), payload);
    } catch (error) {
      console.log("setPaidThroughSeconds (defensive fallback):", error?.message || error);
      return null;
    }
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

/**
 * ---------------------------------------------------------
 * Threshold math (mirrors the web's `computeNext` in setupVideoMonetGate)
 * ---------------------------------------------------------
 * Given the user's `paidThroughSeconds` for this video, returns the next
 * paywall mark in seconds.
 *   - First mark is `initialSec` (default 180 = 3 min).
 *   - Subsequent marks land every `recurringSec` (default 600 = 10 min).
 * If paid is exactly past a recurring mark, the NEXT mark is returned (so
 * the user isn't billed for the same threshold twice on resume).
 */
export const computeNextThresholdSeconds = (paidThroughSeconds, { initialSec = 180, recurringSec = 600 } = {}) => {
  const paid = Math.max(0, Math.floor(Number(paidThroughSeconds) || 0));
  if (paid < initialSec) return initialSec;
  return initialSec + Math.ceil((paid - initialSec + 1) / recurringSec) * recurringSec;
};
