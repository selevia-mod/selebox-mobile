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
      serializableCheck: {
        warnAfter: 512,
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
      immutableCheck: { warnAfter: 512 },
    }),
});

export const persistor = persistStore(store);
export default store;
