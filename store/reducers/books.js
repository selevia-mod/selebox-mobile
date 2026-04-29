import { createSlice } from "@reduxjs/toolkit";
import reduxStorage from "../storage";

export const booksPersistConfig = {
  key: "books",
  storage: reduxStorage,
  whitelist: [
    "weeklyFeatured",
    "freshRead",
    "completedExcellent",
    "continueReading",
    "recentlyUploaded",
    "categories",
    "ranking",
    "rankingCacheByTag",
    "library",
    "localDrafts",
    "lastFetchedAt",
    "userBooks",
  ],
};

const initialState = {
  weeklyFeatured: [],
  freshRead: [],
  completedExcellent: [],
  continueReading: [],
  recentlyUploaded: [],
  categories: {}, // key = category name
  ranking: [],
  rankingCacheByTag: {},
  rankingOffset: null,
  rankingHasMore: false,
  library: [],
  libraryLastId: null,
  libraryHasMore: false,
  localDrafts: {},
  lastFetchedAt: null,
  userBooks: [],
};

const booksSlice = createSlice({
  name: "books",
  initialState,
  reducers: {
    setWeeklyFeatured: (state, action) => {
      state.weeklyFeatured = action.payload;
    },
    setFreshRead: (state, action) => {
      state.freshRead = action.payload;
    },
    setCompletedExcellent: (state, action) => {
      state.completedExcellent = action.payload;
    },
    setContinueReading: (state, action) => {
      state.continueReading = action.payload;
    },
    setRecentlyUploaded: (state, action) => {
      state.recentlyUploaded = action.payload;
    },
    setCategoryBooks: (state, action) => {
      const { category, books } = action.payload;
      state.categories[category] = books;
    },
    setRanking: (state, action) => {
      state.ranking = action.payload;
    },
    setRankingCacheEntry: (state, action) => {
      const { tagKey, items = [], hasMore = false, fetchedAt = null, statsHydratedAt = null } = action.payload || {};
      if (!tagKey) return;

      state.rankingCacheByTag[tagKey] = {
        items: Array.isArray(items) ? items : [],
        hasMore: Boolean(hasMore),
        fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
        statsHydratedAt: Number.isFinite(statsHydratedAt) ? statsHydratedAt : null,
      };
    },
    setRankingOffset: (state, action) => {
      state.rankingOffset = action.payload;
    },
    setRankingHasMore: (state, action) => {
      state.rankingHasMore = action.payload;
    },
    setLibrary: (state, action) => {
      state.library = action.payload;
    },
    setLibraryLastId: (state, action) => {
      state.libraryLastId = action.payload;
    },
    setLibraryHasMore: (state, action) => {
      state.libraryHasMore = action.payload;
    },
    appendLibrary: (state, action) => {
      state.library = [...state.library, action.payload];
    },
    setUserBooks: (state, action) => {
      state.userBooks = action.payload;
    },
    appendUserBooks: (state, action) => {
      state.userBooks = [...state.userBooks, action.payload];
    },
    upsertLocalDraft: (state, action) => {
      const { key, draft } = action.payload || {};
      if (!key) return;
      state.localDrafts[key] = draft;
    },
    removeLocalDraft: (state, action) => {
      const key = action.payload;
      if (!key) return;
      delete state.localDrafts[key];
    },
    clearLocalDrafts: (state) => {
      state.localDrafts = {};
    },
    setLastFetchedAt: (state, action) => {
      state.lastFetchedAt = action.payload;
    },
    clearBooks: () => {
      return initialState;
    },
  },
});

export const {
  setWeeklyFeatured,
  setFreshRead,
  setCompletedExcellent,
  setContinueReading,
  setRecentlyUploaded,
  setCategoryBooks,
  setRanking,
  setRankingCacheEntry,
  setRankingOffset,
  setRankingHasMore,
  setLibrary,
  setLibraryLastId,
  setLibraryHasMore,
  appendLibrary,
  upsertLocalDraft,
  removeLocalDraft,
  clearLocalDrafts,
  setLastFetchedAt,
  setUserBooks,
  appendUserBooks,
  clearBooks,
} = booksSlice.actions;

export const booksReducer = booksSlice.reducer;
