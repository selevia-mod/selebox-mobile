import { Query } from "react-native-appwrite";
import { appwriteConfig, databases } from "./appwrite";
import { BookService } from "./books";
import { searchPosts } from "./posts";
import logger from "./utils/logger";

// Unified cross-content search used by the dedicated search screen.
// Runs all category queries in parallel and returns top-N per type. Each
// individual query degrades to an empty list on error so a single backend
// hiccup doesn't black out the whole search experience.

const trimQuery = (q) => (typeof q === "string" ? q.trim() : "");

export const searchUserProfiles = async (query, limit = 5) => {
  const q = trimQuery(query);
  if (!q) return [];
  try {
    const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.userCollectionId, [
      Query.contains("username", q),
      Query.limit(limit),
    ]);
    return res.documents || [];
  } catch (err) {
    logger.warn("search", "searchUserProfiles failed", err);
    return [];
  }
};

export const searchVideosByTitle = async (query, limit = 5) => {
  const q = trimQuery(query);
  if (!q) return [];
  try {
    const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, [
      Query.contains("title", q),
      Query.limit(limit),
    ]);
    return res.documents || [];
  } catch (err) {
    logger.warn("search", "searchVideosByTitle failed", err);
    return [];
  }
};

export const searchAll = async ({ query, limit = 5 }) => {
  const q = trimQuery(query);
  if (!q) return { users: [], posts: [], books: [], videos: [] };

  const bookService = new BookService();
  const [usersRes, postsRes, booksRes, videosRes] = await Promise.allSettled([
    searchUserProfiles(q, limit),
    searchPosts({ searchQuery: q, limit }),
    bookService.searchBooks({ searchQuery: q, limit }),
    searchVideosByTitle(q, limit),
  ]);

  return {
    users: usersRes.status === "fulfilled" ? usersRes.value : [],
    posts: postsRes.status === "fulfilled" ? postsRes.value?.documents || [] : [],
    books: booksRes.status === "fulfilled" ? booksRes.value?.documents || [] : [],
    videos: videosRes.status === "fulfilled" ? videosRes.value : [],
  };
};
