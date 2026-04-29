import { getTrackingPermissionsAsync, PermissionStatus, requestTrackingPermissionsAsync } from "expo-tracking-transparency";
import { createContext, useContext, useEffect, useState } from "react";
import { InteractionManager } from "react-native";
import MobileAds from "react-native-google-mobile-ads";
import { useDispatch, useSelector } from "react-redux";
import { getCurrentUserWithoutStream, getGlobalSettings, getStars, getUserCoins, updateUserExpoPushToken } from "../lib/appwrite";
import { FetchAllClipsLength } from "../lib/clips";
import { setCrashlyticsUser } from "../lib/crashlytics";
import RegisterForPushNotificationsAsync from "../lib/register-push-notifications";
import { setGlobalSettingsReducer } from "../store/reducers/app";
import { setIsLoggedReducer, setUserReducer } from "../store/reducers/auth";

const GlobalContext = createContext();

const isNetworkError = (error) => {
  const message = (error?.message || "").toLowerCase();
  return (
    error?.code === "NETWORK_ERROR" ||
    message.includes("failed to fetch") ||
    message.includes("network request failed") ||
    message.includes("network") ||
    !error?.code
  );
};

// Helper: run a non-critical task after the next interactive frame, with an
// additional delay so it doesn't compete with first-paint work.
const deferredTask = (delayMs, task) => {
  const handle = InteractionManager.runAfterInteractions(() => {
    setTimeout(() => {
      try {
        task();
      } catch (error) {
        console.warn("Deferred task failed:", error?.message || error);
      }
    }, delayMs);
  });
  return () => handle?.cancel?.();
};

export default function GlobalProvider({ children }) {
  const { user: userReducer } = useSelector((state) => state.auth);
  const dispatch = useDispatch();

  const [isLogged, setIsLogged] = useState(null);
  const [user, setUser] = useState(null);
  const [avatar, setAvatar] = useState(null);
  const [balance, setBalance] = useState(null);
  const [allVideos, setAllVideos] = useState([]);
  const [allClips, setAllClips] = useState([]);
  const [allClipsLength, setAllClipsLength] = useState([]);
  const [allCreators, setAllCreators] = useState([]);
  const [globalSettings, setGlobalSettings] = useState({});
  const [expoPushToken, setExpoPushToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [currentChat, setCurrentChat] = useState(false);
  const [starsData, setStarsData] = useState(null);

  // Stream Chat is disabled but components like StreamChatLoader still read
  // streamConnectionState from context. Keep it as a stable "disconnected"
  // value so nothing crashes; will be removed when Phase 7 ports DMs to Supabase.
  const streamConnectionState = "disconnected";
  const setStreamConnectionState = () => {};

  // When user becomes available: keep critical paths immediate (Crashlytics user,
  // balance/stars for topbar pill, avatar) and defer push registration since
  // it's a one-time setup that doesn't affect first paint.
  useEffect(() => {
    setCrashlyticsUser(user);

    if (!user) return;

    // Critical for topbar pill — keep immediate.
    refetchBalance(user?.$id);
    setAvatar(user?.avatar);
    refetchStars();

    // Push notification registration — defer 5s after first paint.
    // Native prompt doesn't need to fire instantly on launch.
    return deferredTask(5000, () => {
      RegisterForPushNotificationsAsync()
        .then((token) => {
          if (token) {
            setExpoPushToken(token);
            updateUserExpoPushToken(user?.$id, token).catch((error) =>
              console.warn("Failed to update push token on server:", error?.message || error),
            );
          }
        })
        .catch((error) => console.warn("Push notification registration failed:", error?.message || error));
    });
  }, [user]);

  // Non-navigation side effects when user is logged in (ads, clip cache).
  // These do NOT need to fire before first paint — defer them.
  useEffect(() => {
    if (isLogged !== true) return;

    // Clips length cache — defer 2s. Used in some UI counters but not for first paint.
    const cancelClipsFetch = deferredTask(2000, () => {
      FetchAllClipsLength(setAllClipsLength).catch((error) => {
        console.warn("FetchAllClipsLength failed:", error?.message || error);
      });
    });

    // AdMob initialization — defer 3s. No ads render in first 3 seconds anyway,
    // and ATT permission prompt doesn't need to interrupt initial flow.
    const cancelAdsInit = deferredTask(3000, async () => {
      try {
        const { status } = await getTrackingPermissionsAsync();
        if (status === PermissionStatus.UNDETERMINED) await requestTrackingPermissionsAsync();
        await MobileAds().initialize();
      } catch (error) {
        console.warn("MobileAds initialization failed:", error?.message || error);
      }
    });

    return () => {
      cancelClipsFetch();
      cancelAdsInit();
    };
  }, [isLogged]);

  useEffect(() => {
    let isMounted = true;

    const bootstrapAuth = async () => {
      // Load global settings (non-blocking).
      getGlobalSettings()
        .then((res) => {
          const settings = {};
          res.forEach((setting) => {
            settings[setting.name] = setting.value;
          });
          if (!isMounted) return;
          setGlobalSettings(settings);
          dispatch(setGlobalSettingsReducer(settings));
        })
        .catch((err) => console.error("Failed to load global settings:", err?.message));

      try {
        const res = await getCurrentUserWithoutStream();
        if (!isMounted) return;

        setUser(res);
        setIsLogged(true);
        dispatch(setUserReducer(res));
        dispatch(setIsLoggedReducer(true));
      } catch (error) {
        console.warn("Auth bootstrap failed:", error?.message);
        if (!isMounted) return;

        if (isNetworkError(error) && userReducer?.$id) {
          // Offline mode: use cached user.
          setUser(userReducer);
          setIsLogged(true);
        } else {
          // Auth failure or no cached data: log out.
          dispatch(setIsLoggedReducer(false));
          setIsLogged(false);
          setUser(null);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    bootstrapAuth();

    return () => {
      isMounted = false;
    };
  }, []);

  const refetchBalance = async (userId) => {
    getUserCoins(userId)
      .then((res) => setBalance(res.coins))
      .catch((error) => console.error(error.message));
  };

  const refetchStars = async () => {
    getStars()
      .then((res) => setStarsData(res))
      .catch((error) => console.error(error.message));
  };

  return (
    <GlobalContext.Provider
      value={{
        loading,
        setLoading,
        isLogged,
        setIsLogged,
        user,
        setUser,
        balance,
        setBalance,
        refetchBalance,
        avatar,
        setAvatar,
        expoPushToken,
        setExpoPushToken,
        allVideos,
        setAllVideos,
        allClips,
        setAllClips,
        allCreators,
        setAllCreators,
        globalSettings,
        setGlobalSettings,
        currentChat,
        setCurrentChat,
        allClipsLength,
        setAllClipsLength,
        starsData,
        refetchStars,
        setStarsData,
        streamConnectionState,
        setStreamConnectionState,
      }}
    >
      {children}
    </GlobalContext.Provider>
  );
}

export const useGlobalContext = () => useContext(GlobalContext);
