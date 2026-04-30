import { Query } from "react-native-appwrite";
import { appwriteConfig, databases, hydrateUserWithProfile } from "./appwrite";
import { invalidateUserCache, setUserCache, USER_CACHE } from "./caches/user-cache";
import { SELECTABLE_ROLE_KEYS } from "./user-roles";
import logger from "./utils/logger";

// Re-export so existing call-sites that import from lib/users keep working.
export { invalidateUserCache };

// getUserByID — same user gets fetched from many surfaces in a session
// (chat list rows, message bubbles, mention autocomplete, notifications
// hydration loop). The cache eliminates the redundant getDocument calls.
// 2-minute TTL handles staleness for ambient reads; profile update writes
// (updateAvatar, updateBanner, updateBio) call invalidateUserCache so the
// next read sees fresh data.
export const getUserByID = async ({ ID }) => {
  if (!ID) {
    throw new Error("getUserByID requires an ID");
  }

  const cached = USER_CACHE.get(ID);
  if (cached) return cached;

  try {
    const userDocument = await databases.getDocument(appwriteConfig.databaseId, appwriteConfig.userCollectionId, ID);
    const hydrated = await hydrateUserWithProfile(userDocument);
    setUserCache(ID, hydrated);
    return hydrated;
  } catch (error) {
    // Don't poison the cache on failure — let the next caller retry.
    logger.warn("users/getUserByID", `failed to fetch ${ID}`, error);
    throw error;
  }
};

export const fetchUsersByQuery = async (queries) => {
  try {
    const users = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.userCollectionId, queries);
    return users;
  } catch (error) {
    console.log("fetchUsersByQuery: error", error);
  }
};

export const searchUsers = async (searchQuery) => {
  try {
    const userResults = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.userCollectionId, [
      Query.contains("username", searchQuery),
      Query.limit(100),
    ]);

    return userResults.documents.map((user) => user.$id);
  } catch (err) {
    console.error("searchUsers error:", err);
    return [];
  }
};

export const FetchAllCreators = async (setAllCreators) => {
  try {
    const creatorRoleQuery = Query.contains("roles", [SELECTABLE_ROLE_KEYS.creator]);
    const totalResponse = await fetchUsersByQuery([creatorRoleQuery]);

    const total = totalResponse.total;
    let tempRandomCreators = [];
    let lastID = null;

    while (tempRandomCreators.length < total) {
      const queries = [Query.limit(100), creatorRoleQuery];
      if (lastID) queries.push(Query.cursorAfter(lastID));

      const response = await fetchUsersByQuery(queries);

      if (response.documents.length === 0) break;

      tempRandomCreators.push(...response.documents);
      lastID = response.documents[response.documents.length - 1].$id;
    }

    // Shuffle the array
    const shuffled = tempRandomCreators.sort(() => 0.5 - Math.random());
    setAllCreators(shuffled);
  } catch (error) {
    console.log("getRandomCreators: error", error);
    return [];
  }
};

export const pingUserActive = async ({ userId }) => {
  const now = new Date().toISOString();

  await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.userCollectionId, userId, {
    lastActive: now,
  });
};
