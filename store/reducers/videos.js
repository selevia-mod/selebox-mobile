import { createSlice } from "@reduxjs/toolkit";
import reduxStorage from "../storage";

export const downloadQuality = {
  askEachTime: "Ask each time",
  hd720p: "HD (720p)",
  std480p: "Standard (480p)",
  dataSaver360p: "Data Saver (360p)",
};

export const videosPersistConfig = {
  key: "videos",
  storage: reduxStorage,
  whitelist: [
    "baseVideos",
    "audiobookSectionsCacheVersion",
    "audiobookSectionsLimit",
    "mostPeopleWant",
    "fromFollowing",
    "fromFollowingCacheVersion",
    "fromFollowingUserId",
    "suggestedForYou",
    "continueWatching",
    "trendingWeek",
    "youMightLike",
    "popularInYourArea",
    "latestVideos",
    "categoryVideos",
    "downloadedVideos",
    "downloadSettings",
    "lastFetchedAt",
  ],
};

const mergeDownloadedVideoEntries = (existingEntries = [], completedEntries = []) => {
  const mergedById = new Map();

  for (const entry of existingEntries) {
    const id = entry?.id || entry?.videoId || entry?.video?.$id || entry?.video?.uri;
    if (!id) continue;
    mergedById.set(id, { ...entry, id });
  }

  for (const entry of completedEntries) {
    const id = entry?.id || entry?.videoId || entry?.video?.$id || entry?.video?.uri;
    if (!id) continue;
    mergedById.set(id, { ...mergedById.get(id), ...entry, id });
  }

  return Array.from(mergedById.values()).filter(Boolean);
};

const syncDownloadedVideos = (state) => {
  const completedEntries = (state.videoDownloads || [])
    .filter((entry) => entry?.status === "completed")
    .map((entry) => ({ ...entry }))
    .filter(Boolean);

  state.downloadedVideos = mergeDownloadedVideoEntries(state.downloadedVideos || [], completedEntries);
};

const upsertVideoDownloadEntry = (state, payload) => {
  if (!payload) return;
  const id = payload.id || payload.videoId || payload.video?.$id || payload.video?.uri;
  if (!id) return;

  const nextEntry = {
    ...payload,
    id,
    updatedAt: payload.updatedAt || Date.now(),
  };

  const existingIndex = (state.videoDownloads || []).findIndex((entry) => entry?.id === id);
  const previousStatus = existingIndex >= 0 ? state.videoDownloads[existingIndex]?.status : null;
  if (existingIndex >= 0) {
    state.videoDownloads[existingIndex] = {
      ...state.videoDownloads[existingIndex],
      ...nextEntry,
      video: nextEntry.video || state.videoDownloads[existingIndex]?.video,
    };
  } else {
    state.videoDownloads = [nextEntry, ...(state.videoDownloads || [])];
  }

  if (nextEntry.status === "completed" || previousStatus === "completed") {
    syncDownloadedVideos(state);
  }
};

const initialState = {
  baseVideos: [],
  audiobookSectionsCacheVersion: null,
  audiobookSectionsLimit: null,
  mostPeopleWant: [],
  fromFollowing: [],
  fromFollowingCacheVersion: null,
  fromFollowingUserId: null,
  suggestedForYou: [],
  continueWatching: [],
  trendingWeek: [],
  youMightLike: [],
  popularInYourArea: [],
  latestVideos: [],
  categoryVideos: {},
  downloadedVideos: [],
  videoDownloads: [],
  downloadSettings: {
    quality: downloadQuality.askEachTime,
    wifiOnly: true,
  },
  lastFetchedAt: null,
};

const videosSlice = createSlice({
  name: "videos",
  initialState,
  reducers: {
    setVideosCache: (state, action) => {
      return { ...state, ...action.payload };
    },
    setDownloadedVideos: (state, action) => {
      upsertVideoDownloadEntry(state, {
        id: action.payload?.$id || action.payload?.uri,
        videoId: action.payload?.$id,
        status: "completed",
        progress: 1,
        video: action.payload,
        createdAt: Date.now(),
      });
    },
    upsertVideoDownload: (state, action) => {
      upsertVideoDownloadEntry(state, action.payload);
    },
    removeVideoDownload: (state, action) => {
      const id = action.payload;
      state.videoDownloads = (state.videoDownloads || []).filter((entry) => entry?.id !== id);
      state.downloadedVideos = (state.downloadedVideos || []).filter(
        (entry) => entry?.id !== id && entry?.videoId !== id && entry?.video?.$id !== id,
      );
      syncDownloadedVideos(state);
    },
    clearVideoDownloads: (state) => {
      state.videoDownloads = [];
      state.downloadedVideos = [];
    },
    setDownloadSettings: (state, action) => {
      const { settings, value } = action.payload;
      return {
        ...state,
        downloadSettings: {
          ...state.downloadSettings,
          [settings]: value,
        },
      };
    },
    clearVideosCache: () => {
      return initialState;
    },
  },
});

export const {
  setVideosCache,
  setDownloadedVideos,
  upsertVideoDownload,
  removeVideoDownload,
  clearVideoDownloads,
  setDownloadSettings,
  clearVideosCache,
} = videosSlice.actions;
export const videosReducer = videosSlice.reducer;
