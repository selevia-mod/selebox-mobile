import { createSlice } from "@reduxjs/toolkit";
import reduxStorage from "../storage";

export const notificationsPersistConfig = {
  key: "notifications",
  storage: reduxStorage,
  whitelist: ["userId", "items", "lastId", "hasMore", "lastFetchedAt"],
};

const initialState = {
  userId: null,
  items: [],
  lastId: null,
  hasMore: true,
  lastFetchedAt: null,
};

const notificationsSlice = createSlice({
  name: "notifications",
  initialState,
  reducers: {
    setNotificationsCache(state, action) {
      const payload = action.payload || {};
      const nextUserId = payload.userId || null;

      if (!nextUserId) {
        return initialState;
      }

      state.userId = nextUserId;
      state.items = Array.isArray(payload.items) ? payload.items : [];
      state.lastId = payload.lastId ?? null;
      state.hasMore = typeof payload.hasMore === "boolean" ? payload.hasMore : true;
      state.lastFetchedAt = Date.now();
    },
    mergeNotificationsCache(state, action) {
      const payload = action.payload || {};
      const nextUserId = payload.userId || null;
      const incoming = Array.isArray(payload.items) ? payload.items : [];

      if (!nextUserId) return;

      if (state.userId && state.userId !== nextUserId) {
        state.userId = nextUserId;
        state.items = incoming;
        state.lastId = payload.lastId ?? null;
        state.hasMore = typeof payload.hasMore === "boolean" ? payload.hasMore : true;
        state.lastFetchedAt = Date.now();
        return;
      }

      if (!state.userId) state.userId = nextUserId;

      if (incoming.length === 0) {
        state.lastFetchedAt = Date.now();
        return;
      }

      const itemMap = new Map(state.items.map((item) => [item.$id, item]));
      const newItems = [];

      incoming.forEach((item) => {
        const existing = itemMap.get(item.$id);
        if (existing) {
          itemMap.set(item.$id, { ...existing, ...item });
        } else {
          newItems.push(item);
        }
      });

      state.items = [...newItems, ...state.items.map((item) => itemMap.get(item.$id) || item)];
      if (payload.lastId) state.lastId = payload.lastId;
      if (typeof payload.hasMore === "boolean") state.hasMore = payload.hasMore;
      state.lastFetchedAt = Date.now();
    },
    markNotificationViewed(state, action) {
      const { userId, notificationId } = action.payload || {};
      if (!notificationId) return;
      if (userId && state.userId && state.userId !== userId) return;
      state.items = state.items.map((item) => (item.$id === notificationId ? { ...item, isViewed: true } : item));
      state.lastFetchedAt = Date.now();
    },
    clearNotificationsCache(state, action) {
      const userId = action.payload;
      if (!userId || state.userId === userId) {
        return initialState;
      }
      return state;
    },
  },
});

export const { setNotificationsCache, mergeNotificationsCache, markNotificationViewed, clearNotificationsCache } =
  notificationsSlice.actions;

export const notificationsReducer = notificationsSlice.reducer;
