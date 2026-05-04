import { ID, Query } from "react-native-appwrite";
import { appwriteConfig, databases } from "./appwrite";
import { dualWriteBookComment, dualWriteChapterComment } from "./books-dual-write";

export const BookCommentsService = {
  likeComment: async ({ userId, commentId }) => {
    try {
      if (!userId || !commentId) {
        console.warn("❌ likeComment missing required ID:", { userId, commentId });
        return null;
      }

      const isExisting = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksCommentLikesCollectionId, [
        Query.equal("bookComment", [commentId]),
        Query.equal("likeOwner", [userId]),
      ]);

      if (isExisting.total === 0) {
        const response = await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.booksCommentLikesCollectionId, ID.unique(), {
          bookComment: commentId,
          likeOwner: userId,
        });
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

      const isExisting = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.booksCommentLikesCollectionId, [
        Query.equal("bookComment", [commentId]),
        Query.equal("likeOwner", [userId]),
      ]);

      if (isExisting.total > 0) {
        const response = await databases.deleteDocument(
          appwriteConfig.databaseId,
          appwriteConfig.booksCommentLikesCollectionId,
          isExisting.documents[0].$id,
        );

        return response;
      }
    } catch (err) {
      console.error("removeLikeComment error:", err?.message || err);
      return null;
    }
  },

  createReplyComment: async ({ comment, commentOwner, bookComment }) => {
    try {
      if (!comment || !commentOwner || !bookComment) {
        console.warn("❌ createReplyComment missing required params:", { comment, commentOwner, bookComment });
        return null;
      }

      const created = await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.booksCommentRepliesCollectionId, ID.unique(), {
        comment,
        commentOwner,
        bookComment,
      });
      // Mirror reply into Supabase. The helper derives book_id from the
      // parent comment row when bookAppwriteId isn't passed (typical for
      // the reply flow which only knows the parent comment id).
      try {
        await dualWriteBookComment({
          appwriteDocId: created?.$id,
          userAppwriteId: commentOwner,
          body: comment,
          parentAppwriteId: bookComment,
        });
      } catch (sbErr) {
        console.log("[book-comments-appwrite] createReplyComment Supabase dual-write skipped:", sbErr?.message);
      }
      return created;
    } catch (err) {
      console.error("createReplyComment error:", err?.message || err);
      return null;
    }
  },

  createReplyChapterComment: async ({ comment, commentOwner, bookChapterComment }) => {
    try {
      if (!comment || !commentOwner || !bookChapterComment) {
        console.warn("❌ createReplyChapterComment missing required params:", { comment, commentOwner, bookChapterComment });
        return null;
      }

      const created = await databases.createDocument(
        appwriteConfig.databaseId,
        appwriteConfig.booksChaptersCommentRepliesCollectionId,
        ID.unique(),
        {
          comment,
          commentOwner,
          bookChapterComment,
        },
      );
      try {
        await dualWriteChapterComment({
          appwriteDocId: created?.$id,
          userAppwriteId: commentOwner,
          body: comment,
          parentAppwriteId: bookChapterComment,
        });
      } catch (sbErr) {
        console.log("[book-comments-appwrite] createReplyChapterComment Supabase dual-write skipped:", sbErr?.message);
      }
      return created;
    } catch (err) {
      console.error("createReplyChapterComment error:", err?.message || err);
      return null;
    }
  },
};
