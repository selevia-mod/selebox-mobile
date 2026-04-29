import { Query } from "react-native-appwrite";
import { appwriteConfig, databases, hydrateUserWithProfile } from "./appwrite";
import { SELECTABLE_ROLE_KEYS } from "./user-roles";

export const getUserByID = async ({ ID }) => {
  try {
    const userDocument = await databases.getDocument(appwriteConfig.databaseId, appwriteConfig.userCollectionId, ID);
    return hydrateUserWithProfile(userDocument);
  } catch (error) {
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
