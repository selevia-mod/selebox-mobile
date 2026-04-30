import { getTrackingPermissionsAsync, PermissionStatus, requestTrackingPermissionsAsync } from "expo-tracking-transparency";
import { createContext, useContext, useEffect, useState } from "react";
import { InteractionManager } from "react-native";
import MobileAds from "react-native-google-mobile-ads";
import { useDispatch, useSelector } from "react-redux";
import { getCurrentUserWithoutStream, getGlobalSettings, getStars, getUserCoins, updateUserExpoPushToken } from "../lib/appwrite";
import { FetchAllClipsLength } from "../lib/clips";
import { setCrashlyticsUser } from "../lib/crashlytics";
// Phase E.1 — device tier probe. Runs once when the provider mounts so
// the result is cached + readable from anywhere on the synchronous path.
// Importing for side-effect plus the helpers we expose through context.
import { getDeviceTier, getDeviceTierSnapshot } from "../lib/device-tier";
import { USE_SUPABASE_AUTH, USE_SUPABASE_WALLET } from "../lib/feature-flags";
// Phase F.4 — Supabase wallet (coins + stars). When the flag is on,
// the topbar pill, store, and all unlock surfaces read these values.
// Realtime subscription auto-refreshes the pill on any wallet UPDATE.
import { getWallet, resetWalletCaches, subscribeToWallet } from "../lib/wallet-supabase";
// Hotfix — chat broken when Appwrite is the auth source. The chat lib used to
// rely on supabase.auth.getUser(), which is null without a Supabase session.
// We now seed the lib with the resolved Supabase UUID for the current user
// so requireUser() inside messages-supabase.js can answer.
import { setMessagesAppwriteUser } from "../lib/messages-supabase";
import RegisterForPushNotificationsAsync from "../lib/register-push-notifications";
import { getCurrentSupabaseUser, subscribeToAuthChanges } from "../lib/supabase-auth";
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
  // Hotfix — chat needs the Supabase UUID for the current user. When auth
  // is on Appwrite (USE_SUPABASE_AUTH=false, today's prod), `user.$id` is an
  // Appwrite hex ID that won't match `profiles.id` (Supabase UUID). We
  // resolve once and cache here so chat screens can pass the right ID.
  const [chatUserId, setChatUserId] = useState(null);
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

  // Phase E.1 — device tier. Probe synchronously on first render so first
  // paint already knows what to gate (no flicker between "high" defaults
  // and the corrected "low" rendering after a probe completes). The probe
  // is a single read of expo-device's totalMemory + osName so it's cheap
  // enough to run inline. Snapshot is also stored for diagnostics screens
  // that want to show "iPhone 12 · 6.0 GB · high tier".
  const [deviceTier] = useState(() => getDeviceTier());
  const [deviceTierSnapshot] = useState(() => getDeviceTierSnapshot());

  // Stream Chat removed in Phase D. The legacy streamConnectionState shim
  // is gone too — no remaining consumer reads it now that StreamChatLoader
  // and the (message)/messages|chats|thread|*-settings screens have been
  // deleted.

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
    //
    // Capture the user id at scheduling time. If the user signs out during
    // the 5-second deferral window, the closure would otherwise write the
    // token against an account that's no longer the active session — a
    // silent state desync (especially on the Supabase auth path where the
    // ID is a UUID with no validity check on the server-side write).
    const userIdAtSchedule = user?.$id || user?.id;
    return deferredTask(5000, () => {
      // Only proceed if the user is still the same one we scheduled for.
      const stillSameUser = (user?.$id || user?.id) === userIdAtSchedule;
      if (!stillSameUser || !userIdAtSchedule) return;
      RegisterForPushNotificationsAsync()
        .then((token) => {
          if (!token) return;
          setExpoPushToken(token);
          updateUserExpoPushToken(userIdAtSchedule, token).catch((error) =>
            console.warn("Failed to update push token on server:", error?.message || error),
          );
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
    let unsubscribeAuth = null;

    // Global settings — same on both paths, fires immediately, non-blocking.
    const loadGlobalSettings = () => {
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
    };

    // Phase B.4 — Supabase session bootstrap. When the auth flag is on, we
    // read the persisted session from Supabase (AsyncStorage adapter) and
    // subscribe to auth state changes so sign-in / sign-out / token-refresh
    // / recovery flows keep the user state in sync without manual prodding.
    const bootstrapSupabase = async () => {
      try {
        const res = await getCurrentSupabaseUser();
        if (!isMounted) return;
        if (res) {
          setUser(res);
          setIsLogged(true);
          dispatch(setUserReducer(res));
          dispatch(setIsLoggedReducer(true));
        } else {
          dispatch(setIsLoggedReducer(false));
          setIsLogged(false);
          setUser(null);
        }
      } catch (error) {
        console.warn("[supabase-auth] bootstrap failed:", error?.message);
        if (!isMounted) return;
        // On a Supabase bootstrap error, fall back to the cached user from
        // redux-persist if we have one — same offline-tolerance behavior
        // as the Appwrite path. Otherwise, sign out.
        // Offline fallback — accept either Supabase shape (`id`) or the
        // legacy Appwrite-shaped `$id` so we can rehydrate the cached user
        // regardless of which auth path was active when redux-persist
        // last serialized them.
        const cachedId = userReducer?.id || userReducer?.$id;
        if (isNetworkError(error) && cachedId) {
          setUser(userReducer);
          setIsLogged(true);
        } else {
          dispatch(setIsLoggedReducer(false));
          setIsLogged(false);
          setUser(null);
        }
      } finally {
        if (isMounted) setLoading(false);
      }

      // Subscribe to auth state changes for the rest of the app's lifetime.
      // SIGNED_IN / SIGNED_OUT fire on the obvious events; TOKEN_REFRESHED
      // fires every ~hour as Supabase rotates the JWT; PASSWORD_RECOVERY
      // fires after the recovery deep-link puts the user into a recovery
      // session. We re-fetch the hydrated profile on each so any role /
      // bio / avatar update lands without a full app reload.
      unsubscribeAuth = subscribeToAuthChanges(async (event, session) => {
        if (!isMounted) return;
        if (event === "SIGNED_OUT" || !session) {
          setUser(null);
          setIsLogged(false);
          dispatch(setIsLoggedReducer(false));
          return;
        }
        try {
          const res = await getCurrentSupabaseUser();
          if (!isMounted || !res) return;
          setUser(res);
          setIsLogged(true);
          dispatch(setUserReducer(res));
          dispatch(setIsLoggedReducer(true));
        } catch (error) {
          console.warn("[supabase-auth] refresh on auth-change failed:", error?.message);
        }
      });
    };

    // Original Appwrite bootstrap — unchanged byte-for-byte from before
    // Phase B.4. Active whenever USE_SUPABASE_AUTH is false (today's
    // production default).
    const bootstrapAppwrite = async () => {
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

    loadGlobalSettings();
    if (USE_SUPABASE_AUTH) {
      bootstrapSupabase();
    } else {
      bootstrapAppwrite();
    }

    return () => {
      isMounted = false;
      unsubscribeAuth?.();
    };
  }, []);

  const refetchBalance = async (userId) => {
    // Phase F.4 — Supabase wallet read. The wallet row carries BOTH
    // coin_balance and star_balance, so this single call replaces the
    // two legacy reads (getUserCoins + getStars). We update both pieces
    // of state from the same fetch to keep the topbar pill in sync.
    if (USE_SUPABASE_WALLET) {
      try {
        const wallet = await getWallet();
        setBalance(wallet?.coin_balance ?? 0);
        setStarsData((prev) => ({
          ...(prev || {}),
          stars: wallet?.star_balance ?? 0,
        }));
      } catch (error) {
        console.log("[global-provider] Supabase getWallet failed:", error?.message);
      }
      return;
    }
    getUserCoins(userId)
      .then((res) => setBalance(res.coins))
      .catch((error) => console.error(error.message));
  };

  const refetchStars = async () => {
    // Phase F.4 — On Supabase, stars come from the same wallet row
    // refetchBalance already loads. Calling refetchBalance is the
    // canonical refresh path; this stays as a no-op alias so existing
    // callers don't break, and pulls a wallet snapshot if it's the
    // only thing they invoke.
    if (USE_SUPABASE_WALLET) {
      try {
        const wallet = await getWallet();
        setStarsData((prev) => ({
          ...(prev || {}),
          stars: wallet?.star_balance ?? 0,
        }));
      } catch (error) {
        console.log("[global-provider] Supabase getWallet (stars) failed:", error?.message);
      }
      return;
    }
    getStars()
      .then((res) => setStarsData(res))
      .catch((error) => console.error(error.message));
  };

  // Phase F.4 — Realtime wallet subscription. Whenever the user's
  // wallet row updates server-side (after an unlock RPC, a coin
  // top-up purchase, or a star earn), Postgres pushes the new
  // balance and we update local state. Rendering the topbar pill,
  // store, and unlock dialogs all flow off these state hooks so
  // they refresh together.
  //
  // The dep array intentionally includes `USE_SUPABASE_WALLET` so an
  // OTA push that flips the flag re-runs this effect on the next
  // bundle reload — even for users who were already signed in at
  // push time. The flag is a module constant that never changes
  // mid-session, so the inclusion is a no-op for steady-state runs.
  // Also pulls a fresh wallet snapshot the moment we subscribe, so
  // the topbar pill reflects the current balance without waiting for
  // a Postgres CHANGE event.
  useEffect(() => {
    if (!USE_SUPABASE_WALLET) return undefined;
    if (!user?.$id) return undefined;
    let cancelled = false;
    let unsubscribe = null;
    (async () => {
      // Pull a fresh wallet snapshot first — the realtime channel
      // only fires on UPDATEs that happen AFTER subscribe, so we'd
      // miss any change that occurred between sign-in and subscribe.
      try {
        const wallet = await getWallet();
        if (cancelled) return;
        setBalance(wallet?.coin_balance ?? 0);
        setStarsData((prev) => ({ ...(prev || {}), stars: wallet?.star_balance ?? 0 }));
      } catch (error) {
        console.log("[global-provider] initial wallet snapshot failed:", error?.message);
      }
      if (cancelled) return;
      const off = await subscribeToWallet(({ coin_balance, star_balance }) => {
        if (cancelled) return;
        setBalance(coin_balance ?? 0);
        setStarsData((prev) => ({ ...(prev || {}), stars: star_balance ?? 0 }));
      });
      if (cancelled) {
        try {
          off?.();
        } catch (_) {}
      } else {
        unsubscribe = off;
      }
    })();
    return () => {
      cancelled = true;
      try {
        unsubscribe?.();
      } catch (_) {}
      // Reset caches on user change/sign-out so the next user doesn't
      // inherit stale app_config values.
      resetWalletCaches();
    };
    // USE_SUPABASE_WALLET is a module constant that never changes
    // mid-session, but including it makes the effect re-run after an
    // OTA bundle reload that flipped the flag — so already-signed-in
    // users get their realtime subscription seamlessly.
  }, [user?.$id, USE_SUPABASE_WALLET]);

  // Hotfix — keep the chat lib's user cache + the exposed chatUserId in
  // sync with the active auth user. Without this, messages-supabase's
  // requireUser() throws "Not signed in" on every chat operation when
  // running on the Appwrite auth path.
  useEffect(() => {
    let cancelled = false;
    const rawId = user?.id || user?.$id || null;
    if (!rawId) {
      setChatUserId(null);
      setMessagesAppwriteUser(null);
      return undefined;
    }
    (async () => {
      try {
        const resolved = await setMessagesAppwriteUser(rawId);
        if (cancelled) return;
        setChatUserId(resolved || null);
      } catch (error) {
        console.warn("[chat] resolve user failed:", error?.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.$id, user?.id]);

  return (
    <GlobalContext.Provider
      value={{
        loading,
        setLoading,
        isLogged,
        setIsLogged,
        user,
        setUser,
        chatUserId,
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
        // Phase E.1 — device tier ('low' | 'mid' | 'high'). Components
        // reading this via useGlobalContext() get a stable value that
        // doesn't change mid-session, so they can branch in render
        // safely.
        deviceTier,
        deviceTierSnapshot,
      }}
    >
      {children}
    </GlobalContext.Provider>
  );
}

export const useGlobalContext = () => useContext(GlobalContext);
