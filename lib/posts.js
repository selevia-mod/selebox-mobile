import { ID, Query } from "react-native-appwrite";
import { storage as localStorage } from "../store/storage";
import { appwriteConfig, databases, storage } from "./appwrite";
import { getClip } from "./clips";
import { FollowService } from "./follows";
import { searchUsers } from "./users";
import logger from "./utils/logger";
import { VideosService } from "./video";

const feedGeneratorApi = "https://692eea2e002e16d51edd.fra.appwrite.run";
const LOCAL_POST_VIEWS_KEY_PREFIX = "post-views:";
const MAX_CACHED_POST_VIEWS = 220;

const safeParse = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    logger.warn("posts", "parse error", error);
    return null;
  }
};

const normalizeSeenPostIds = (postIds = []) => {
  const normalized = [];

  (Array.isArray(postIds) ? postIds : []).forEach((postId) => {
    const normalizedId = typeof postId === "string" ? postId : postId?.toString?.();
    if (!normalizedId || normalized.includes(normalizedId)) return;
    normalized.push(normalizedId);
  });

  return normalized;
};

const mergeSeenPostIds = (...collections) => {
  const merged = [];

  collections.forEach((postIds) => {
    normalizeSeenPostIds(postIds).forEach((postId) => {
      const existingIndex = merged.indexOf(postId);
      if (existingIndex >= 0) merged.splice(existingIndex, 1);
      merged.push(postId);
    });
  });

  if (merged.length > MAX_CACHED_POST_VIEWS) {
    return merged.slice(merged.length - MAX_CACHED_POST_VIEWS);
  }

  return merged;
};

const getLocalPostViewsKey = (userId) => `${LOCAL_POST_VIEWS_KEY_PREFIX}${userId}`;

export const getCachedViewedPostIds = (userId) => {
  if (!userId) return [];
  const cached = safeParse(localStorage.getString(getLocalPostViewsKey(userId)));
  return normalizeSeenPostIds(cached?.postIds);
};

const setCachedViewedPostIds = (userId, postIds = []) => {
  if (!userId) return [];

  const boundedPostIds = mergeSeenPostIds(postIds);
  localStorage.set(
    getLocalPostViewsKey(userId),
    JSON.stringify({
      version: 1,
      postIds: boundedPostIds,
      updatedAt: Date.now(),
    }),
  );

  return boundedPostIds;
};

export const initialPostForm = {
  post: "",
  postUrls: [],
  postOwner: "",
};

export const createNewPost = async ({ post, postUrls, postOwner, ...props }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, ID.unique(), {
    post,
    postUrls,
    postOwner,
    ...props,
  });
};

export const updatePost = async ({ ID, ...props }) => {
  return databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, ID, {
    ...props,
  });
};

export const deletePost = async ({ ID }) => {
  return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, ID);
};

export const searchPosts = async ({ searchQuery = "", limit = 10, cursorId = null }) => {
  try {
    const userIds = await searchUsers(searchQuery);
    const queries = [Query.limit(limit), Query.orderDesc("$createdAt")];

    if (userIds.length > 0) {
      queries.push(Query.or([Query.search("post", searchQuery), [Query.equal("postOwner", userIds)]]));
    } else {
      queries.push(Query.search("post", searchQuery));
    }

    if (cursorId) {
      queries.push(Query.cursorAfter(cursorId));
    }

    const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, queries);
    const lastId = res.documents[res.documents.length - 1]?.$id || null;
    const documents = await hydrateSearchResults(res.documents);
    return {
      documents,
      hasMore: res.documents.length === limit,
      lastId,
    };
  } catch (err) {
    console.error("searchPosts error:", err);
    return { documents: [], hasMore: false };
  }
};

const isValidVideo = (video) => Boolean(video?.videoUrl) && video?.status !== "deleted";
const isValidClip = (clip) => Boolean(clip?.clipUrl) && clip?.status !== "deleted";

const hydrateSearchResults = async (documents = []) => {
  if (!documents.length) return [];

  const videoService = new VideosService();

  // Both helpers intentionally return null on failure (caller filters orphans
  // out) but we must log — silent catch with `_` was hiding genuine network
  // failures in production. logger.warn keeps it as a breadcrumb without
  // promoting it to a non-fatal record (which would spam Crashlytics for
  // every deleted resource).
  const fetchVideo = async (id) => {
    if (!id) return null;
    try {
      return await videoService.getVideo({ id });
    } catch (error) {
      logger.warn("posts/hydrateSearchResults", `getVideo(${id}) failed`, error);
      return null;
    }
  };

  const fetchClip = async (id) => {
    if (!id) return null;
    try {
      return await getClip({ ID: id });
    } catch (error) {
      logger.warn("posts/hydrateSearchResults", `getClip(${id}) failed`, error);
      return null;
    }
  };

  const hydrated = await Promise.all(
    documents.map(async (doc) => {
      if (!doc?.postResourceId) return doc;

      const resourceId = doc.postResourceId;
      const resourceType = doc.postResourceType;

      if (resourceType === "video") {
        const video = isValidVideo(doc.video) ? doc.video : await fetchVideo(resourceId);
        if (!isValidVideo(video)) return null;
        return { ...doc, video, postResourceType: "video" };
      }

      if (resourceType === "clip") {
        const clip = isValidClip(doc.clip) ? doc.clip : await fetchClip(resourceId);
        if (!isValidClip(clip)) return null;
        return { ...doc, clip, postResourceType: "clip" };
      }

      if (isValidVideo(doc.video)) {
        return { ...doc, video: doc.video, postResourceType: "video" };
      }

      if (isValidClip(doc.clip)) {
        return { ...doc, clip: doc.clip, postResourceType: "clip" };
      }

      const video = await fetchVideo(resourceId);
      if (isValidVideo(video)) {
        return { ...doc, video, postResourceType: "video" };
      }

      const clip = await fetchClip(resourceId);
      if (isValidClip(clip)) {
        return { ...doc, clip, postResourceType: "clip" };
      }

      return null;
    }),
  );

  return hydrated.filter(Boolean);
};

// Batch helper — given a page of posts and a current viewer, attaches an
// `isLikedByCurrentUser` flag to each in ONE round-trip instead of N. Without
// this, every PostCard mounts and individually calls getPostLike(), so a
// 15-post feed page = 15 separate network calls just for the heart state.
// PostInformation already has a fast-path bypass when this flag is present.
export const attachIsLikedByCurrentUser = async (postDocuments, viewerUserId) => {
  if (!Array.isArray(postDocuments) || postDocuments.length === 0) return postDocuments;
  if (!viewerUserId) return postDocuments;

  const postIds = postDocuments.map((p) => p?.$id).filter(Boolean);
  if (postIds.length === 0) return postDocuments;

  try {
    // Single batched query: all likes by this viewer for any of these posts.
    // Appwrite's Query.equal accepts arrays; we stay well under the 100-item
    // limit because feed page sizes are 10–20.
    const likeRows = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsLikeCollectionId, [
      Query.equal("postId", postIds),
      Query.equal("likeOwner", viewerUserId),
      Query.limit(postIds.length),
    ]);
    const likedSet = new Set((likeRows?.documents || []).map((row) => row?.postId).filter(Boolean));
    return postDocuments.map((post) => (post?.$id ? { ...post, isLikedByCurrentUser: likedSet.has(post.$id) } : post));
  } catch (error) {
    logger.warn("posts/attachIsLikedByCurrentUser", "batch like fetch failed; cards will fall back to per-post fetch", error);
    return postDocuments;
  }
};

export const fetchPosts = async ({ limit, lastId, userId }) => {
  const queries = [Query.limit(limit), Query.orderDesc("$createdAt")];
  if (lastId) queries.push(Query.cursorAfter(lastId));
  if (userId) queries.push(Query.equal("postOwner", userId));
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, queries);
};

export const fetchGeneratedPosts = async ({
  limit,
  lastId,
  userId,
  blockedUserIds = [],
  hiddenContentIds = [],
  seenPostIds = [],
  seenPostEngagementByPostId = {},
  refresh = false,
}) => {
  const mergedSeenPostIds = userId ? mergeSeenPostIds(getCachedViewedPostIds(userId), seenPostIds) : mergeSeenPostIds(seenPostIds);
  const allowedSeenPostIds = new Set(mergedSeenPostIds);
  const normalizedSeenPostEngagementByPostId = Object.entries(seenPostEngagementByPostId || {}).reduce((acc, [postId, engagementRate]) => {
    const normalizedPostId = typeof postId === "string" ? postId : postId?.toString?.();
    const normalizedRate = Number(engagementRate);

    if (!normalizedPostId || !allowedSeenPostIds.has(normalizedPostId)) return acc;
    if (!Number.isFinite(normalizedRate) || normalizedRate <= 0) return acc;

    acc[normalizedPostId] = Number(normalizedRate.toFixed(4));
    return acc;
  }, {});

  const payload = {
    limit,
    ...(lastId ? { cursor: lastId } : {}),
    ...(userId ? { userId } : {}),
    ...(blockedUserIds.length > 0 ? { blockedUsers: blockedUserIds } : {}),
    ...(hiddenContentIds.length > 0 ? { hiddenContent: hiddenContentIds } : {}),
    ...(mergedSeenPostIds.length > 0 ? { seenPostIds: mergedSeenPostIds } : {}),
    ...(Object.keys(normalizedSeenPostEngagementByPostId).length > 0 ? { seenPostEngagementByPostId: normalizedSeenPostEngagementByPostId } : {}),
    ...(refresh ? { refresh: true, requestTs: Date.now() } : {}),
  };

  const url = `${feedGeneratorApi}/feed`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
    body: JSON.stringify(payload),
  });
  return res.json();
};

// ─────────────────────────────────────────────────────────────────────────────
// Tab-specific feed loaders (For You / Following / Discover)
// ─────────────────────────────────────────────────────────────────────────────
// For You is served by fetchGeneratedPosts (personalized via the feed
// generator API). Following and Discover do client-side queries against the
// posts collection, then wrap each document into the same { type, data } shape
// as feedItems so home.jsx's existing render pipeline works unchanged.

const wrapAsPostFeedItem = (postDoc) => ({
  type: "post",
  data: postDoc,
});

const resolveFollowingId = (doc) => {
  const followingId = doc?.followingId;
  if (!followingId) return null;
  if (typeof followingId === "string") return followingId;
  return followingId.$id || null;
};

const filterPostsBySafety = (posts, blockedUserIds = [], hiddenContentIds = []) => {
  const blockedSet = new Set(blockedUserIds);
  const hiddenSet = new Set(hiddenContentIds);
  return posts.filter((post) => {
    const ownerId = post?.postOwner?.$id || post?.postOwner;
    if (ownerId && blockedSet.has(ownerId)) return false;
    if (post?.$id && hiddenSet.has(post.$id)) return false;
    return true;
  });
};

// Drop posts whose postOwner relation resolved without usable identity fields.
// Symptom on the dev client: empty avatar + blank username on the card. Cause
// is usually a deleted owner account or a shallow relation that gives us only
// the $id. PostCard reads item.postOwner.username/avatar directly (no
// fallbacks), so showing them is worse than skipping them.
const hasValidPostOwner = (post) => {
  const owner = post?.postOwner;
  if (!owner || typeof owner !== "object") return false;
  // username is the minimum we need; avatar can be absent.
  return Boolean(owner.username);
};

/**
 * Attach the referenced video / clip / book document onto each post that has a
 * `postResourceId`. Direct fetches from the posts collection (e.g. ProfilePostTab)
 * don't auto-expand the relationship, so without this hydration PostVideo /
 * PostClip / PostBook receive the bare post doc and render an empty header
 * (no avatar, no username) — the data they need lives on the resource doc.
 *
 * Batched per resource type, so this is at most three round-trips regardless of
 * how many posts you pass in. Orphan references (resource was deleted) are left
 * as-is — the caller's downstream filter or UI fallback handles those.
 */
export const hydrateResourcePosts = async (posts) => {
  if (!Array.isArray(posts) || posts.length === 0) return posts;

  const videoIds = new Set();
  const clipIds = new Set();
  const bookIds = new Set();

  for (const post of posts) {
    if (!post?.postResourceId) continue;
    if (post.video || post.clip || post.book) continue; // already hydrated upstream
    if (post.postResourceType === "video") videoIds.add(post.postResourceId);
    else if (post.postResourceType === "clip") clipIds.add(post.postResourceId);
    else if (post.postResourceType === "book") bookIds.add(post.postResourceId);
  }

  if (videoIds.size === 0 && clipIds.size === 0 && bookIds.size === 0) return posts;

  const fetchByIds = async (ids, collectionId) => {
    const map = new Map();
    if (ids.size === 0) return map;
    try {
      const idArray = Array.from(ids);
      const res = await databases.listDocuments(appwriteConfig.databaseId, collectionId, [
        Query.equal("$id", idArray),
        Query.limit(idArray.length),
      ]);
      for (const doc of res.documents || []) {
        if (doc?.$id) map.set(doc.$id, doc);
      }
    } catch (error) {
      logger.warn("posts", `hydrateResourcePosts batch lookup failed for ${collectionId}`, error);
    }
    return map;
  };

  const [videoMap, clipMap, bookMap] = await Promise.all([
    fetchByIds(videoIds, appwriteConfig.videosCollectionId),
    fetchByIds(clipIds, appwriteConfig.clipsCollectionId),
    fetchByIds(bookIds, appwriteConfig.booksCollectionId),
  ]);

  return posts.map((post) => {
    if (!post?.postResourceId) return post;
    if (post.postResourceType === "video") {
      const video = videoMap.get(post.postResourceId);
      return video ? { ...post, video } : post;
    }
    if (post.postResourceType === "clip") {
      const clip = clipMap.get(post.postResourceId);
      return clip ? { ...post, clip } : post;
    }
    if (post.postResourceType === "book") {
      const book = bookMap.get(post.postResourceId);
      return book ? { ...post, book } : post;
    }
    return post;
  });
};

// Drop posts whose referenced video/clip has been deleted. The post survives
// the parent collection but its postResourceId points to a missing document,
// so PostCard's embedded player gets stuck on a loading state and triggers
// "getVideoCommentCount video lookup error" warns. Batch-validate references
// in one or two queries instead of N+1 lookups.
const filterOrphanResourcePosts = async (posts) => {
  const videoIdsToCheck = new Set();
  const clipIdsToCheck = new Set();

  for (const post of posts) {
    if (post?.postResourceType === "video" && post?.postResourceId) {
      videoIdsToCheck.add(post.postResourceId);
    } else if (post?.postResourceType === "clip" && post?.postResourceId) {
      clipIdsToCheck.add(post.postResourceId);
    }
  }

  if (videoIdsToCheck.size === 0 && clipIdsToCheck.size === 0) return posts;

  let validVideoIds = videoIdsToCheck; // default: don't filter on error
  let validClipIds = clipIdsToCheck;

  try {
    if (videoIdsToCheck.size > 0) {
      const videoIds = Array.from(videoIdsToCheck);
      const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, [
        Query.equal("$id", videoIds),
        Query.limit(videoIds.length),
      ]);
      validVideoIds = new Set((res.documents || []).map((doc) => doc.$id));
    }
  } catch (error) {
    logger.warn("posts", "filterOrphanResourcePosts: video batch lookup failed", error);
  }

  try {
    if (clipIdsToCheck.size > 0) {
      const clipIds = Array.from(clipIdsToCheck);
      const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.clipsCollectionId, [
        Query.equal("$id", clipIds),
        Query.limit(clipIds.length),
      ]);
      validClipIds = new Set((res.documents || []).map((doc) => doc.$id));
    }
  } catch (error) {
    logger.warn("posts", "filterOrphanResourcePosts: clip batch lookup failed", error);
  }

  return posts.filter((post) => {
    if (post?.postResourceType === "video") {
      return Boolean(post?.postResourceId && validVideoIds.has(post.postResourceId));
    }
    if (post?.postResourceType === "clip") {
      return Boolean(post?.postResourceId && validClipIds.has(post.postResourceId));
    }
    // Text/image posts (no resource reference) always pass.
    return true;
  });
};

// Following: posts authored by users the viewer follows, newest first.
// Returns { feed, nextCursor, hasMore } shape matching fetchGeneratedPosts.
export const fetchFollowingPosts = async ({ userId, limit = 10, lastId, blockedUserIds = [], hiddenContentIds = [] }) => {
  if (!userId) return { feed: [], nextCursor: null, hasMore: false, followingCount: 0 };

  const followingDocs = await FollowService.getFollowing({ userId });
  const followingIds = (Array.isArray(followingDocs) ? followingDocs : []).map(resolveFollowingId).filter(Boolean);

  if (followingIds.length === 0) {
    // Caller can use followingCount === 0 to show "Follow people" empty state.
    return { feed: [], nextCursor: null, hasMore: false, followingCount: 0 };
  }

  const queries = [Query.limit(limit), Query.orderDesc("$createdAt"), Query.equal("postOwner", followingIds)];
  if (lastId) queries.push(Query.cursorAfter(lastId));

  const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, queries);
  const safe = filterPostsBySafety(res.documents || [], blockedUserIds, hiddenContentIds);
  const ownerValid = safe.filter(hasValidPostOwner);
  const filtered = await filterOrphanResourcePosts(ownerValid);

  return {
    feed: filtered.map(wrapAsPostFeedItem),
    nextCursor: filtered.length > 0 ? filtered[filtered.length - 1].$id : null,
    hasMore: (res.documents?.length ?? 0) === limit,
    followingCount: followingIds.length,
  };
};

// Discover: trending posts in the last 7 days, with chronological fallback to
// fill the page when engagement is sparse. Includes followed users (popular
// posts deserve a place regardless of who you follow). Excludes own + blocked
// + hidden. Pagination after the first page is chronological.
const DISCOVER_TRENDING_WINDOW_DAYS = 7;
const DISCOVER_TRENDING_CANDIDATE_LIMIT = 50;

const scoreDiscoverPost = (post) => {
  const likes = Number(post?.postLikes) || 0;
  const comments = Number(post?.postComments) || 0;
  const createdAtMs = post?.$createdAt ? new Date(post.$createdAt).getTime() : Date.now();
  const hoursAgo = Math.max(0, (Date.now() - createdAtMs) / (1000 * 60 * 60));
  const recencyBonus = Math.max(0, 24 - hoursAgo); // sliding bonus over first 24h
  return likes * 2 + comments * 3 + recencyBonus;
};

const dedupePostsById = (posts) => {
  const seen = new Set();
  const out = [];
  for (const post of posts) {
    const id = post?.$id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(post);
  }
  return out;
};

const filterDiscoverCandidates = (docs, userId, blockedUserIds, hiddenContentIds) => {
  let out = docs;
  if (userId) {
    out = out.filter((post) => {
      const ownerId = post?.postOwner?.$id || post?.postOwner;
      return ownerId !== userId;
    });
  }
  out = filterPostsBySafety(out, blockedUserIds, hiddenContentIds);
  // Drop orphaned posts (deleted authors / shallow relations) — they'd render
  // as empty cards and hurt the Discover impression more than missing them.
  out = out.filter(hasValidPostOwner);
  return out;
};

export const fetchDiscoverPosts = async ({ userId, limit = 10, lastId, blockedUserIds = [], hiddenContentIds = [] }) => {
  // Pagination after the first page = chronological cursor (trending is global,
  // doesn't paginate naturally). The home feed dedupes against already-shown
  // items, so any boundary overlap is handled there.
  if (lastId) {
    const queries = [Query.limit(limit), Query.orderDesc("$createdAt"), Query.cursorAfter(lastId)];
    const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, queries);
    const candidates = filterDiscoverCandidates(res.documents || [], userId, blockedUserIds, hiddenContentIds);
    const filtered = await filterOrphanResourcePosts(candidates);

    return {
      feed: filtered.map(wrapAsPostFeedItem),
      nextCursor: filtered.length > 0 ? filtered[filtered.length - 1].$id : null,
      hasMore: (res.documents?.length ?? 0) === limit,
    };
  }

  // ── First page: trending (last 7 days, scored) + chronological fallback ──
  const sevenDaysAgoIso = new Date(Date.now() - DISCOVER_TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const trendingRes = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, [
    Query.limit(DISCOVER_TRENDING_CANDIDATE_LIMIT),
    Query.greaterThan("$createdAt", sevenDaysAgoIso),
    Query.orderDesc("$createdAt"),
  ]);

  const trendingCandidates = filterDiscoverCandidates(trendingRes.documents || [], userId, blockedUserIds, hiddenContentIds);
  const trendingFiltered = await filterOrphanResourcePosts(trendingCandidates);
  const scored = trendingFiltered
    .map((post) => ({ post, score: scoreDiscoverPost(post) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.post);

  let result = scored.slice(0, limit);

  // Fallback to chronological all-posts if engagement is sparse (or platform
  // is small). Ensures Discover never feels empty.
  if (result.length < limit) {
    const fillNeeded = limit - result.length;
    const fillRes = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, [
      Query.limit(fillNeeded * 2 + 5),
      Query.orderDesc("$createdAt"),
    ]);
    const fillCandidates = filterDiscoverCandidates(fillRes.documents || [], userId, blockedUserIds, hiddenContentIds);
    const fillFiltered = await filterOrphanResourcePosts(fillCandidates);
    result = dedupePostsById([...result, ...fillFiltered]).slice(0, limit);
  }

  // Use the OLDEST $createdAt as the next cursor — chronological pagination
  // from there won't skip newer trending items we already showed (home.jsx
  // dedupes anyway).
  let nextCursor = null;
  if (result.length > 0) {
    const oldest = result.reduce((acc, post) => {
      if (!acc || (post?.$createdAt && post.$createdAt < acc.$createdAt)) return post;
      return acc;
    }, null);
    nextCursor = oldest?.$id || null;
  }

  return {
    feed: result.map(wrapAsPostFeedItem),
    nextCursor,
    hasMore: result.length >= limit,
  };
};

export const recordPostView = async ({ postId, viewOwner }) => {
  if (!postId || !viewOwner) return null;

  const cachedPostIds = getCachedViewedPostIds(viewOwner);
  const nextPostIds = mergeSeenPostIds(cachedPostIds, [postId]);
  setCachedViewedPostIds(viewOwner, nextPostIds);

  return {
    postId,
    viewOwner,
    cached: true,
    updatedAt: new Date().toISOString(),
  };
};

export const getPostLike = async ({ postId, likeOwner }) => {
  const queries = [Query.and([Query.equal("postId", postId), Query.equal("likeOwner", likeOwner)])];
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsLikeCollectionId, queries);
};

export const getPost = async ({ ID }) => {
  return databases.getDocument(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, ID);
};

export const createPostLike = async ({ postId, likeOwner }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.postsLikeCollectionId, ID.unique(), {
    postId,
    likeOwner,
  });
};

export const deletePostLike = async ({ postLikeId }) => {
  return databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.postsLikeCollectionId, postLikeId);
};

export const fetchPostLikes = async ({ postId, lastId, limit }) => {
  const queries = [Query.limit(limit), Query.equal("postId", postId)];
  if (lastId) queries.push(Query.cursorAfter(lastId));
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsLikeCollectionId, queries);
};

export const fetchPostComments = async ({ postId, lastId, limit }) => {
  const queries = [Query.limit(limit), Query.equal("postId", postId)];
  if (lastId) queries.push(Query.cursorAfter(lastId));
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsCommentCollectionId, queries);
};

export const createPostComment = async ({ postId, comment, commentOwner }) => {
  return databases.createDocument(appwriteConfig.databaseId, appwriteConfig.postsCommentCollectionId, ID.unique(), {
    postId,
    comment,
    commentOwner,
  });
};

const resolveNestedRelationId = (value) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return resolveNestedRelationId(value[0]);
  return value?.$id || value?.id || null;
};

const POST_COMMENT_PARENT_KEYS = ["postComment", "postComments", "parentComment", "parentCommentId", "replyToComment"];
const POST_COMMENT_LIKE_KEYS = ["postComment", "postsComment"];

export const resolvePostCommentParentId = (comment = {}) => {
  return (
    resolveNestedRelationId(comment?.postComment) ||
    resolveNestedRelationId(comment?.postComments) ||
    resolveNestedRelationId(comment?.parentComment) ||
    resolveNestedRelationId(comment?.parentCommentId) ||
    resolveNestedRelationId(comment?.replyToComment) ||
    null
  );
};

export const mapPostRepliesByParentId = (replies = []) => {
  const repliesByParent = {};

  (replies || []).forEach((reply) => {
    const parentId = resolvePostCommentParentId(reply);
    if (!parentId) return;
    if (!repliesByParent[parentId]) repliesByParent[parentId] = [];
    repliesByParent[parentId].push(reply);
  });

  return repliesByParent;
};

export const resolvePostCommentLikeId = (like = {}) => {
  return resolveNestedRelationId(like?.postComment) || resolveNestedRelationId(like?.postsComment) || null;
};

export const mapPostCommentLikesByCommentId = (likes = []) => {
  const likesByCommentId = {};

  (likes || []).forEach((like) => {
    const commentId = resolvePostCommentLikeId(like);
    if (!commentId) return;
    if (!likesByCommentId[commentId]) likesByCommentId[commentId] = [];
    likesByCommentId[commentId].push(like);
  });

  return likesByCommentId;
};

export const fetchPostCommentLikesByCommentIds = async ({ commentIds = [], limit = 1000 }) => {
  if (!Array.isArray(commentIds) || commentIds.length === 0) {
    return {
      relationKey: null,
      documents: [],
      byCommentId: {},
    };
  }

  const likesCollectionId = appwriteConfig.postsCommentLikesCollectionId;
  if (!likesCollectionId) {
    return {
      relationKey: null,
      documents: [],
      byCommentId: {},
    };
  }

  let lastError = null;
  for (const relationKey of POST_COMMENT_LIKE_KEYS) {
    try {
      const response = await databases.listDocuments(appwriteConfig.databaseId, likesCollectionId, [
        Query.equal(relationKey, commentIds),
        Query.limit(limit),
      ]);
      const documents = response?.documents || [];
      return {
        relationKey,
        documents,
        byCommentId: mapPostCommentLikesByCommentId(documents),
      };
    } catch (error) {
      lastError = error;
    }
  }

  console.log("fetchPostCommentLikesByCommentIds: failed to resolve relation key", lastError?.message || lastError);
  return {
    relationKey: null,
    documents: [],
    byCommentId: {},
  };
};

export const getPostCommentLikeByOwner = async ({ commentId, likeOwner }) => {
  if (!commentId || !likeOwner) {
    return {
      relationKey: null,
      total: 0,
      documents: [],
    };
  }

  const likesCollectionId = appwriteConfig.postsCommentLikesCollectionId;
  if (!likesCollectionId) {
    return {
      relationKey: null,
      total: 0,
      documents: [],
    };
  }

  let lastError = null;
  for (const relationKey of POST_COMMENT_LIKE_KEYS) {
    try {
      const response = await databases.listDocuments(appwriteConfig.databaseId, likesCollectionId, [
        Query.equal(relationKey, [commentId]),
        Query.equal("likeOwner", [likeOwner]),
        Query.limit(1),
      ]);
      return {
        relationKey,
        total: Number(response?.total || 0),
        documents: response?.documents || [],
      };
    } catch (error) {
      lastError = error;
    }
  }

  console.log("getPostCommentLikeByOwner: failed to resolve relation key", lastError?.message || lastError);
  return {
    relationKey: null,
    total: 0,
    documents: [],
  };
};

export const createPostCommentLike = async ({ commentId, likeOwner }) => {
  try {
    if (!commentId || !likeOwner) {
      console.warn("createPostCommentLike missing required params", { commentId, likeOwner });
      return null;
    }

    const likesCollectionId = appwriteConfig.postsCommentLikesCollectionId;
    if (!likesCollectionId) return null;

    const existing = await getPostCommentLikeByOwner({ commentId, likeOwner });
    if ((existing?.total || 0) > 0) {
      return existing.documents?.[0] || null;
    }

    let lastError = null;
    for (const relationKey of POST_COMMENT_LIKE_KEYS) {
      try {
        return await databases.createDocument(appwriteConfig.databaseId, likesCollectionId, ID.unique(), {
          [relationKey]: commentId,
          likeOwner,
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("createPostCommentLike failed");
  } catch (error) {
    console.error("createPostCommentLike error:", error?.message || error);
    return null;
  }
};

export const removePostCommentLike = async ({ commentId, likeOwner }) => {
  try {
    if (!commentId || !likeOwner) {
      console.warn("removePostCommentLike missing required params", { commentId, likeOwner });
      return null;
    }

    const likesCollectionId = appwriteConfig.postsCommentLikesCollectionId;
    if (!likesCollectionId) return null;

    const existing = await getPostCommentLikeByOwner({ commentId, likeOwner });
    const existingLikeId = existing?.documents?.[0]?.$id;
    if (!existingLikeId) return null;

    return databases.deleteDocument(appwriteConfig.databaseId, likesCollectionId, existingLikeId);
  } catch (error) {
    console.error("removePostCommentLike error:", error?.message || error);
    return null;
  }
};

export const fetchPostCommentRepliesByParentIds = async ({ parentCommentIds = [], limit = 400 }) => {
  if (!Array.isArray(parentCommentIds) || parentCommentIds.length === 0) {
    return {
      relationKey: null,
      documents: [],
      byParentId: {},
    };
  }

  const repliesCollectionId = appwriteConfig.postsCommentRepliesCollectionId;
  if (!repliesCollectionId) {
    return {
      relationKey: null,
      documents: [],
      byParentId: {},
    };
  }

  let lastError = null;
  for (const relationKey of POST_COMMENT_PARENT_KEYS) {
    try {
      const response = await databases.listDocuments(appwriteConfig.databaseId, repliesCollectionId, [
        Query.equal(relationKey, parentCommentIds),
        Query.orderAsc("$createdAt"),
        Query.limit(limit),
      ]);
      const documents = response?.documents || [];
      return {
        relationKey,
        documents,
        byParentId: mapPostRepliesByParentId(documents),
      };
    } catch (error) {
      lastError = error;
    }
  }

  console.log("fetchPostCommentRepliesByParentIds: failed to resolve relation key", lastError?.message || lastError);
  return {
    relationKey: null,
    documents: [],
    byParentId: {},
  };
};

export const threadPostComments = (rawComments = [], externalRepliesByParent = null) => {
  if (!Array.isArray(rawComments) || rawComments.length === 0) return [];

  if (externalRepliesByParent && typeof externalRepliesByParent === "object") {
    return rawComments.map((comment) => ({
      ...comment,
      postCommentReplies: externalRepliesByParent[comment?.$id] || [],
    }));
  }

  const topLevel = [];
  const repliesByParent = {};
  const orphanReplies = [];

  rawComments.forEach((comment) => {
    const parentId = resolvePostCommentParentId(comment);
    if (!parentId) {
      topLevel.push(comment);
      return;
    }

    if (!repliesByParent[parentId]) repliesByParent[parentId] = [];
    repliesByParent[parentId].push(comment);
  });

  const threaded = topLevel.map((comment) => ({
    ...comment,
    postCommentReplies: repliesByParent[comment?.$id] || [],
  }));

  Object.keys(repliesByParent).forEach((parentId) => {
    const parentExists = topLevel.some((comment) => String(comment?.$id || "") === String(parentId));
    if (!parentExists) {
      orphanReplies.push(...repliesByParent[parentId]);
    }
  });

  if (orphanReplies.length > 0) {
    orphanReplies.forEach((reply) => {
      threaded.push({
        ...reply,
        postCommentReplies: [],
      });
    });
  }

  return threaded;
};

export const createPostReplyComment = async ({ postId, comment, commentOwner, parentCommentId }) => {
  if (!postId || !commentOwner || !parentCommentId || !comment?.trim()) {
    throw new Error("createPostReplyComment: missing required params");
  }

  const trimmedComment = comment.trim();
  const basePayload = {
    postId,
    comment: trimmedComment,
    commentOwner,
  };
  const fallbackPayload = {
    comment: trimmedComment,
    commentOwner,
  };
  const repliesCollectionId = appwriteConfig.postsCommentRepliesCollectionId || appwriteConfig.postsCommentCollectionId;
  let lastError = null;

  for (const relationKey of POST_COMMENT_PARENT_KEYS) {
    for (const payload of [basePayload, fallbackPayload]) {
      try {
        return await databases.createDocument(appwriteConfig.databaseId, repliesCollectionId, ID.unique(), {
          ...payload,
          [relationKey]: parentCommentId,
        });
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("createPostReplyComment failed");
};

export async function uploadImageToStorage(file) {
  const { convertToWebP, cleanupTempFile } = require("./utils/image-utils");
  const webp = await convertToWebP(file.uri, { maxWidth: 1000 });
  try {
    const asset = {
      name: (file.fileName || file.uri.split("/").pop()).replace(/\.\w+$/, ".webp"),
      size: webp.fileSize,
      type: "image/webp",
      uri: webp.uri,
    };
    const uploadedFile = await storage.createFile(appwriteConfig.postsStorageId, ID.unique(), asset);
    const fileUrl = storage.getFilePreview(appwriteConfig.postsStorageId, uploadedFile.$id);
    if (typeof fileUrl === "string") return fileUrl;
    if (fileUrl?.href) return fileUrl.href;
    if (typeof fileUrl?.toString === "function") return fileUrl.toString();
    return `${fileUrl}`;
  } catch (error) {
    throw error;
  } finally {
    cleanupTempFile(webp.uri, file.uri);
  }
}

export async function deleteImageFromStorage(fileId) {
  try {
    await storage.deleteFile(appwriteConfig.postsStorageId, fileId);
  } catch (error) {
    throw error;
  }
}

export const findPostByVideoId = async (videoId) => {
  const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, [Query.equal("postResourceId", videoId)]);
  return res.documents?.[0] || null;
};
