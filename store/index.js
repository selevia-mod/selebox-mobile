import { configureStore } from "@reduxjs/toolkit";
import { FLUSH, PAUSE, PERSIST, persistReducer, persistStore, PURGE, REGISTER, REHYDRATE } from "redux-persist";
import { appPersistConfig, appReducer } from "./reducers/app";
import { authPersistConfig, authReducer } from "./reducers/auth";
import { booksPersistConfig, booksReducer } from "./reducers/books";
import { creatorVideosPersistConfig, creatorVideosReducer } from "./reducers/creatorVideos";
import { notificationsPersistConfig, notificationsReducer } from "./reducers/notifications";
import { postPersistConfig, postReducer } from "./reducers/post";
import { storyCachePersistConfig, storyCacheReducer } from "./reducers/story";
import { videosPersistConfig, videosReducer } from "./reducers/videos";

const store = configureStore({
  reducer: {
    auth: persistReducer(authPersistConfig, authReducer),
    books: persistReducer(booksPersistConfig, booksReducer),
    app: persistReducer(appPersistConfig, appReducer),
    storyCache: persistReducer(storyCachePersistConfig, storyCacheReducer),
    post: persistReducer(postPersistConfig, postReducer),
    creatorVideos: persistReducer(creatorVideosPersistConfig, creatorVideosReducer),
    notifications: persistReducer(notificationsPersistConfig, notificationsReducer),
    videos: persistReducer(videosPersistConfig, videosReducer),
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      // Both checks below are dev-only (Redux Toolkit disables them in
      // production), so this config affects developer experience only.
      //
      // The state shape is large: books.* and videos.* each carry 11+ arrays
      // of Appwrite documents, plus posts, notifications, creatorVideos, and
      // storyCache. The default ImmutableStateInvariantMiddleware deep-walks
      // every reducer's state on every dispatch to detect mutations — and
      // that walk was hitting 530ms+ on dispatch, which is exactly the
      // freeze Sele saw on the Books tab. Same story for serializableCheck.
      //
      // Mitigation: ignore the heavy paths. Every slice uses createSlice,
      // which uses Immer internally — mutation is literally impossible
      // through our reducers, so the immutable check on those paths is
      // redundant. We keep the check active on auth and app (smaller
      // slices) so genuine mutation bugs in non-Immer code (e.g. a setUser
      // helper that forgets to spread) still get caught.
      serializableCheck: {
        warnAfter: 512,
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
        ignoredPaths: ["books", "videos", "post", "notifications", "creatorVideos", "storyCache"],
      },
      immutableCheck: {
        warnAfter: 512,
        ignoredPaths: ["books", "videos", "post", "notifications", "creatorVideos", "storyCache"],
      },
    }),
});

export const persistor = persistStore(store);
export default store;
