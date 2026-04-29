import { createSlice } from "@reduxjs/toolkit";
import reduxStorage from "../storage";

const CACHE_TTL_MS = 60 * 3000;

const initialState = {
  // byViewerId[viewerId] = { grouped: { [userId]: Story[] }, updatedAt: number }
  byViewerId: {},
};

const storyCacheSlice = createSlice({
  name: "storyCache",
  initialState,
  reducers: {
    setViewerStories(state, action) {
      const { viewerId, grouped } = action.payload || {};
      if (!viewerId || !grouped) return;

      state.byViewerId[viewerId] = {
        grouped,
        updatedAt: Date.now(),
      };
    },
    clearViewerStories(state, action) {
      const viewerId = action.payload;

      if (!viewerId) {
        state.byViewerId = {};
        return;
      }

      // Clear only a specific viewer's cache
      if (state.byViewerId[viewerId]) {
        delete state.byViewerId[viewerId];
      }
    },
  },
});

export const { setViewerStories, clearViewerStories } = storyCacheSlice.actions;
export const storyCacheReducer = storyCacheSlice.reducer;

export const storyCachePersistConfig = {
  key: "storyCache",
  storage: reduxStorage,
  whitelist: ["byViewerId"],
};

export const selectViewerStoryCacheEntry = (state, viewerId) => {
  if (!viewerId) return null;
  return state.storyCache?.byViewerId?.[viewerId] || null;
};

export const isViewerStoryCacheFresh = (entry) => {
  if (!entry) return false;
  const age = Date.now() - entry.updatedAt;
  return age < CACHE_TTL_MS;
};
