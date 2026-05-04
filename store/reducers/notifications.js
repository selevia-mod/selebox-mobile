import { createSlice } from "@reduxjs/toolkit";
import { createTransform } from "redux-persist";
import reduxStorage from "../storage";

// Cap persisted notification rows. Same rationale as post.js — runtime state
// keeps everything; cold-start hydration only restores the most recent 50.
// markAllAsRead etc. cause cascade updates; without throttling, each one was
// re-serializing the full notifications list to MMKV.
const PERSISTED_NOTIFICATIONS_CAP = 50;
const cappedNotificationsTransform = createTransform(
  (inboundState) => {
    if (!inboundState || !Array.isArray(inboundState.items)) return inboundState;
    if (inboundState.items.length <= PERSISTED_NOTIFICATIONS_CAP) return inboundState;
    return { ...inboundState, items: inboundState.items.slice(0, PERSISTED_NOTIFICATIONS_CAP) };
  },
  (outboundState) => outboundState,
  { whitelist: ["notifications"] },
);

export const notificationsPersistConfig = {
  key: "notifications",
  storage: reduxStorage,
  whitelist: ["userId", "items", "lastId", "hasMore", "lastFetchedAt", "dismissedIds"],
  throttle: 1000,
  transforms: [cappedNotificationsTransform],
};

// Cap dismissed-IDs storage so the persisted set doesn't grow unbounded
// across the app's lifetime. 500 is generous — a user dismissing 500
// private DMs without ever clearing app data is a corner case, and the
// keep-most-recent semantics mean older IDs only return if the server
// row also resurrects (which itself implies the user wants to see it).
const DISMISSED_IDS_CAP = 500;

const initialState = {
  userId: null,
  items: [],
  lastId: null,
  hasMore: true,
  lastFetchedAt: null,
  // Notification IDs the user has explicitly dismissed (currently:
  // private-DM tap path). Filtered out at every fetch site so that
  // even if the server-side DELETE was blocked by RLS or otherwise
  // failed silently, the user never sees the row again on this
  // device. The list stays bounded by DISMISSED_IDS_CAP.
  dismissedIds: [],
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
    // Hard-remove a notification from the persisted cache. Used by the
    // private-DM tap path so a row that was tapped doesn't get replayed
    // on the next mount from MMKV. markNotificationViewed only flips
    // isViewed=true, so without this explicit removeNotification action
    // the row reappeared in the bell list whenever the screen remounted
    // — even though the React state had filtered it out.
    //
    // Also stamps the ID into `dismissedIds` so subsequent fetches
    // (Supabase or Appwrite) filter the row out client-side. The
    // server-side DELETE in deleteNotification() may be silently
    // blocked by RLS depending on table policies, and waiting for
    // backend SQL to be deployed is too slow for the OTA — this
    // dismissedIds filter guarantees the user never sees the row
    // again on this device regardless of what the server does.
    removeNotification(state, action) {
      const { userId, notificationId } = action.payload || {};
      if (!notificationId) return;
      if (userId && state.userId && state.userId !== userId) return;
      state.items = state.items.filter((item) => item?.$id !== notificationId);
      const existing = Array.isArray(state.dismissedIds) ? state.dismissedIds : [];
      if (!existing.includes(notificationId)) {
        const next = [notificationId, ...existing];
        state.dismissedIds = next.length > DISMISSED_IDS_CAP ? next.slice(0, DISMISSED_IDS_CAP) : next;
      }
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

export const { setNotificationsCache, mergeNotificationsCache, markNotificationViewed, removeNotification, clearNotificationsCache } = notificationsSlice.actions;

export const notificationsReducer = notificationsSlice.reducer;
