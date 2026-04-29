import { ID, Query } from "react-native-appwrite";
import { appwriteConfig, databases } from "./appwrite";

export class UserReadingListService {
  async fetchUserReadingLists({ ownerId, lastId, limit = 50 }) {
    const queries = [Query.limit(limit), Query.orderDesc("$createdAt")];
    if (ownerId) queries.push(Query.equal("ownerId", ownerId));
    if (lastId) queries.push(Query.cursorAfter(lastId));
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.usersReadingLists, queries);
  }

  async createUserReadingList({ title, ownerId }) {
    return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.usersReadingLists, ID.unique(), {
      title,
      ownerId,
    });
  }

  async updateUserReadingList({ title, readingListId }) {
    return databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.usersReadingLists, readingListId, {
      title,
    });
  }

  async deleteUserReadingList({ readingListId }) {
    return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.usersReadingLists, readingListId);
  }

  async fetchReadingListBooks({ readingListId, lastId, limit = 100 }) {
    const queries = [Query.limit(limit), Query.orderDesc("$createdAt")];
    if (readingListId) queries.push(Query.equal("readingList", readingListId));
    if (lastId) queries.push(Query.cursorAfter(lastId));
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.usersReadingListBooks, queries);
  }

  async getReadingListBookByBook({ readingListId, bookId }) {
    return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.usersReadingListBooks, [
      Query.and([Query.equal("readingList", readingListId), Query.equal("book", bookId)]),
    ]);
  }

  async addBookToReadingList({ readingListId, bookId }) {
    return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.usersReadingListBooks, ID.unique(), {
      readingList: readingListId,
      book: bookId,
    });
  }

  async removeBookFromReadingList({ readingListBookId }) {
    return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.usersReadingListBooks, readingListBookId);
  }
}
