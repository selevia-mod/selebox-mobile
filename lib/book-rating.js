import { ID, Query } from "react-native-appwrite";
import secrets from "../private/secrets";
import { databases } from "./appwrite";

export class BookRatingService {
  // Create new rating
  static async createRating({ bookId, userId, rating }) {
    try {
      const res = await databases.createDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.booksRatingsCollectionId, ID.unique(), {
        book: bookId,
        user: userId,
        rating,
      });
      return res;
    } catch (err) {
      console.error("❌ Failed to create rating:", err);
      throw err;
    }
  }

  // Check if user already rated this book
  static async getUserRating({ bookId, userId }) {
    try {
      const queries = [Query.equal("book", bookId), Query.equal("user", userId), Query.limit(1)];
      const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.booksRatingsCollectionId, queries);
      return res.documents?.[0] || null;
    } catch (err) {
      console.error("❌ Failed to get user rating:", err);
      throw err;
    }
  }

  // Get all ratings for a book (to compute average later)
  static async getBookRatings({ bookId }) {
    try {
      const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.booksReadsCollectionId, [
        Query.equal("book", bookId),
      ]);
      return res.documents[0];
    } catch (err) {
      console.error("❌ Failed to get book ratings:", err);
      throw err;
    }
  }
}
