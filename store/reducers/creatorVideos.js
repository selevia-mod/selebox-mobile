import { createSlice } from "@reduxjs/toolkit";
import reduxStorage from "../storage";

export const creatorVideosPersistConfig = {
  key: "creatorVideos",
  storage: reduxStorage,
  whitelist: ["videos", "lastId", "hasMore"],
};

const initialState = {
  videos: [],
  lastId: null,
  hasMore: true,
};

const creatorVideosSlice = createSlice({
  name: "creatorVideos",
  initialState,
  reducers: {
    setCreatorVideos(state, action) {
      const { videos, lastId, hasMore } = action.payload;
      state.videos = videos;
      state.lastId = lastId;
      state.hasMore = hasMore;
    },

    appendCreatorVideos(state, action) {
      const { videos, lastId, hasMore } = action.payload;

      const map = new Map();
      [...state.videos, ...videos].forEach((v) => map.set(v.$id, v));

      state.videos = [...map.values()];
      state.lastId = lastId;
      state.hasMore = hasMore;
    },

    updateCreatorVideo(state, action) {
      const updated = action.payload;
      state.videos = state.videos.map((v) => (v.$id === updated.$id ? { ...v, ...updated } : v));
    },

    removeCreatorVideo(state, action) {
      state.videos = state.videos.filter((v) => v.$id !== action.payload);
    },

    clearCreatorVideos(state) {
      state.videos = [];
      state.lastId = null;
      state.hasMore = true;
    },
  },
});

export const { setCreatorVideos, appendCreatorVideos, updateCreatorVideo, removeCreatorVideo, clearCreatorVideos } = creatorVideosSlice.actions;

export const creatorVideosReducer = creatorVideosSlice.reducer;
