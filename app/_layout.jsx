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
import { LogBox } from "react-native";
import "react-native-gesture-handler";
import { GestureHandlerRootView } from "react-native-gesture-handler";

// Silence the four `defaultProps` deprecation warnings that bubble up
// from inside react-native-render-html v6.x — the library uses old-style
// defaultProps on its function/memo components, which React's runtime
// has been deprecating. Cosmetic only (the preview still renders), but
// the warnings spam the terminal every time RenderHTML mounts.
//
// We pin to the four specific patterns instead of a blanket
// "defaultProps" match so legitimate warnings from our own code still
// surface. Remove these once react-native-render-html v7+ ships with
// JavaScript default-parameter syntax.
LogBox.ignoreLogs([
  "TRenderEngineProvider: Support for defaultProps",
  "MemoizedTNodeRenderer: Support for defaultProps",
  "TNodeChildrenRenderer: Support for defaultProps",
  "bound renderChildren: Support for defaultProps",
]);

// LogBox.ignoreLogs only filters the in-app red overlay; on RN 0.76 the
// Metro terminal still prints the raw `console.error("Warning: …")`
// strings React emits for deprecated patterns. Patch console.error and
// console.warn here so the same four render-html defaultProps lines
// don't spam every time a chapter preview / reader mounts. We match
// against the same substring list as LogBox.ignoreLogs so any new noise
// from our own code still surfaces normally.
const __SILENCED_TERMINAL_WARNINGS__ = [
  "TRenderEngineProvider: Support for defaultProps",
  "MemoizedTNodeRenderer: Support for defaultProps",
  "TNodeChildrenRenderer: Support for defaultProps",
  "bound renderChildren: Support for defaultProps",
];
const __originalConsoleError__ = console.error;
const __originalConsoleWarn__ = console.warn;
const __isSilenced__ = (args) => {
  const first = typeof args?.[0] === "string" ? args[0] : "";
  return __SILENCED_TERMINAL_WARNINGS__.some((needle) => first.includes(needle));
};
console.error = (...args) => {
  if (__isSilenced__(args)) return;
  __originalConsoleError__.apply(console, args);
};
console.warn = (...args) => {
  if (__isSilenced__(args)) return;
  __originalConsoleWarn__.apply(console, args);
};
import { Provider } from "react-redux";
import { PersistGate } from "redux-persist/integration/react";
import { BookStatsProvider } from "../context/book-stats-provider";
// ClipsStatsProvider import removed — clips feature retired May 2026.
import GlobalProvider, { useGlobalContext } from "../context/global-provider";
import { MomentRingsProvider } from "../context/moment-rings-provider";
import { VideosStatsProvider } from "../context/video-stats-provider";
import { isAppwriteAuthError } from "../lib/appwrite";
import { initializeCrashlytics, recordCrashlyticsError } from "../lib/crashlytics";
import { captureReferralFromUrl } from "../lib/referrals";
import "../lib/setup-default-fonts"; // Must be first — patches Text/TextInput for Android font override
import {
  buildBookChapterNotificationNavigationParams,
  buildBookNotificationNavigationParams,
  buildPostNotificationNavigationParams,
  buildVideoNotificationNavigationParams,
} from "../lib/notifications";
import logger from "../lib/utils/logger";
import store, { persistor } from "../store";
import { setIsLoggedReducer } from "../store/reducers/auth";
import { ThemedStatusBar } from "../components";
import ErrorBoundary from "../components/ErrorBoundary";

// Mid-session auth recovery. Detects Appwrite "session gone" errors anywhere
// in the app (failed call buried in a useEffect, unhandled promise rejection,
// etc.) and forces the same logout flow as bootstrap — flips isLogged to
// false, which the InnerLayout effect picks up and redirects to /sign-in.
// Tracked here (not per-call-site) because there are 100+ Appwrite call
// sites and we don't want to wrap every one.
let didDispatchLogoutFromAuthError = false;
const handleRuntimeAuthError = (error, source) => {
  if (didDispatchLogoutFromAuthError) return;
  if (!isAppwriteAuthError(error)) return;
  didDispatchLogoutFromAuthError = true;
  logger.warn("Auth", `Session expired mid-session (${source}) — logging out`);
  try {
    store.dispatch(setIsLoggedReducer(false));
  } catch (dispatchError) {
    logger.error("Auth", "Failed to dispatch logout after auth error", dispatchError);
  }
};

global.Buffer = Buffer;

// Global unhandled promise rejection handler — prevents fatal crashes on Android
if (typeof global !== "undefined") {
  const originalHandler = global.ErrorUtils?.getGlobalHandler?.();
  global.ErrorUtils?.setGlobalHandler?.((error, isFatal) => {
    console.warn("Global error caught:", error);
    handleRuntimeAuthError(error, "globalErrorHandler");
    if (originalHandler) originalHandler(error, isFatal);
  });

  if (typeof Promise !== "undefined") {
    const tracking = require("promise/setimmediate/rejection-tracking");
    tracking.enable({
      allRejections: true,
      onUnhandled: (_id, error) => {
        console.warn("Unhandled promise rejection:", error);
        handleRuntimeAuthError(error, "unhandledRejection");
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

  // Clip notification type retired May 2026. Legacy clip notifications
  // in the inbox quietly fall through to home — the /clips route is now
  // a Reels coming-soon teaser tab so a navigation there would surface
  // an alert rather than usable content.
  if (resolvedType === "clip") {
    return null;
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
    "Poppins-Bold": require("../assets/fonts/Poppins-Bold.ttf"),
    "Poppins-ExtraBold": require("../assets/fonts/Poppins-ExtraBold.ttf"),
    "Poppins-ExtraLight": require("../assets/fonts/Poppins-ExtraLight.ttf"),
    "Poppins-Light": require("../assets/fonts/Poppins-Light.ttf"),
    "Poppins-Medium": require("../assets/fonts/Poppins-Medium.ttf"),
    "Poppins-Regular": require("../assets/fonts/Poppins-Regular.ttf"),
    "Poppins-SemiBold": require("../assets/fonts/Poppins-SemiBold.ttf"),
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
    Linking.getInitialURL().then((url) => {
      setInitialUrl(url);
      // Referral capture — if the launch URL carries `?ref=<code>`,
      // stash it in AsyncStorage so the post-signup hook can redeem
      // it once the new user's profile exists. Best-effort and
      // idempotent: re-launching the app with the same link a second
      // time just overwrites the same stash key.
      void captureReferralFromUrl(url);
    });
    const sub = Linking.addEventListener("url", ({ url }) => {
      setInitialUrl(url);
      void captureReferralFromUrl(url);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    initializeCrashlytics();
  }, []);

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

    setTimeout(() => {
      const { path, queryParams = {} } = Linking.parse(initialUrl);
      let normalizedPath = path?.startsWith("/") ? path.slice(1) : path;
      let bookId;

      // Skip OAuth callback URLs — they should never be routed as content.
      // Supabase's signInWithGoogle uses talesofsiren://books/auth-callback
      // (host=books because that's the only registered intent filter), and
      // the rest of this handler would otherwise treat "auth-callback" as a
      // book ID and push to book-info → "Book Not Found".
      if (normalizedPath === "books/auth-callback" || normalizedPath?.startsWith("auth-callback")) {
        return;
      }

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
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
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
          <Stack.Screen name="(community)" options={{ headerShown: false }} />
        </Stack>
      </ErrorBoundary>
      <ThemedStatusBar />
    </GestureHandlerRootView>
  );
};

// ✅ Wrap with provider
export default function RootLayout() {
  return (
    <Provider store={store}>
      <PersistGate persistor={persistor}>
        <GlobalProvider>
          <BookStatsProvider>
            <VideosStatsProvider>
              <MomentRingsProvider>
                <InnerLayout />
              </MomentRingsProvider>
            </VideosStatsProvider>
          </BookStatsProvider>
        </GlobalProvider>
      </PersistGate>
    </Provider>
  );
}
