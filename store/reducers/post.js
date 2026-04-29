import { createSlice } from "@reduxjs/toolkit";
import reduxStorage from "../storage";

export const postPersistConfig = {
  key: "post",
  storage: reduxStorage,
  whitelist: ["posts", "lastId", "hasMore", "feedUserId", "cachedAt"],
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
