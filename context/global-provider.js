import { getTrackingPermissionsAsync, PermissionStatus, requestTrackingPermissionsAsync } from "expo-tracking-transparency";
import { createContext, useContext, useEffect, useState } from "react";
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
  const [streamConnectionState, setStreamConnectionState] = useState("disconnected");

  useEffect(() => {
    setCrashlyticsUser(user);

    if (user) {
      refetchBalance(user?.$id);
      setAvatar(user?.avatar);
      refetchStars();
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
    }
  }, [user]);

  // Non-navigation side effects when user logs in (data fetching, ads)
  useEffect(() => {
    if (isLogged !== true) return;

    FetchAllClipsLength(setAllClipsLength).catch((error) => {
      console.warn("FetchAllClipsLength failed:", error?.message || error);
    });

    (async () => {
      try {
        const { status } = await getTrackingPermissionsAsync();
        if (status === PermissionStatus.UNDETERMINED) await requestTrackingPermissionsAsync();
        await MobileAds().initialize();
      } catch (error) {
        console.warn("MobileAds initialization failed:", error?.message || error);
      }
    })();
  }, [isLogged]);

  useEffect(() => {
    let isMounted = true;

    const bootstrapAuth = async () => {
      // Load global settings (non-blocking)
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

        // Connect Stream Chat in background (non-blocking)
        // streamConnectionManager
        //   .connect(res.$id)
        //   .then(() => isMounted && setStreamConnectionState("connected"))
        //   .catch((err) => {
        //     console.error("Stream connection failed:", err?.message);
        //     if (isMounted) setStreamConnectionState("error");
        //   });
      } catch (error) {
        console.warn("Auth bootstrap failed:", error?.message);
        if (!isMounted) return;

        if (isNetworkError(error) && userReducer?.$id) {
          // Offline mode: use cached user
          setUser(userReducer);
          setIsLogged(true);
        } else {
          // Auth failure or no cached data: log out
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
