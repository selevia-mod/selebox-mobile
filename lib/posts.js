import { ID, Query } from "react-native-appwrite";
import { storage as localStorage } from "../store/storage";
import { appwriteConfig, databases, storage } from "./appwrite";
import { USE_SUPABASE_AUTH } from "./feature-flags";
// Clip resource hydration retired May 2026.
import { FollowService } from "./follows";
import { dualWriteDeletePost, dualWritePost, dualWriteUpdatePost } from "./posts-dual-write";
import { fetchPostLikesSupabase } from "./posts-supabase";
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
  // Hotfix (May 2026, USE_SUPABASE_AUTH=true OTA) — under Supabase auth,
  // postOwner is a Supabase UUID. The legacy Appwrite write at the bottom
  // of this function does
  //   databases.createDocument(..., postsCollectionId, ID.unique(), { postOwner })
  // and Appwrite's posts collection has postOwner as a relation to
  // userCollection — so the create rejects (no userCollection doc with
  // that UUID id) and the caller's Alert.alert("Post", "Uploading your
  // post was unsuccessful :(") fires.
  //
  // Route Supabase-auth users through submit_post (SECURITY DEFINER RPC)
  // and skip Appwrite entirely. The home feed reads from Supabase under
  // USE_SUPABASE_POSTS=true (also already on), so the post lands on the
  // very feed we just navigated back to.
  if (USE_SUPABASE_AUTH) {
    const sbMod = await import("./supabase");
    const sb = sbMod.default;
    const trimmed = (post || "").trim();
    const firstImage = (() => {
      if (!Array.isArray(postUrls)) return null;
      for (const u of postUrls) {
        if (typeof u === "string" && u.length > 0) return u;
        if (u && typeof u.uri === "string" && u.uri.length > 0) return u.uri;
      }
      return null;
    })();
    const { data: rpcResult, error: rpcErr } = await sb.rpc("submit_post", {
      p_actor_id: postOwner,
      p_body: trimmed || null,
      p_image_url: firstImage,
      p_video_id: null,
      p_book_id: null,
      p_reposted_from: null,
      p_legacy_appwrite_id: null,
    });
    if (rpcErr) throw rpcErr;
    if (!rpcResult?.id) throw new Error(rpcResult?.error || "submit_post returned no id");
    return {
      $id: rpcResult.id,
      $createdAt: new Date().toISOString(),
      post: trimmed,
      postUrls,
      postOwner,
    };
  }

  const created = await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, ID.unique(), {
    post,
    postUrls,
    postOwner,
    ...props,
  });
  // Mirror to Supabase. USE_SUPABASE_POSTS=true means the mobile feed
  // reads from public.posts; without this dual-write, mobile-authored
  // posts never reach the feed they were just created from.
  try {
    await dualWritePost({
      appwriteDocId: created?.$id,
      postOwnerAppwriteId: postOwner,
      body: post,
      postUrls,
    });
  } catch (sbErr) {
    console.log("[posts] createNewPost Supabase dual-write skipped:", sbErr?.message);
  }
  return created;
};

export const updatePost = async ({ ID: docId, ...props }) => {
  // Same Supabase-auth branch as createNewPost. Under AUTH=true, docId is
  // a Supabase UUID and the Appwrite write would 404. Direct .update on
  // posts works because Supabase auth.uid() = author for own posts (RLS
  // policy "author can update own posts" passes). The submit_post_update
  // RPC keys on legacy_appwrite_id which Supabase-native posts don't have,
  // so the direct path is the right choice here.
  if (USE_SUPABASE_AUTH) {
    const sbMod = await import("./supabase");
    const sb = sbMod.default;
    const bodyChanged = "post" in props || "body" in props;
    const imageChanged = "postUrls" in props;
    const newBody = bodyChanged ? ((props.post ?? props.body) || "").trim() : null;
    const firstImage = imageChanged
      ? (() => {
          if (!Array.isArray(props.postUrls)) return null;
          for (const u of props.postUrls) {
            if (typeof u === "string" && u.length > 0) return u;
            if (u && typeof u.uri === "string" && u.uri.length > 0) return u.uri;
          }
          return null;
        })()
      : null;
    const updates = {};
    if (bodyChanged) updates.body = newBody;
    if (imageChanged) updates.image_url = firstImage; // null clears it, matching the RPC's set-to-null semantics
    if (Object.keys(updates).length > 0) {
      const { error } = await sb.from("posts").update(updates).eq("id", docId);
      if (error) throw error;
    }
    return { $id: docId, ...props };
  }

  const res = await databases.updateDocument(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, docId, {
    ...props,
  });
  try {
    await dualWriteUpdatePost({ appwriteDocId: docId, props });
  } catch (sbErr) {
    console.log("[posts] updatePost Supabase dual-write skipped:", sbErr?.message);
  }
  return res;
};

export const deletePost = async ({ ID: docId }) => {
  // Same branch — under USE_SUPABASE_AUTH=true the doc lives only in
  // Supabase, so a Supabase delete is the canonical path.
  if (USE_SUPABASE_AUTH) {
    const sbMod = await import("./supabase");
    const sb = sbMod.default;
    const { error } = await sb.from("posts").delete().eq("id", docId);
    if (error) throw error;
    return { $id: docId };
  }

  const res = await databases.deleteDocument(appwriteConfig.databaseId, appwriteConfig.postsCollectionId, docId);
  try {
    await dualWriteDeletePost({ appwriteDocId: docId });
  } catch (sbErr) {
    console.log("[posts] deletePost Supabase dual-write skipped:", sbErr?.message);
  }
  return res;
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

const hydrateSearchResults = async (documents = []) => {
  if (!documents.length) return [];

  const videoService = new VideosService();

  // logger.warn instead of silent catch — surfaces genuine network failures
  // without promoting them to non-fatal Crashlytics records (which would
  // spam for every deleted resource).
  const fetchVideo = async (id) => {
    if (!id) return null;
    try {
      return await videoService.getVideo({ id });
    } catch (error) {
      logger.warn("posts/hydrateSearchResults", `getVideo(${id}) failed`, error);
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

      // Clip-resource posts retired May 2026 — drop them entirely so
      // they no longer appear in search results.
      if (resourceType === "clip") return null;

      if (isValidVideo(doc.video)) {
        return { ...doc, video: doc.video, postResourceType: "video" };
      }

      const video = await fetchVideo(resourceId);
      if (isValidVideo(video)) {
        return { ...doc, video, postResourceType: "video" };
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
  const bookIds = new Set();

  for (const post of posts) {
    if (!post?.postResourceId) continue;
    if (post.video || post.book) continue; // already hydrated upstream (clip resources retired)
    if (post.postResourceType === "video") videoIds.add(post.postResourceId);
    else if (post.postResourceType === "book") bookIds.add(post.postResourceId);
  }

  if (videoIds.size === 0 && bookIds.size === 0) return posts;

  const fetchByIds = async (ids, collectionId) => {
    const map = new Map();
    if (ids.size === 0) return map;
    try {
      const idArray = Array.from(ids);
      const res = await databases.listDocuments(appwriteConfig.databaseId, collectionId, [Query.equal("$id", idArray), Query.limit(idArray.length)]);
      for (const doc of res.documents || []) {
        if (doc?.$id) map.set(doc.$id, doc);
      }
    } catch (error) {
      logger.warn("posts", `hydrateResourcePosts batch lookup failed for ${collectionId}`, error);
    }
    return map;
  };

  // Clip resources retired May 2026 — only video + book left.
  const [videoMap, bookMap] = await Promise.all([
    fetchByIds(videoIds, appwriteConfig.videosCollectionId),
    fetchByIds(bookIds, appwriteConfig.booksCollectionId),
  ]);

  return posts.map((post) => {
    if (!post?.postResourceId) return post;
    if (post.postResourceType === "video") {
      const video = videoMap.get(post.postResourceId);
      return video ? { ...post, video } : post;
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

  for (const post of posts) {
    if (post?.postResourceType === "video" && post?.postResourceId) {
      videoIdsToCheck.add(post.postResourceId);
    }
  }

  if (videoIdsToCheck.size === 0) return posts.filter((p) => p?.postResourceType !== "clip");

  let validVideoIds = videoIdsToCheck; // default: don't filter on error
  try {
    const videoIds = Array.from(videoIdsToCheck);
    const res = await databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.videosCollectionId, [
      Query.equal("$id", videoIds),
      Query.limit(videoIds.length),
    ]);
    validVideoIds = new Set((res.documents || []).map((doc) => doc.$id));
  } catch (error) {
    logger.warn("posts", "filterOrphanResourcePosts: video batch lookup failed", error);
  }

  return posts.filter((post) => {
    if (post?.postResourceType === "video") {
      return Boolean(post?.postResourceId && validVideoIds.has(post.postResourceId));
    }
    // Clip-resource posts retired May 2026 — filter them out so the feed
    // doesn't show empty PostClip slots.
    if (post?.postResourceType === "clip") return false;
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

// Single-post fetch — UUID-aware. The home feed under USE_SUPABASE_POSTS=true
// returns posts with `$id` set to either the Appwrite hex (for migrated
// posts that have a `legacy_appwrite_id`) OR the Supabase UUID (for
// web-native posts without an Appwrite mirror). Tapping "Comments" on
// such a post opens /post-item with that id, and post-item calls
// getPost to load it. The earlier implementation always called Appwrite,
// which threw for UUID ids → "Unable to load this post" red banner.
//
// Detect UUID shape, route through Supabase for those, fall back to
// Appwrite for hex ids. Output shape is the same Appwrite-shaped post
// object that PostCard consumes (the adapter does the heavy lifting).
const _UUID_RE_POSTS_GET = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const getPost = async ({ ID }) => {
  if (typeof ID === "string" && _UUID_RE_POSTS_GET.test(ID)) {
    const [{ fetchPostById, fetchPostStats, adaptSupabasePostToAppwriteShape }] = await Promise.all([
      import("./posts-supabase"),
    ]);
    const row = await fetchPostById(ID);
    if (!row) {
      // Mimic Appwrite's not-found shape so the post-item screen's
      // existing error path ("Unable to load this post") still renders
      // the same way for both backends.
      const err = new Error("Document with the requested ID could not be found.");
      err.code = 404;
      throw err;
    }
    const stats = await fetchPostStats([row.id]);
    return adaptSupabasePostToAppwriteShape(row, stats);
  }
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

// UUID-aware router: Supabase-native posts have likes in `reactions`
// (target_type='post'), legacy Appwrite posts have them in the
// postsLikeCollection. PostLikesModal calls this without caring which
// backend the post lives on. The UUID regex match decides.
const _UUID_RE_LIKES = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const fetchPostLikes = async ({ postId, lastId, limit }) => {
  // Supabase-native (UUID id) → query the reactions table. Returns
  // Appwrite-style { documents, total } so the modal stays unchanged.
  if (typeof postId === "string" && _UUID_RE_LIKES.test(postId)) {
    return fetchPostLikesSupabase({ postId, lastId, limit });
  }
  // Legacy hex id → original Appwrite path.
  const queries = [Query.limit(limit), Query.equal("postId", postId)];
  if (lastId) queries.push(Query.cursorAfter(lastId));
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsLikeCollectionId, queries);
};

export const fetchPostComments = async ({ postId, lastId, limit }) => {
  const queries = [Query.limit(limit), Query.equal("postId", postId)];
  if (lastId) queries.push(Query.cursorAfter(lastId));
  return databases.listDocuments(appwriteConfig.databaseId, appwriteConfig.postsCommentCollectionId, queries);
};

// ─────────────────────────────────────────────────────────────────────────
// Supabase dual-write for post comments / replies on the Appwrite path
// ─────────────────────────────────────────────────────────────────────────
// Mirrors the video-comment dual-write in lib/video-appwrite.js. The
// Appwrite path here only runs for Appwrite-shape posts (the rare half-
// rolled state when USE_SUPABASE_POSTS is half-applied to a feed).
// Most post comments go through addSupabaseComment in the modal and
// don't reach this code at all.
const _UUID_RE_POSTS = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _postIdToSupabaseCache = new Map();
const _profileIdToSupabaseCache = new Map();
const _postCommentIdToSupabaseCache = new Map();
let _supabaseClientForPosts = null;
const _getSupabaseClientForPosts = async () => {
  if (_supabaseClientForPosts) return _supabaseClientForPosts;
  const mod = await import("./supabase");
  _supabaseClientForPosts = mod.default;
  return _supabaseClientForPosts;
};

const resolvePostIdToSupabase = async (rawId) => {
  if (!rawId) return null;
  if (_UUID_RE_POSTS.test(rawId)) return rawId;
  if (_postIdToSupabaseCache.has(rawId)) return _postIdToSupabaseCache.get(rawId);
  const sb = await _getSupabaseClientForPosts();
  const { data, error } = await sb.from("posts").select("id").eq("legacy_appwrite_id", rawId).maybeSingle();
  if (error) {
    console.log("[posts] resolvePostIdToSupabase error:", error.message);
    return null;
  }
  const resolved = data?.id || null;
  if (resolved) _postIdToSupabaseCache.set(rawId, resolved);
  return resolved;
};

const resolveProfileIdToSupabaseForPosts = async (rawId) => {
  if (!rawId) return null;
  if (_UUID_RE_POSTS.test(rawId)) return rawId;
  if (_profileIdToSupabaseCache.has(rawId)) return _profileIdToSupabaseCache.get(rawId);
  const sb = await _getSupabaseClientForPosts();
  const { data, error } = await sb.from("profiles").select("id").eq("legacy_appwrite_id", rawId).maybeSingle();
  if (error) {
    console.log("[posts] resolveProfileIdToSupabase error:", error.message);
    return null;
  }
  const resolved = data?.id || null;
  if (resolved) _profileIdToSupabaseCache.set(rawId, resolved);
  return resolved;
};

const resolvePostCommentIdToSupabase = async (rawId) => {
  if (!rawId) return null;
  if (_UUID_RE_POSTS.test(rawId)) return rawId;
  if (_postCommentIdToSupabaseCache.has(rawId)) return _postCommentIdToSupabaseCache.get(rawId);
  const sb = await _getSupabaseClientForPosts();
  const { data, error } = await sb.from("comments").select("id").eq("legacy_appwrite_id", rawId).maybeSingle();
  if (error) {
    console.log("[posts] resolvePostCommentIdToSupabase error:", error.message);
    return null;
  }
  const resolved = data?.id || null;
  if (resolved) _postCommentIdToSupabaseCache.set(rawId, resolved);
  return resolved;
};

const dualWritePostCommentToSupabase = async ({
  appwriteDocId,
  postAppwriteId,
  ownerAppwriteId,
  body,
  parentSupabaseId,
}) => {
  const [postUuid, ownerUuid] = await Promise.all([
    resolvePostIdToSupabase(postAppwriteId),
    resolveProfileIdToSupabaseForPosts(ownerAppwriteId),
  ]);
  if (!postUuid || !ownerUuid) return null;
  const sb = await _getSupabaseClientForPosts();
  const { data, error } = await sb
    .from("comments")
    .insert({
      user_id: ownerUuid,
      post_id: postUuid,
      parent_id: parentSupabaseId || null,
      body: (body || "").trim(),
      legacy_appwrite_id: appwriteDocId || null,
    })
    .select("id")
    .single();
  if (error) {
    console.log("[posts] dualWritePostCommentToSupabase insert error:", error.message);
    return null;
  }
  if (appwriteDocId && data?.id) _postCommentIdToSupabaseCache.set(appwriteDocId, data.id);
  return data?.id || null;
};

export const createPostComment = async ({ postId, comment, commentOwner }) => {
  // Hotfix (May 2026, USE_SUPABASE_AUTH=true): with no Appwrite session,
  // databases.createDocument 401s with "missing scopes (account)". The
  // dual-write helper already does Appwrite-id → Supabase-id resolution
  // for both the post AND the comment owner, so under AUTH=true we
  // SKIP the Appwrite write entirely and just land the comment on
  // Supabase. Returns an Appwrite-shaped stub so the modal's local
  // list update + hydrate pass continue to work unchanged.
  if (USE_SUPABASE_AUTH) {
    const supabaseCommentId = await dualWritePostCommentToSupabase({
      appwriteDocId: null,            // no Appwrite row exists
      postAppwriteId: postId,         // resolver handles UUID passthrough
      ownerAppwriteId: commentOwner,  // user.$id is already a Supabase UUID under AUTH=true
      body: comment,
      parentSupabaseId: null,
    });
    if (!supabaseCommentId) {
      throw new Error("Could not post comment — post or profile has no Supabase counterpart yet.");
    }
    return {
      $id: supabaseCommentId,
      $createdAt: new Date().toISOString(),
      $updatedAt: new Date().toISOString(),
      postId,
      comment,
      commentOwner,
      commentImage: null,
      postCommentReplies: [],
      postCommentLikes: [],
      // Mark the row Supabase-native so any downstream branch that
      // checks `_supabase` knows to use the Supabase code path.
      _supabase: true,
    };
  }

  const created = await databases.createDocument(appwriteConfig.databaseId, appwriteConfig.postsCommentCollectionId, ID.unique(), {
    postId,
    comment,
    commentOwner,
  });

  // Dual-write to Supabase. Same shape as the video-comment dual-write.
  // This branch only fires when isSupabasePost was false in the modal,
  // i.e. the post was Appwrite-shape. We still try to land the comment
  // in Supabase so web sees it. Resolution failure (post or author has
  // no Supabase counterpart) → skip — best effort.
  try {
    await dualWritePostCommentToSupabase({
      appwriteDocId: created?.$id,
      postAppwriteId: postId,
      ownerAppwriteId: commentOwner,
      body: comment,
      parentSupabaseId: null,
    });
  } catch (sbErr) {
    console.log("[posts] createPostComment Supabase dual-write skipped:", sbErr?.message);
  }

  return created;
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

    // Hotfix (May 2026, USE_SUPABASE_AUTH=true): no Appwrite session
    // means databases.createDocument 401s. Route the like to the
    // Supabase reactions table instead via submit_reaction RPC. The
    // reactions table is the source of truth for likes on web — same
    // path the Supabase-shape comments already use.
    if (USE_SUPABASE_AUTH) {
      const supabaseCommentId = await resolvePostCommentIdToSupabase(commentId);
      if (!supabaseCommentId) {
        console.warn("[posts] createPostCommentLike: comment has no Supabase counterpart, skipping");
        return null;
      }
      // Lazy import to avoid module-load cycle with reactions-supabase.js
      // (which imports posts-supabase.js which imports posts.js).
      const { setReaction } = await import("./reactions-supabase");
      // Default reaction key matches the heart icon the legacy like
      // button rendered. Picker UI sets a different key when used.
      await setReaction({ targetType: "comment", targetId: supabaseCommentId, emoji: "heart" });
      // Return a non-null shape so the caller's "if (!newLike) throw"
      // guard passes. The id isn't read by callers, just truthiness.
      return { $id: `reaction:${supabaseCommentId}`, _supabase: true };
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

    // Hotfix (May 2026, USE_SUPABASE_AUTH=true): same as createPostCommentLike
    // — no Appwrite session means databases.deleteDocument 401s. Route
    // the unlike through the Supabase reactions table.
    if (USE_SUPABASE_AUTH) {
      const supabaseCommentId = await resolvePostCommentIdToSupabase(commentId);
      if (!supabaseCommentId) {
        console.warn("[posts] removePostCommentLike: comment has no Supabase counterpart, skipping");
        return null;
      }
      const { removeMyReaction } = await import("./reactions-supabase");
      await removeMyReaction({ targetType: "comment", targetId: supabaseCommentId });
      return { $id: `reaction:${supabaseCommentId}`, _supabase: true };
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

  // Hotfix (May 2026, USE_SUPABASE_AUTH=true): same as createPostComment —
  // no Appwrite session means databases.createDocument 401s. Skip the
  // Appwrite write, resolve parentCommentId → Supabase UUID, and write
  // the reply directly to Supabase. Returns an Appwrite-shaped stub.
  if (USE_SUPABASE_AUTH) {
    const parentSupabaseId = await resolvePostCommentIdToSupabase(parentCommentId);
    if (!parentSupabaseId) {
      throw new Error("Could not post reply — parent comment has no Supabase counterpart yet.");
    }
    const supabaseReplyId = await dualWritePostCommentToSupabase({
      appwriteDocId: null,
      postAppwriteId: postId,
      ownerAppwriteId: commentOwner,
      body: trimmedComment,
      parentSupabaseId,
    });
    if (!supabaseReplyId) {
      throw new Error("Could not post reply — Supabase write failed.");
    }
    return {
      $id: supabaseReplyId,
      $createdAt: new Date().toISOString(),
      $updatedAt: new Date().toISOString(),
      postId,
      comment: trimmedComment,
      commentOwner,
      commentImage: null,
      // Mark this as a reply so the modal's parent-detection logic finds it.
      postComment: { $id: parentSupabaseId },
      postCommentReplies: [],
      postCommentLikes: [],
      _supabase: true,
    };
  }

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
  let createdReply = null;

  outer: for (const relationKey of POST_COMMENT_PARENT_KEYS) {
    for (const payload of [basePayload, fallbackPayload]) {
      try {
        createdReply = await databases.createDocument(appwriteConfig.databaseId, repliesCollectionId, ID.unique(), {
          ...payload,
          [relationKey]: parentCommentId,
        });
        break outer;
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (!createdReply) {
    throw lastError || new Error("createPostReplyComment failed");
  }

  // Dual-write reply. Same parent-resolution chain as video replies —
  // if the parent isn't in Supabase yet, skip this reply's mirror so we
  // don't orphan it. Backfill (P3) closes the gap on a re-run.
  try {
    const parentSupabaseId = await resolvePostCommentIdToSupabase(parentCommentId);
    if (parentSupabaseId) {
      await dualWritePostCommentToSupabase({
        appwriteDocId: createdReply?.$id,
        postAppwriteId: postId,
        ownerAppwriteId: commentOwner,
        body: trimmedComment,
        parentSupabaseId,
      });
    } else {
      console.log("[posts] reply Supabase dual-write skipped: parent not in Supabase yet");
    }
  } catch (sbErr) {
    console.log("[posts] createPostReplyComment Supabase dual-write skipped:", sbErr?.message);
  }

  return createdReply;
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
