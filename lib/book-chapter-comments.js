import { ID, Query } from "react-native-appwrite";
import { appwriteConfig, databases } from "./appwrite";

export const BookChapterCommentsService = {
  likeComment: async ({ userId, commentId }) => {
    try {
      if (!userId || !commentId) {
        console.warn("❌ likeComment missing required ID:", { userId, commentId });
        return null;
      }

      const isExisting = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksChaptersCommentLikesCollectionId, [
        Query.equal("bookChapterComment", [commentId]),
        Query.equal("likeOwner", [userId]),
      ]);

      if (isExisting.total === 0) {
        const response = await databases.createDocument(
          appwriteConfig.databaseId,
          appwriteConfig.booksChaptersCommentLikesCollectionId,
          ID.unique(),
          {
            bookChapterComment: commentId,
            likeOwner: userId,
          },
        );
        return response;
      }
    } catch (err) {
      console.error("fetchBookRead error:", err?.message || err);
      return null;
    }
  },

  removeLikeComment: async ({ userId, commentId }) => {
    try {
      if (!userId || !commentId) {
        console.warn("❌ removeLikeComment missing required ID:", { userId, commentId });
        return null;
      }

      const isExisting = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksChaptersCommentLikesCollectionId, [
        Query.equal("bookChapterComment", [commentId]),
        Query.equal("likeOwner", [userId]),
      ]);

      if (isExisting.total > 0) {
        const response = await databases.deleteDocument(
          appwriteConfig.databaseId,
          appwriteConfig.booksChaptersCommentLikesCollectionId,
          isExisting.documents[0].$id,
        );

        return response;
      }
    } catch (err) {
      console.error("removeLikeComment error:", err?.message || err);
      return null;
    }
  },
};
