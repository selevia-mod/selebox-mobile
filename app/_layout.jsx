import { CommonActions, useNavigation } from "@react-navigation/native";
import { Buffer } from "buffer";
import { useFonts } from "expo-font";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { Stack, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as Updates from "expo-updates";
import { NativeWindStyleSheet } from "nativewind";
import { useCallback, useEffect, useRef, useState } from "react";
import "react-native-gesture-handler";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Provider } from "react-redux";
import { PersistGate } from "redux-persist/integration/react";
import { Chat, OverlayProvider } from "stream-chat-expo";
import { BookStatsProvider } from "../context/book-stats-provider";
import { ClipsStatsProvider } from "../context/clip-stats-provider";
import GlobalProvider, { useGlobalContext } from "../context/global-provider";
import { VideosStatsProvider } from "../context/video-stats-provider";
import { initializeCrashlytics, recordCrashlyticsError } from "../lib/crashlytics";
import "../lib/setup-default-fonts"; // Must be first — patches Text/TextInput for Android font override
import {
  buildBookChapterNotificationNavigationParams,
  buildBookNotificationNavigationParams,
  buildPostNotificationNavigationParams,
  buildVideoNotificationNavigationParams,
} from "../lib/notifications";
import { streamClient } from "../lib/stream";
import store, { persistor } from "../store";
import { ThemedStatusBar } from "../components";

global.Buffer = Buffer;

// Global unhandled promise rejection handler — prevents fatal crashes on Android
if (typeof global !== "undefined") {
  const originalHandler = global.ErrorUtils?.getGlobalHandler?.();
  global.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
    console.warn("Global error caught:", error);
    if (originalHandler) originalHandler(error, isFatal);
  });

  if (typeof Promise !== "undefined") {
    const tracking = require("promise/setimmediate/rejection-tracking");
    tracking.enable({
      allRejections: true,
      onUnhandled: (_id, error) => {
        console.warn("Unhandled promise rejection:", error);
        recordCrashlyticsError(error, "Unhandled promise rejection");
      },
      onHandled: () => {},
    });
  }
}

NativeWindStyleSheet.setOutput({ default: "native" });
SplashScreen.preventAutoHideAsync();

const normalizeRouteValue = (value) => {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
};

const resolveNotificationRouteFromPayload = (payload = {}) => {
  const data = payload?.notification?.request?.content?.data || payload;
  if (!data || typeof data !== "object") return null;
  const resolvedType = typeof data?.type === "string" ? data.type.toLowerCase() : "";

  const videoFocusFromPayload = data?.notificationVideoFocus || {};
  const postFocusFromPayload = data?.notificationPostFocus || {};
  const bookFocusFromPayload = data?.notificationBookFocus || {};
  const bookChapterFocusFromPayload = data?.notificationBookChapterFocus || {};

  const videoRoute = buildVideoNotificationNavigationParams({
    type: data.type,
    resourceId: data.resourceId || data.videoId || data.video || data.docId || data.id,
    focusCommentId: data.focusCommentId || data.commentId || videoFocusFromPayload.commentId,
    focusReplyId: data.focusReplyId || data.replyId || videoFocusFromPayload.replyId,
  });

  if (videoRoute) return videoRoute;

  const postRoute = buildPostNotificationNavigationParams({
    type: data.type,
    resourceId: data.resourceId || data.postId || data.post || data.id,
    postId: data.postId || data.post || postFocusFromPayload.postId,
    focusCommentId: data.focusCommentId || data.commentId || postFocusFromPayload.commentId,
    focusReplyId: data.focusReplyId || data.replyId || postFocusFromPayload.replyId,
  });

  if (postRoute) return postRoute;

  const bookRoute = buildBookNotificationNavigationParams({
    type: data.type,
    resourceId: data.resourceId || data.bookId || data.book || data.id,
    bookId: data.bookId || data.book || bookFocusFromPayload.bookId,
    focusCommentId: data.focusCommentId || data.commentId || bookFocusFromPayload.commentId,
    focusReplyId: data.focusReplyId || data.replyId || bookFocusFromPayload.replyId,
  });

  if (bookRoute) return bookRoute;

  const bookChapterRoute = buildBookChapterNotificationNavigationParams({
    type: data.type,
    resourceId: data.resourceId || data.chapterId || data.chapter || data.id,
    chapterId: data.chapterId || data.chapter || bookChapterFocusFromPayload.chapterId,
    focusCommentId: data.focusCommentId || data.commentId || bookChapterFocusFromPayload.commentId,
    focusReplyId: data.focusReplyId || data.replyId || bookChapterFocusFromPayload.replyId,
  });

  if (bookChapterRoute) return bookChapterRoute;

  if (resolvedType === "video-upload") {
    return { pathname: "/creator-section" };
  }

  if (resolvedType === "follow" && data.resourceId) {
    return { pathname: "/creator-profile", params: { userId: data.resourceId } };
  }

  if (resolvedType === "book" && data.resourceId) {
    return { pathname: "/book-info", params: { bookId: data.resourceId } };
  }

  if (resolvedType === "clip") {
    return { pathname: "/clips" };
  }

  return null;
};

const InnerLayout = () => {
  const router = useRouter();
  const navigation = useNavigation();
  const { isLogged } = useGlobalContext();
  const [initialized, setInitialized] = useState(false);
  const [initialUrl, setInitialUrl] = useState(null);
  const pendingNotificationRouteRef = useRef(null);
  const handledNotificationResponseRef = useRef(null);

  const [fontsLoaded] = useFonts({
    "Poppins-Black": require("../assets/fonts/Poppins-Black.ttf"),
    "Poppins-Bold": require("../assets/fonts/Poppins-Bold.ttf"),
    "Poppins-ExtraBold": require("../assets/fonts/Poppins-ExtraBold.ttf"),
    "Poppins-ExtraLight": require("../assets/fonts/Poppins-ExtraLight.ttf"),
    "Poppins-Light": require("../assets/fonts/Poppins-Light.ttf"),
    "Poppins-Medium": require("../assets/fonts/Poppins-Medium.ttf"),
    "Poppins-Regular": require("../assets/fonts/Poppins-Regular.ttf"),
    "Poppins-SemiBold": require("../assets/fonts/Poppins-SemiBold.ttf"),
    "Poppins-Thin": require("../assets/fonts/Poppins-Thin.ttf"),
    "Inter-Thin": require("../assets/fonts/Inter-Thin.ttf"),
    "Inter-ExtraLight": require("../assets/fonts/Inter-ExtraLight.ttf"),
    "Inter-Light": require("../assets/fonts/Inter-Light.ttf"),
    "Inter-Regular": require("../assets/fonts/Inter-Regular.ttf"),
    "Inter-Medium": require("../assets/fonts/Inter-Medium.ttf"),
    "Inter-SemiBold": require("../assets/fonts/Inter-SemiBold.ttf"),
    "Inter-Bold": require("../assets/fonts/Inter-Bold.ttf"),
    "Inter-ExtraBold": require("../assets/fonts/Inter-ExtraBold.ttf"),
    "Inter-Black": require("../assets/fonts/Inter-Black.ttf"),
  });

  // Handle deep linking
  useEffect(() => {
    Linking.getInitialURL().then(setInitialUrl);
    const sub = Linking.addEventListener("url", ({ url }) => setInitialUrl(url));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    initializeCrashlytics();
  }, []);

  // Android back uses default behavior (system + navigation handling)

  // Hide splash once fonts are ready, then check for OTA updates in background
  useEffect(() => {
    const bootstrapApp = async () => {
      if (!fontsLoaded) return;

      await SplashScreen.hideAsync();

      if (__DEV__) return;

      try {
        const update = await Updates.checkForUpdateAsync();
        console.log("Update", update);

        if (!update.isAvailable) return;

        // Check if this is a test update (flag embedded by app.config.js via env var)
        const isTestUpdate = update.manifest?.extra?.expoClient?.extra?.isTestUpdate;

        if (isTestUpdate) {
          const user = store.getState().auth?.user;
          if (!user?.isTester) {
            console.log("Skipping test OTA update - user is not a tester");
            return;
          }
        }

        await Updates.fetchUpdateAsync();
        await Updates.reloadAsync();
      } catch (error) {
        console.log("Silent OTA update failed:", error);
      }
    };

    bootstrapApp();
  }, [fontsLoaded]);

  // Handle auth-based navigation — only after fonts loaded (Stack is mounted)
  useEffect(() => {
    if (!fontsLoaded) return; // Stack not mounted yet
    if (isLogged === null) return; // Auth not resolved yet

    if (isLogged === true) {
      router.replace("/home");
      setTimeout(() => setInitialized(true), 300);
    } else if (isLogged === false) {
      try {
        navigation.dispatch(
          CommonActions.reset({
            index: 0,
            routes: [
              {
                name: "(auth)",
                state: {
                  routes: [{ name: "sign-in" }],
                },
              },
            ],
          }),
        );
      } catch (resetError) {
        console.warn("Navigation reset failed, using router fallback:", resetError);
        router.replace("/sign-in");
      }
    }
  }, [fontsLoaded, isLogged]);

  const handleNotificationRoute = useCallback(
    (response) => {
      const notificationRoute = resolveNotificationRouteFromPayload(response);
      if (!notificationRoute) return;

      const responseId = response?.notification?.request?.identifier || JSON.stringify(response?.notification?.request?.content?.data || response);
      if (responseId && handledNotificationResponseRef.current === responseId) return;

      handledNotificationResponseRef.current = responseId;

      if (!initialized || !isLogged) {
        pendingNotificationRouteRef.current = notificationRoute;
        return;
      }

      router.push(notificationRoute);
    },
    [initialized, isLogged, router],
  );

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      handleNotificationRoute(response);
    });

    (async () => {
      try {
        const lastResponse = await Notifications.getLastNotificationResponseAsync();
        handleNotificationRoute(lastResponse);
      } catch (error) {
        console.warn("Failed to read last notification response:", error);
      }
    })();

    return () => {
      subscription.remove();
    };
  }, [handleNotificationRoute]);

  useEffect(() => {
    if (!initialized || !isLogged) return;
    if (!pendingNotificationRouteRef.current) return;

    const route = pendingNotificationRouteRef.current;
    pendingNotificationRouteRef.current = null;
    router.push(route);
  }, [initialized, isLogged, router]);

  // Handle deep link only after app init + login state resolved
  useEffect(() => {
    if (!initialized || !initialUrl || !isLogged) return;

    // Navigate to deep link after short delay
    setTimeout(() => {
      const { path, queryParams = {} } = Linking.parse(initialUrl);
      let normalizedPath = path?.startsWith("/") ? path.slice(1) : path;
      let bookId;

      const queryType = normalizeRouteValue(queryParams.type);
      const queryResourceId = normalizeRouteValue(
        queryParams.resourceId || queryParams.videoId || queryParams.video || queryParams.postId || queryParams.post || queryParams.id,
      );
      const queryDocId = normalizeRouteValue(queryParams.docId || queryParams.doc);
      const queryCommentId = normalizeRouteValue(queryParams.focusCommentId || queryParams.commentId || queryParams.comment);
      const queryReplyId = normalizeRouteValue(queryParams.focusReplyId || queryParams.replyId);

      const videoPathMatch = normalizedPath?.match(/^videos\/([^/]+)(?:\/comment\/([^/]+)(?:\/reply\/([^/]+))?)?$/);
      const videoPathType = videoPathMatch
        ? videoPathMatch[3]
          ? "video-reply"
          : videoPathMatch[2]
            ? "video-comment"
            : queryType || "video"
        : queryType;
      const directVideoRoute =
        buildVideoNotificationNavigationParams({
          type: videoPathType,
          resourceId: videoPathMatch ? videoPathMatch[1] : queryResourceId,
          focusCommentId: queryCommentId || videoPathMatch?.[2],
          focusReplyId: queryReplyId || videoPathMatch?.[3],
          docId: queryDocId,
        }) || null;

      if (directVideoRoute) {
        router.push(directVideoRoute);
        return;
      }

      const postPathMatch = normalizedPath?.match(/^posts\/([^/]+)(?:\/comment\/([^/]+)(?:\/reply\/([^/]+))?)?$/);
      const postPathType = postPathMatch ? (postPathMatch[3] ? "post-reply" : postPathMatch[2] ? "post-comment" : queryType || "post") : queryType;
      const directPostRoute =
        buildPostNotificationNavigationParams({
          type: postPathType,
          resourceId: postPathMatch ? postPathMatch[1] : queryResourceId,
          postId: normalizeRouteValue(queryParams.postId || queryParams.post),
          focusCommentId: queryCommentId || postPathMatch?.[2],
          focusReplyId: queryReplyId || postPathMatch?.[3],
        }) || null;

      if (directPostRoute) {
        router.push(directPostRoute);
        return;
      }

      const bookPathMatch = normalizedPath?.match(/^books\/([^/]+)(?:\/comment\/([^/]+)(?:\/reply\/([^/]+))?)?$/);
      const bookPathType = bookPathMatch ? (bookPathMatch[3] ? "book-reply" : bookPathMatch[2] ? "book-comment" : queryType || "book") : queryType;
      const directBookRoute =
        buildBookNotificationNavigationParams({
          type: bookPathType,
          resourceId: bookPathMatch ? bookPathMatch[1] : queryResourceId || normalizeRouteValue(queryParams.bookId || queryParams.book),
          bookId: normalizeRouteValue(queryParams.bookId || queryParams.book),
          focusCommentId: queryCommentId || bookPathMatch?.[2],
          focusReplyId: queryReplyId || bookPathMatch?.[3],
        }) || null;

      if (directBookRoute) {
        router.push(directBookRoute);
        return;
      }

      if (normalizedPath) {
        const match = normalizedPath.match(/^books\/([a-zA-Z0-9]+)$/);
        if (match) {
          bookId = match[1];
        } else {
          bookId = normalizedPath;
        }
      }
      if (!bookId && queryParams?.bookId) {
        bookId = queryParams.bookId;
      }

      if (bookId) {
        router.push({ pathname: "/(book)/book-info", params: { bookId } });
      }
    }, 500);

    setInitialUrl(null); // reset
  }, [initialized, isLogged, initialUrl]);

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView>
      <OverlayProvider
        value={{
          style: {
            channelPreview: {
              container: {
                backgroundColor: "#111827",
                borderBottomWidth: 1,
                borderBottomColor: "#374151",
              },
              title: {
                color: "#fff",
              },
              avatar: {
                size: 45,
              },
            },
            messageList: {
              container: {
                backgroundColor: "#111827",
              },
              inlineUnreadIndicator: {
                container: {
                  backgroundColor: "#1f2937",
                },
              },
            },
            messageInput: {
              container: {
                backgroundColor: "#1f2937",
                borderTopWidth: 1,
                borderColor: "#374151",
              },
              inputBoxContainer: {
                backgroundColor: "#111827",
                borderColor: "#374151",
              },
              inputBox: {
                color: "#fff",
              },
              editingStateHeader: {
                editingBoxHeaderTitle: {
                  color: "#fff",
                },
              },
            },
            channelListSkeleton: {
              background: {
                backgroundColor: "#111827",
              },
              container: {
                borderBottomColor: "#374151",
              },
              animationTime: 1000,
              gradientStop: {
                stopColor: "#4d179a",
              },
            },
          },
        }}
      >
        <Chat client={streamClient}>
          <Stack screenOptions={{ animation: "none" }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="(video)" options={{ headerShown: false }} />
            <Stack.Screen name="(edit)" options={{ headerShown: false }} />
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="search" options={{ headerShown: false }} />
            <Stack.Screen name="(store)" options={{ headerShown: false }} />
            <Stack.Screen name="(studio)" options={{ headerShown: false }} />
            <Stack.Screen name="(profile)" options={{ headerShown: false }} />
            <Stack.Screen name="(post)" options={{ headerShown: false }} />
            <Stack.Screen name="(message)" options={{ headerShown: false }} />
            <Stack.Screen name="(notification)" options={{ headerShown: false }} />
            <Stack.Screen name="(book)" options={{ headerShown: false }} />
            <Stack.Screen name="(payments)" options={{ headerShown: false }} />
            <Stack.Screen name="books" options={{ headerShown: false }} />
            <Stack.Screen name="(story)" options={{ headerShown: false }} />
          </Stack>
          <ThemedStatusBar />
        </Chat>
      </OverlayProvider>
    </GestureHandlerRootView>
  );
};

// ✅ Wrap with provider
export default function RootLayout() {
  return (
    <Provider store={store}>
      <PersistGate persistor={persistor}>
        <GlobalProvider>
          <ClipsStatsProvider>
            <BookStatsProvider>
              <VideosStatsProvider>
                <InnerLayout />
              </VideosStatsProvider>
            </BookStatsProvider>
          </ClipsStatsProvider>
        </GlobalProvider>
      </PersistGate>
    </Provider>
  );
}
