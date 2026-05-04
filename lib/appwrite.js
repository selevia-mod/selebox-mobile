import AsyncStorage from "@react-native-async-storage/async-storage";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import { Account, Avatars, Client, Databases, ID, Query, Storage } from "react-native-appwrite";
import { PROFILE_BANNER_UPLOAD_WIDTH } from "../constants/profile";
import secrets from "../private/secrets";
import { invalidateUserCache } from "./caches/user-cache";
import { appendRoleKey, getAssignedRoleKeys, SELECTABLE_ROLE_KEYS } from "./user-roles";
import { StarService } from "./stars";
// Stream Chat removed in Phase D — chat is fully Supabase-native now (see
// lib/messages-supabase.js + components/Supabase{ConversationsList,Thread,
// NewChat}.jsx). The previous Stream client + StreamService import has
// been deleted along with the lib/stream.js file.

export const appwriteConfig = secrets.appwriteConfig;

const isActiveSessionError = (error) => {
  const message = (error?.message || "").toLowerCase();
  return message.includes("session is prohibited when a session is active");
};

// Detects errors that mean the Appwrite session is gone or invalid — i.e.,
// the user needs to be logged out and redirected to /sign-in. We watch both
// the HTTP code and Appwrite's typed error codes (e.g. user_unauthorized,
// user_session_not_found, general_unauthorized_scope) since the SDK reports
// auth failures inconsistently across endpoints.
//
// Used by the global error handler in app/_layout.jsx to bridge the gap
// between bootstrap auth handling (which works) and mid-session expiration
// (which previously left the user stuck on a broken screen).
export const isAppwriteAuthError = (error) => {
  if (!error) return false;
  const code = error?.code || error?.response?.code;
  if (code === 401) return true;

  const type = (error?.type || error?.response?.type || "").toLowerCase();
  if (type === "user_unauthorized" || type === "user_session_not_found" || type === "user_jwt_invalid" || type === "general_unauthorized_scope") {
    return true;
  }

  const message = (error?.message || "").toLowerCase();
  return message.includes("user (role: guests) missing scope") || message.includes("session not found") || message.includes("user is not authorized");
};

export const client = new Client().setEndpoint(appwriteConfig.endpoint).setProject(appwriteConfig.projectId).setPlatform(appwriteConfig.platform);
export const account = new Account(client);
export const storage = new Storage(client);
export const avatars = new Avatars(client);
export const databases = new Databases(client);

const normalizeStoredUrl = (value) => {
  if (typeof value === "string") return value;
  const normalized = value?.toString?.();
  return typeof normalized === "string" ? normalized : undefined;
};

const mergeUserWithProfileDocument = (userDoc, profileDoc) => {
  if (!userDoc) return userDoc;

  const mergedBio = typeof profileDoc?.bio === "string" ? profileDoc.bio : typeof userDoc?.bio === "string" ? userDoc.bio : "";
  const mergedBanner = normalizeStoredUrl(profileDoc?.banner) ?? normalizeStoredUrl(userDoc?.banner);

  return {
    ...userDoc,
    bio: mergedBio,
    banner: mergedBanner,
    userProfileDocumentId: profileDoc?.$id ?? null,
  };
};

export const getUserProfileDocument = async (userId) => {
  if (!userId) return null;

  const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.usersProfilesCollectionId, [
    Query.equal("userId", userId),
    Query.limit(1),
  ]);

  return response?.documents?.[0] ?? null;
};

export const hydrateUserWithProfile = async (userDoc) => {
  if (!userDoc?.$id) return userDoc;

  try {
    const profileDoc = await getUserProfileDocument(userDoc.$id);
    return mergeUserWithProfileDocument(userDoc, profileDoc);
  } catch (error) {
    console.warn("hydrateUserWithProfile failed:", error?.message || error);
    return mergeUserWithProfileDocument(userDoc, null);
  }
};

const upsertUserProfileDocument = async ({ userId, bio, banner }) => {
  if (!userId) {
    throw new Error("Missing userId for user profile document.");
  }

  const existingProfile = await getUserProfileDocument(userId);
  const payload = {};

  if (typeof bio !== "undefined") payload.bio = bio;
  if (typeof banner !== "undefined") payload.banner = normalizeStoredUrl(banner);

  if (existingProfile?.$id) {
    return databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.usersProfilesCollectionId, existingProfile.$id, payload);
  }

  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.usersProfilesCollectionId, ID.unique(), {
    userId,
    bio: typeof bio === "undefined" ? "" : bio,
    ...payload,
  });
};

export async function createUser(email, password, username, avatar = null) {
  try {
    // 1️⃣ Create account
    const newAccount = await account.create(ID.unique(), email, password, username);

    // 2️⃣ Immediately sign in to ensure we have a session for DB write
    try {
      await account.createEmailPasswordSession(email, password);
    } catch (sessionError) {
      if (!isActiveSessionError(sessionError)) throw sessionError;
      console.log("Session already active after account creation, continuing");
    }

    // 3️⃣ Prepare avatar
    const avatarUrl = avatar ?? avatars.getInitials(username).toString();

    // 4️⃣ Create user document in DB
    const newUser = await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.userCollectionId, ID.unique(), {
      accountId: newAccount.$id,
      email,
      username,
      avatar: avatarUrl,
    });

    // 5️⃣ Mirror to Supabase profiles immediately. Without this, the
    //    user has no profiles row keyed on legacy_appwrite_id, which
    //    means every dual-write helper (books, comments, likes, etc.)
    //    silently skips because resolveProfileToUuid returns null. After
    //    USE_SUPABASE_BOOKS flips to true, that gap also makes the
    //    user's own books invisible on mobile (since mobile reads from
    //    Supabase). Best-effort — never blocks the signup.
    //
    //    Routed through `upsert_profile_mirror` RPC for the same reason
    //    the global-provider self-heal does: mobile uses the anon key on
    //    Supabase (USE_SUPABASE_AUTH=false), so a direct .upsert() trips
    //    RLS WITH CHECK. The RPC is security definer + insert-if-missing.
    //    For a fresh signup, `legacy_appwrite_id` is brand-new, so the
    //    insert path always runs (`created: true`).
    try {
      const sb = (await import("./supabase")).default;
      const { error: profErr } = await sb.rpc("upsert_profile_mirror", {
        p_legacy_appwrite_id: newUser.$id,
        p_username: username,
        p_email: email,
        p_avatar_url: avatarUrl,
      });
      if (profErr) {
        console.error("[createUser] Supabase profile mirror failed:", profErr.message);
      }
    } catch (mirrorErr) {
      console.error("[createUser] Supabase profile mirror threw:", mirrorErr?.message);
    }

    return newUser;
  } catch (error) {
    console.error("createUser: error", error);

    // Rollback: delete the orphaned account if DB user creation failed
    try {
      const current = await account.get();
      if (current) {
        await account.delete();
      }
    } catch (rollbackErr) {
      console.log("Rollback failed:", rollbackErr.message);
    }

    throw error;
  }
}

export async function updateUserExpoPushToken(userId, expoPushToken) {
  try {
    const response = await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.userCollectionId, userId, {
      expoPushToken: expoPushToken,
    });
    return response;
  } catch (error) {
    throw error;
  }
}

export const signIn = async (email, password) => {
  // Clear any stale session to avoid "existing session" errors on re-login
  try {
    await account.deleteSession("current");
  } catch (error) {
    // ignore if there was no session
  }

  try {
    await account.createEmailPasswordSession(email, password);
  } catch (error) {
    // If a session is already active, use it instead of failing
    if (isActiveSessionError(error)) {
      console.log("Session already active, using existing session");
    } else {
      throw error;
    }
  }

  // Get user without Stream Chat (faster sign-in)
  // Stream Chat connection will be handled by global-provider.js
  const userDoc = await getCurrentUserWithoutStream();

  return userDoc;
};

export const signOut = async () => {
  // Stream Chat disconnect step removed (Phase D). Stream tokens may still
  // exist in AsyncStorage from before the migration; clear them once on
  // sign-out so the next user doesn't inherit the keys. Safe no-op if the
  // keys were already pruned.
  try {
    await AsyncStorage.removeItem("streamToken");
    await AsyncStorage.removeItem("streamUserId");
  } catch (error) {
    console.warn("Failed to clear legacy Stream tokens:", error.message);
  }

  // Delete Appwrite session
  await account.deleteSession("current");

  // Google sign out
  try {
    await GoogleSignin.signOut();
  } catch (error) {
    console.error(error.message);
  }
};

export const getCurrentUserWithoutStream = async () => {
  try {
    // 1️⃣ Get Appwrite account
    const userAccount = await account.get();

    // 2️⃣ Check if user doc exists
    let userDocs = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.userCollectionId, [
      Query.equal("accountId", userAccount.$id),
    ]);

    // 3️⃣ If missing, self-heal by creating a fallback user doc
    let userDoc;
    if (userDocs.total === 0) {
      userDoc = await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.userCollectionId, ID.unique(), {
        accountId: userAccount.$id,
        email: userAccount.email,
        username: userAccount.name ?? "Unknown",
        avatar: avatars.getInitials(userAccount.name ?? "U").toString(),
      });
    } else {
      userDoc = userDocs.documents[0];
    }

    return hydrateUserWithProfile(userDoc);
  } catch (error) {
    throw error;
  }
};

export const getCurrentUser = async () => {
  // Phase D — Stream Chat connection removed. This used to fetch a Stream
  // token via Appwrite's JWT and connectUser the chat client. With chat
  // now Supabase-native, those steps are gone. The function name is kept
  // so existing call sites don't have to change; it now simply mirrors
  // getCurrentUserWithoutStream.
  return getCurrentUserWithoutStream();
};

export const createRecoveryEmail = async (email) => {
  await account.createRecovery(email, secrets.WEBSITE);
};

export const updateRecoveryUser = async (userId, secret, newPassword, confirmPassword) => {
  await account.updateRecovery(userId, secret, newPassword, confirmPassword);
};

export async function SearchVideos(query = "", videos = []) {
  const normalizedQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
  const safeVideos = Array.isArray(videos) ? videos : [];

  if (!normalizedQuery) return safeVideos;

  const includesQuery = (value) => typeof value === "string" && value.toLowerCase().includes(normalizedQuery);

  try {
    return safeVideos.filter((video) => {
      const uploaderName = typeof video?.uploader === "string" ? video.uploader : video?.uploader?.username || video?.uploader?.name;
      const tagsMatch = Array.isArray(video?.tags) && video.tags.some((name) => includesQuery(name));

      return (
        includesQuery(video?.title) || includesQuery(video?.description) || includesQuery(uploaderName) || tagsMatch || includesQuery(video?.uri)
      );
    });
  } catch (error) {
    console.error("SearchVideos error", error?.message || error);
    return [];
  }
}

export async function updateUsername(documentId, newUsername) {
  try {
    const response = await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.userCollectionId, documentId, {
      username: newUsername,
    });
    invalidateUserCache(documentId);
    return response;
  } catch (error) {
    throw error;
  }
}

export async function updateSelectedRole(user, roleKey, badgeExpiration) {
  const documentId = user?.$id;

  if (!documentId) {
    throw new Error("Missing user document ID.");
  }

  if (![SELECTABLE_ROLE_KEYS.creator, SELECTABLE_ROLE_KEYS.writer].includes(roleKey)) {
    throw new Error("Invalid role selection.");
  }

  if (!badgeExpiration) {
    throw new Error("Missing badge expiration.");
  }

  try {
    const nextRoles = appendRoleKey(getAssignedRoleKeys(user), roleKey);
    const response = await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.userCollectionId, documentId, {
      roles: nextRoles,
      badgeExpiration,
    });
    invalidateUserCache(documentId);
    return response;
  } catch (error) {
    const message = error?.message || "";
    if (message.includes("Unknown attribute") && (message.includes("roles") || message.includes("badgeExpiration"))) {
      throw new Error(
        `Appwrite does not recognize the required role fields on collection ${appwriteConfig.userCollectionId}. Make sure "roles" and "badgeExpiration" exist there and their status is available.`,
      );
    }
    throw error;
  }
}

export async function updateBio(documentId, bio) {
  try {
    const response = await upsertUserProfileDocument({
      userId: documentId,
      bio,
    });
    invalidateUserCache(documentId);
    return response;
  } catch (error) {
    const message = error?.message || "";
    if (message.includes("Unknown attribute") && message.includes("bio")) {
      throw new Error(
        `Appwrite does not recognize the "bio" attribute on collection ${appwriteConfig.usersProfilesCollectionId}. Make sure it exists there and its status is available.`,
      );
    }
    throw error;
  }
}

const extractStoredFileId = (fileUrl) => {
  const normalizedUrl = typeof fileUrl === "string" ? fileUrl : fileUrl?.toString?.();
  if (typeof normalizedUrl !== "string") return null;
  const match = normalizedUrl.match(/files\/([^/]+)/);
  return match?.[1] || null;
};

const deleteStoredFile = async ({ storageId, fileUrl }) => {
  try {
    const fileId = extractStoredFileId(fileUrl);
    if (!fileId) return;
    await storage.deleteFile(storageId, fileId);
  } catch (error) {}
};

export async function uploadFileToStorage(file, { storageId = appwriteConfig.storageId, maxWidth = 1200 } = {}) {
  const { convertToWebP, cleanupTempFile } = require("./utils/image-utils");
  const webp = await convertToWebP(file.uri, {
    maxWidth,
    sourceWidth: file?.width,
    sourceHeight: file?.height,
  });
  try {
    const asset = {
      name: (file.fileName || file.uri.split("/").pop()).replace(/\.\w+$/, ".webp"),
      size: webp.fileSize,
      type: "image/webp",
      uri: webp.uri,
    };
    const uploadedFile = await storage.createFile(storageId, ID.unique(), asset);
    const fileUrl = storage.getFilePreview(storageId, uploadedFile.$id).toString();
    return fileUrl;
  } catch (error) {
    throw error;
  } finally {
    cleanupTempFile(webp.uri, file.uri);
  }
}

export async function updateAvatar({ file, userId, previousAvatar }) {
  try {
    await deleteStoredFile({ storageId: appwriteConfig.storageId, fileUrl: previousAvatar });
    const avatarUrl = await uploadFileToStorage(file, { storageId: appwriteConfig.storageId, maxWidth: 500 });
    const updatedAvatar = await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.userCollectionId, userId, {
      avatar: avatarUrl,
    });
    invalidateUserCache(userId);
    return updatedAvatar;
  } catch (error) {
    throw error;
  }
}

export async function updateBanner({ file, userId, previousBanner }) {
  try {
    await deleteStoredFile({ storageId: appwriteConfig.bannerStorageId, fileUrl: previousBanner });
    const bannerUrl = await uploadFileToStorage(file, {
      storageId: appwriteConfig.bannerStorageId,
      maxWidth: Math.max(PROFILE_BANNER_UPLOAD_WIDTH, file?.width || 0),
    });
    const updatedBanner = await upsertUserProfileDocument({
      userId,
      banner: bannerUrl,
    });
    invalidateUserCache(userId);
    return updatedBanner;
  } catch (error) {
    const message = error?.message || "";
    if (message.includes("Unknown attribute") && message.includes("banner")) {
      throw new Error(
        `Appwrite does not recognize the "banner" attribute on collection ${appwriteConfig.usersProfilesCollectionId}. Make sure it exists there and its status is available.`,
      );
    }
    throw error;
  }
}

export const addToPlaylist = async (videoId, userId) => {
  try {
    const playlist = await getPlaylistForUser(userId);
    if (!playlist) {
      const newPlaylist = await createNewPlaylist(userId);
      return updatePlaylist(videoId, newPlaylist.$id);
    }
    return updatePlaylist(videoId, playlist.$id);
  } catch (error) {
    throw error;
  }
};

export const createNewPlaylist = async (userId) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.playlistCollectionId, ID.unique(), {
    playlistOwner: userId,
    videoIds: [],
  });
};

export const updatePlaylist = async (videoId, playlistId) => {
  try {
    let videoIds = await getVideoIdsFromPlaylist(playlistId);

    if (videoIds.includes(videoId)) {
      videoIds = videoIds.filter((id) => id !== videoId);
    } else {
      videoIds = [videoId, ...videoIds];
    }

    await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.playlistCollectionId, playlistId, { videoIds });

    return videoIds;
  } catch (error) {
    throw error;
  }
};

export const getVideoIdsFromPlaylist = async (playlistId) => {
  const playlist = await databases.getDocument(appwriteConfig.databaseId, appwriteConfig.playlistCollectionId, playlistId);
  return playlist.videoIds || [];
};

export const getPlaylistForUser = async (userId) => {
  try {
    const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.playlistCollectionId, [
      Query.equal("playlistOwner", userId),
    ]);
    return response.documents[0];
  } catch (error) {
    return null;
  }
};

export const isVideoInPlaylist = async (userId, videoId) => {
  try {
    const playlist = await getPlaylistForUser(userId);
    if (!playlist) return false;
    const videoIds = await getVideoIdsFromPlaylist(playlist.$id);
    return videoIds.includes(videoId);
  } catch (error) {
    return false;
  }
};

export const getPlaylist = async (userId) => {
  try {
    const playlist = await getPlaylistForUser(userId);
    const videoIds = playlist?.videoIds || [];

    return videoIds;
  } catch (error) {
    throw error;
  }
};

export async function getCoinDeductionByTags(tags) {
  try {
    const genreTag = tags?.[tags.length - 1] || "others";

    let response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.coinDeductionCollectionId, [
      Query.equal("genre", genreTag.toLowerCase()),
    ]);

    if (response.total === 0) {
      response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.coinDeductionCollectionId, [Query.equal("genre", "others")]);

      if (response.total === 0) {
        throw new Error(`No coin deduction found for default genre 'others'.`);
      }
    }

    const coinDeduction = response.documents[0].coinDeduction;

    return {
      genre: genreTag,
      coinDeduction: coinDeduction,
    };
  } catch (error) {
    throw new Error("Failed to fetch coin deduction from tags.");
  }
}

export async function FetchVideos(setAllVideos) {
  try {
    // const snapshot = await get(ref(database, "VIDEOS"));
    // const videos = Object.values(snapshot.val());
    // videos.sort((a, b) => new Date(b.created_time) - new Date(a.created_time));
    // setAllVideos(videos);
    // const metrics = await FetchBatchVideoMetrics(videos.map((video) => video.uri.replace("/videos/", "")));
    // const metricsMap = new Map(metrics.map((metric) => [metric.videoID, metric]));
    // const videoWMetrics = videos.map((video) => {
    //   const metric = metricsMap.get(video.uri.replace("/videos/", ""));
    //   return {
    //     ...video,
    //     totalViews: metric?.totalViews || 0,
    //     dailyViews: metric?.dailyViews ? JSON.parse(metric.dailyViews) : {},
    //     videoLikes: metric?.videoLikes || 0,
    //     id: metric?.$id,
    //   };
    // });
    // setAllVideos(videoWMetrics);
    // const users = await FetchBatchUIDS([...new Set(videos.map((video) => video.uploader))]);
    // const usersMap = new Map(users.map((user) => [user.$id, user]));
    // const videoWMetricsWUploader = videoWMetrics.map((video) => {
    //   const uploader = usersMap.get(video.uploader);
    //   return {
    //     ...video,
    //     uploader: {
    //       uid: video.uploader,
    //       name: uploader?.username || "Unknown Uploader",
    //       avatar: uploader?.avatar || null,
    //     },
    //   };
    // });
    // setAllVideos(videoWMetricsWUploader);
    // // const likes = await FetchBatchLikes(videoWMetricsWUploader.map((video) => video.uri.replace("/videos/", "")));
    // // const likesMap = new Map(likes.map((like) => [like.videoID, like]));
    // // const videoWMetricsWUploaderWLikes = videoWMetricsWUploader.map((video) => {
    // //   // const like = likesMap.get(video.uri.replace("/videos/", ""));
    // //   return {
    // //     ...video,
    // //   };
    // // });
    // // setAllVideos(videoWMetricsWUploaderWLikes);
  } catch (error) {
    throw error;
  }
}

async function FetchBatchUIDS(uids) {
  const BATCH_SIZE = 50;
  const uidsBatches = [];
  for (let i = 0; i < uids.length; i += BATCH_SIZE) {
    uidsBatches.push(uids.slice(i, i + BATCH_SIZE));
  }
  const batchPromises = uidsBatches.map(async (batch) => {
    const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.userCollectionId, [
      Query.equal("$id", batch),
      Query.limit(batch.length),
    ]);
    return response.documents;
  });
  const results = await Promise.all(batchPromises);
  return results.flat();
}

async function FetchBatchLikes(videoIds) {
  // const BATCH_SIZE = 50;
  // const videoIdBatches = [];
  // for (let i = 0; i < videoIds.length; i += BATCH_SIZE) {
  //   videoIdBatches.push(videoIds.slice(i, i + BATCH_SIZE));
  // }
  // const batchPromises = videoIdBatches.map(async (batch) => {
  //   const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.videoLikesCollectionId, [
  //     Query.equal("videoID", batch),
  //     Query.limit(batch.length),
  //   ]);
  //   return response.documents;
  // });
  // const results = await Promise.all(batchPromises);
  // return results.flat();
}

async function FetchBatchVideoMetrics(videoIds) {
  const BATCH_SIZE = 50;
  const videoIdBatches = [];
  for (let i = 0; i < videoIds.length; i += BATCH_SIZE) {
    videoIdBatches.push(videoIds.slice(i, i + BATCH_SIZE));
  }
  const batchPromises = videoIdBatches.map(async (batch) => {
    const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.videoMetricsCollectionId, [
      Query.equal("videoID", batch),
      Query.limit(batch.length),
    ]);
    return response.documents;
  });
  const results = await Promise.all(batchPromises);
  return results.flat();
}

export async function IncrementViews(video) {
  const videoId = video.uri.replace("/videos/", "");
  const today = new Date().toISOString().split("T")[0];
  try {
    const resp = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.videoMetricsCollectionId, [Query.equal("videoID", videoId)]);
    const response = resp.documents[0];
    await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.videoMetricsCollectionId, response.$id, {
      totalViews: response.totalViews + 1,
      dailyViews: JSON.stringify({
        ...JSON.parse(response.dailyViews),
        [today]: (JSON.parse(response.dailyViews)[today] || 0) + 1,
      }),
    });
  } catch (updateError) {
    console.error(updateError);
    // try {
    //   await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.videoMetricsCollectionId, ID.unique(), {
    //     videoID: videoId,
    //     totalViews: 1,
    //     dailyViews: JSON.stringify({ [today]: 1 }),
    //   });
    // } catch (createError) {
    //   // console.error(createError);
    // }
  }
}

export function CalculateWeeklyViews(dailyViews) {
  try {
    const today = new Date();
    let weeklyViews = 0;
    for (let i = 0; i < 7; i++) {
      const pastDate = new Date(today);
      pastDate.setDate(today.getDate() - i);
      const formattedDate = pastDate.toISOString().split("T")[0];
      if (dailyViews[formattedDate]) {
        weeklyViews += dailyViews[formattedDate];
      }
    }
    return weeklyViews;
  } catch (e) {
    return 0;
  }
}

export function ShuffleVideos(array) {
  const cloneArray = [...array];
  for (let i = cloneArray.length - 1; i > 0; i--) {
    const randomIndex = Math.floor(Math.random() * (i + 1));
    [cloneArray[i], cloneArray[randomIndex]] = [cloneArray[randomIndex], cloneArray[i]];
  }
  return cloneArray;
}

export function limitVideos(videos, limit = -1) {
  if (limit === -1) {
    return [...videos];
  }
  return videos.slice(0, limit);
}

export function sortByViews(videos, limit = -1) {
  const sortedVideos = [...videos].sort((a, b) => b.totalViews - a.totalViews);
  return limitVideos(sortedVideos, limit);
}

export function sortByWeeklyViews(videos, limit = -1) {
  const sortedVideos = [...videos].sort((a, b) => CalculateWeeklyViews(b.dailyViews) - CalculateWeeklyViews(a.dailyViews));
  return limitVideos(sortedVideos, limit);
}

export function filterVideosByGenre(videos, genre, limit = -1) {
  const filteredVideos = videos.filter((video) => video.tags && video.tags.some((name) => name.toLowerCase() === genre.toLowerCase()));
  return limitVideos(filteredVideos, limit);
}

export function filterVideosByOwner(videos, ownerId, limit = -1) {
  const filteredVideos = videos.filter((video) => video.uploader && video.uploader?.uid === ownerId);
  return limitVideos(filteredVideos, limit);
}

export function filterVideosByVideoIds(videos, videoIds, limit = -1) {
  const filteredVideos = [];
  for (const videoId of videoIds) {
    for (const video of videos) {
      if (video.uri === videoId) {
        filteredVideos.push(video);
      }
    }
  }
  return limitVideos(filteredVideos, limit);
}

export const addToHistory = async (videoId, userId) => {
  try {
    const history = await getHistoryForUser(userId);
    if (!history) {
      const newHistory = await createNewHistory(userId);
      return updateHistory(videoId, newHistory.$id);
    }
    return updateHistory(videoId, history.$id);
  } catch (error) {
    throw error;
  }
};

export const createNewHistory = async (userId) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.historyCollectionId, ID.unique(), {
    historyOwner: userId,
    videoIds: [],
  });
};

export const updateHistory = async (videoId, historyId) => {
  try {
    let videoIds = await getVideoIdsFromHistory(historyId);
    videoIds = videoIds.filter((id) => id !== videoId);
    videoIds = [videoId, ...videoIds];
    await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.historyCollectionId, historyId, { videoIds });

    return videoIds;
  } catch (error) {
    throw error;
  }
};

export const getVideoIdsFromHistory = async (historyId) => {
  const history = await databases.getDocument(appwriteConfig.databaseId, appwriteConfig.historyCollectionId, historyId);
  return history.videoIds || [];
};

export const getHistoryForUser = async (userId) => {
  try {
    const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.historyCollectionId, [
      Query.equal("historyOwner", userId),
    ]);
    return response.documents[0];
  } catch (error) {
    return null;
  }
};

export const getHistory = async (userId) => {
  try {
    const history = await getHistoryForUser(userId);
    const videoIds = history?.videoIds || [];
    return videoIds;
  } catch (error) {
    throw error;
  }
};

export const getCoinPacks = async () => {
  try {
    const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.coinPacksCollectionId);
    return response.documents;
  } catch (error) {
    throw error;
  }
};

export const getUserCoins = async (userId) => {
  try {
    let response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.coinsCollectionId, [Query.equal("coinOwner", userId)]);
    let users_response = await databases.getDocument(appwriteConfig.databaseId, appwriteConfig.userCollectionId, userId);
    if (response.documents.length === 0) {
      response = await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.coinsCollectionId, ID.unique(), {
        coinOwner: userId,
        email: users_response.email,
      });
    } else {
      response = response.documents[0];
    }
    return response;
  } catch (error) {
    throw error;
  }
};

export const updateUserCoins = async (userId, amount = 0) => {
  try {
    let response = await getUserCoins(userId);
    let users_response = await databases.getDocument(appwriteConfig.databaseId, appwriteConfig.userCollectionId, userId);
    response = await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.coinsCollectionId, response.$id, {
      coins: amount,
      email: users_response.email,
    });
    return response;
  } catch (error) {
    throw error;
  }
};

export const getGlobalSettings = async () => {
  try {
    const response = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.globalSettingsCollectionId, [Query.limit(100)]);
    return response.documents;
  } catch (error) {
    throw error;
  }
};

export const getStars = async () => {
  try {
    const data = await StarService.getStars();
    return data;
  } catch (err) {
    throw err;
  }
};
