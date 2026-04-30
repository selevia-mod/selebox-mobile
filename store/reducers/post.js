import { createSlice } from "@reduxjs/toolkit";
import { createTransform } from "redux-persist";
import reduxStorage from "../storage";

// Cap persisted posts so cold-start hydration stays small. Live runtime state
// keeps the full feed; only what's written to MMKV is capped. Without this,
// scrolling 200+ posts means every subsequent dispatch re-serializes the full
// 200-item array. 50 is enough for an instant "above the fold" on relaunch;
// home.jsx will refetch fresher data in the background anyway.
const PERSISTED_POST_CAP = 50;
const cappedPostsTransform = createTransform(
  (inboundState) => {
    if (!inboundState || !Array.isArray(inboundState.posts)) return inboundState;
    if (inboundState.posts.length <= PERSISTED_POST_CAP) return inboundState;
    return { ...inboundState, posts: inboundState.posts.slice(0, PERSISTED_POST_CAP) };
  },
  (outboundState) => outboundState,
  { whitelist: ["post"] },
);

export const postPersistConfig = {
  key: "post",
  storage: reduxStorage,
  whitelist: ["posts", "lastId", "hasMore", "feedUserId", "cachedAt"],
  // 1s write coalescing — like/comment count updates fire fast; without this
  // every reducer call triggers a full slice serialize.
  throttle: 1000,
  transforms: [cappedPostsTransform],
};

const initialState = {
  posts: [],
  lastId: null,
  hasMore: true,
  feedUserId: null,
  cachedAt: null,
  pendingPosts: [],
};

const postSlice = createSlice({
  name: "post",
  initialState,
  reducers: {
    setPost(state, action) {
      state.posts = action.payload.posts;
      state.lastId = action.payload.lastId;
      state.hasMore = action.payload.hasMore;
      state.feedUserId = action.payload.feedUserId ?? null;
      state.cachedAt = action.payload.cachedAt ?? null;
    },
    appendPost(state, action) {
      const nextFeedUserId = action.payload.feedUserId ?? state.feedUserId ?? null;
      const shouldReplacePosts = state.feedUserId && nextFeedUserId && state.feedUserId !== nextFeedUserId;

      state.posts = shouldReplacePosts ? action.payload.posts : [...state.posts, ...action.payload.posts];
      state.lastId = action.payload.lastId;
      state.hasMore = action.payload.hasMore;
      state.feedUserId = nextFeedUserId;
      state.cachedAt = action.payload.cachedAt ?? state.cachedAt;
    },
    addPendingPost(state, action) {
      const { clientId, data } = action.payload || {};
      if (!clientId) return;
      const nextData = {
        ...data,
        clientId,
        clientStatus: data?.clientStatus || "pending",
      };
      state.pendingPosts = [{ clientId, data: nextData }, ...state.pendingPosts.filter((entry) => entry.clientId !== clientId)];
    },
    resolvePendingPost(state, action) {
      const { clientId, data } = action.payload || {};
      if (!clientId) return;
      state.pendingPosts = state.pendingPosts.map((entry) =>
        entry.clientId === clientId
          ? {
              ...entry,
              data: {
                ...entry.data,
                ...data,
                clientStatus: "posted",
              },
            }
          : entry,
      );
    },
    removePendingPost(state, action) {
      const { clientId, postId } = action.payload || {};
      if (!clientId && !postId) return;
      state.pendingPosts = state.pendingPosts.filter((entry) => {
        if (clientId && entry.clientId === clientId) return false;
        if (postId && entry.data?.$id === postId) return false;
        return true;
      });
    },
    clearPost(state) {
      state.posts = [];
      state.lastId = null;
      state.hasMore = true;
      state.feedUserId = null;
      state.cachedAt = null;
      state.pendingPosts = [];
    },
  },
});

export const { setPost, appendPost, addPendingPost, resolvePendingPost, removePendingPost, clearPost } = postSlice.actions;

export const postReducer = postSlice.reducer;
