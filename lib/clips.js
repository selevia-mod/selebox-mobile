import { ID, Query } from "react-native-appwrite";
import { appwriteConfig, databases } from "./appwrite";

export const DEFAULT_CLIPS_PAGE_LIMIT = 25;

export const initialClipForm = {
  thumbnail: "",
  clipUrl: "",
  title: "",
  description: "",
  uploader: "",
};

export const FetchAllClips = async (setAllClips) => {
  try {
    const allClips = [];
    let lastId = null;

    while (true) {
      const queries = [Query.select(["$id"]), Query.limit(100)];
      if (lastId) queries.push(Query.cursorAfter(lastId));

      const resp = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.clipsCollectionId, queries);

      if (resp.documents.length === 0) break;

      allClips.push(...resp.documents);
      lastId = resp.documents[resp.documents.length - 1].$id;
    }

    setAllClips(allClips);
  } catch (error) {
    console.error("FetchAllClips failed:", error);
  }
};

export const FetchAllClipsLength = async (setAllClipsLength) => {
  const resp = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.clipsCollectionId, [Query.limit(1)]);

  setAllClipsLength(resp.total);
};

export const fetchRandomClips = async ({ limit, allClipsLength }) => {
  const randomIndex = Math.floor(Math.random() * allClipsLength);
  const result = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.clipsCollectionId, [
    Query.limit(limit),
    Query.offset(randomIndex),
  ]);
  return result;
};

export const createNewClip = async ({ ID, title, description, thumbnail, uri, clipUrl, uploader, ...props }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.clipsCollectionId, ID, {
    title: title,
    description: description,
    thumbnail: thumbnail,
    uri: uri,
    clipUrl: clipUrl,
    uploader: uploader,
    ...props,
  });
};

export const updateClip = async ({ ID, ...props }) => {
  return databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.clipsCollectionId, ID, {
    ...props,
  });
};

export const getClip = async ({ ID }) => {
  return databases.getDocument(appwriteConfig.databaseId, appwriteConfig.clipsCollectionId, ID);
};

export const fetchClips = async ({ limit, lastId, userId }) => {
  const queries = [Query.limit(limit), Query.orderDesc("$createdAt")];
  if (lastId) queries.push(Query.cursorAfter(lastId));
  if (userId) queries.push(Query.equal("uploader", userId));
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.clipsCollectionId, queries);
};

export const getClipLike = async ({ clipId, likeOwner }) => {
  const queries = [Query.and([Query.equal("clipId", clipId), Query.equal("likeOwner", likeOwner)])];
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.clipsLikeCollectionId, queries);
};

export const createClipLike = async ({ clipId, likeOwner }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.clipsLikeCollectionId, ID.unique(), {
    clipId,
    likeOwner,
  });
};

export const deleteClipLike = async ({ clipLikeId }) => {
  return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.clipsLikeCollectionId, clipLikeId);
};

export const fetchClipComments = async ({ clipId }) => {
  const queries = [Query.equal("clipId", clipId)];
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.clipsCommentCollectionId, queries);
};

export const createClipComment = async ({ clipId, comment, commentOwner }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.clipsCommentCollectionId, ID.unique(), {
    clipId,
    comment,
    commentOwner,
  });
};
