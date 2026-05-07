import { FontAwesome, MaterialIcons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useDispatch, useSelector } from "react-redux";
import { NotificationCard } from "../../components";
import AnimatedSkeleton, { getRandomSkeletonWidth } from "../../components/AnimatedSkeleton";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import useResetOnBlur from "../../hooks/useResetOnBlur";
import { NotificationService } from "../../lib/notifications";
import {
  loadDmNotifications,
  markAllDmNotificationsRead,
  subscribeToDmNotifications,
} from "../../lib/notifications-supabase";
import { markNotificationViewed, removeNotification, setNotificationsCache } from "../../store/reducers/notifications";

// Categorize a notification into the All / You / Following tabs.
// "you" = something happened TO you (someone followed you, commented on
// your content, replied to your comment, sent you a DM, etc.)
// "following" = someone you follow CREATED something (new video, new clip)
const categorizeNotification = (notification) => {
  const type = (notification?.type || "").toLowerCase();
  if (!type) return "all";
  if (type === "follow") return "you";
  if (type === "dm_message") return "you";
  if (type.endsWith("-comment") || type.endsWith("-reply")) return "you";
  if (type.startsWith("inline")) return "you";
  if (type === "video-upload" || type === "clip") return "following";
  return "all"; // catch-all — visible only in the All tab
};

// Sort merged Appwrite + Supabase notifications by timestamp desc. Both
// surfaces use the same `$createdAt` field on the adapted shape.
const sortByCreatedAtDesc = (a, b) => {
  const aTs = a?.$createdAt ? Date.parse(a.$createdAt) : 0;
  const bTs = b?.$createdAt ? Date.parse(b.$createdAt) : 0;
  return bTs - aTs;
};

// Merge two notification arrays by `$id`, sorted by timestamp desc. The
// existing Appwrite mergeNotifications inside the component handles INCOMING
// vs CURRENT for pagination; this helper handles the cross-backend fan-in.
const mergeAcrossBackends = (appwrite = [], supabase = []) => {
  const seen = new Set();
  const merged = [];
  for (const n of [...supabase, ...appwrite]) {
    if (!n?.$id || seen.has(n.$id)) continue;
    seen.add(n.$id);
    merged.push(n);
  }
  return merged.sort(sortByCreatedAtDesc);
};

const Notification = () => {
  const { theme } = useAppTheme();
  const notificationService = new NotificationService();
  const { user } = useGlobalContext();
  const dispatch = useDispatch();
  const notificationCache = useSelector((state) => state.notifications);
  const [notificationsLoading, setNotificationsLoading] = useState(true);
  const [notifications, setNotifications] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [markingAllViewed, setMarkingAllViewed] = useState(false);
  // Active filter tab — matches web's [All][You][Following].
  const [activeTab, setActiveTab] = useState("all");
  useResetOnBlur(setRefreshing, setIsFetchingMore);
  const hasLoadedRef = useRef(false);
  const cacheHydratedRef = useRef(false);
  const hasCacheForUser = Boolean(notificationCache?.userId && notificationCache.userId === user?.$id && notificationCache.lastFetchedAt);
  const unreadCount = useMemo(
    () => notifications.reduce((count, notification) => count + (notification?.isViewed === false ? 1 : 0), 0),
    [notifications],
  );

  // dismissedIds set — IDs the user has tapped through the private-DM
  // path. Filtered out at every site that loads notifications so that
  // even if the server-side DELETE was blocked by RLS or otherwise
  // failed silently, the row never reappears on this device.
  const dismissedIdsSet = useMemo(() => {
    const arr = Array.isArray(notificationCache?.dismissedIds) ? notificationCache.dismissedIds : [];
    return new Set(arr);
  }, [notificationCache?.dismissedIds]);
  const filterOutDismissed = useCallback(
    (list) => (dismissedIdsSet.size === 0 ? list : list.filter((n) => !dismissedIdsSet.has(n?.$id))),
    [dismissedIdsSet],
  );

  const filteredNotifications = useMemo(() => {
    if (activeTab === "all") return notifications;
    return notifications.filter((notification) => categorizeNotification(notification) === activeTab);
  }, [notifications, activeTab]);

  useEffect(() => {
    cacheHydratedRef.current = false;
    hasLoadedRef.current = false;
    setNotifications([]);
    setLastId(undefined);
    setHasMore(false);
    setNotificationsLoading(true);
  }, [user?.$id]);

  useEffect(() => {
    if (!hasCacheForUser || cacheHydratedRef.current) return;
    setNotifications(filterOutDismissed(notificationCache.items || []));
    setLastId(notificationCache.lastId || undefined);
    setHasMore(typeof notificationCache.hasMore === "boolean" ? notificationCache.hasMore : false);
    setNotificationsLoading(false);
    hasLoadedRef.current = true;
    cacheHydratedRef.current = true;
  }, [hasCacheForUser, notificationCache.items, notificationCache.lastId, notificationCache.hasMore, filterOutDismissed]);

  useEffect(() => {
    if (!user?.$id || !hasLoadedRef.current) return;
    dispatch(
      setNotificationsCache({
        userId: user.$id,
        items: notifications,
        lastId: lastId ?? null,
        hasMore,
      }),
    );
  }, [dispatch, user?.$id, notifications, lastId, hasMore]);

  useFocusEffect(
    useCallback(() => {
      if (hasLoadedRef.current || hasCacheForUser) {
        silentRefreshNotifications();
        return;
      }
      fetchUserNotification();
    }, [user?.$id, hasCacheForUser]),
  );

  const mergeNotifications = (current = [], incoming = []) => {
    if (!current.length) return [...incoming];
    if (!incoming.length) return current;
    const currentMap = new Map(current.map((notification) => [notification.$id, notification]));
    const newItems = [];
    incoming.forEach((notification) => {
      const existing = currentMap.get(notification.$id);
      if (existing) {
        currentMap.set(notification.$id, { ...existing, ...notification });
      } else {
        newItems.push(notification);
      }
    });
    return [...newItems, ...current.map((notification) => currentMap.get(notification.$id))];
  };

  const fetchUserNotification = async () => {
    try {
      // Fetch Appwrite (existing types) + Supabase (dm_message) in parallel.
      // Supabase rows are returned in the Appwrite-shaped form so the merge
      // is just a sort + dedupe; see lib/notifications-supabase.js.
      const [notificationData, supabaseDms] = await Promise.all([
        notificationService.fetchNotifications({ userId: user?.$id, limit: 10 }),
        loadDmNotifications({ limit: 30 }),
      ]);
      const documents = notificationData?.documents || [];
      const notificationIDS = documents.map((item) => item.$id);
      const merged = filterOutDismissed(mergeAcrossBackends(documents, supabaseDms));
      // Optimistically mark everything we just fetched as viewed locally so
      // the badge clears the instant the bell opens — the awaited backend
      // calls below confirm the same state on the server. Without this,
      // closing the bell before the markAsRead RPC resolved left rows in
      // an "unread" state and the next fetch re-painted the badge.
      const optimistic = merged.map((n) => (n?.isViewed === false ? { ...n, isViewed: true } : n));
      setNotifications(optimistic);
      // lastId tracks the Appwrite cursor only — pagination requests more
      // Appwrite docs; Supabase dm_message rows are loaded in full per fetch.
      setLastId(documents.length ? documents[documents.length - 1].$id : undefined);
      setHasMore(documents.length < notificationData.total);
      setNotificationsLoading(false);
      hasLoadedRef.current = true;
      // Mark BOTH backends in parallel — previously only Appwrite IDs were
      // marked, which left Supabase dm_message rows unread server-side and
      // re-surfaced their badges on next fetch.
      await Promise.all([
        notificationIDS.length ? notificationService.markAsRead({ notificationIds: notificationIDS }) : Promise.resolve(),
        supabaseDms.length ? markAllDmNotificationsRead().catch(() => null) : Promise.resolve(),
      ]);
    } catch (error) {
      setNotificationsLoading(false);
      console.log("fetchUserNotification: error", error);
    }
  };

  const silentRefreshNotifications = async () => {
    try {
      const [notificationData, supabaseDms] = await Promise.all([
        notificationService.fetchNotifications({ userId: user?.$id, limit: 10 }),
        loadDmNotifications({ limit: 30 }),
      ]);
      const incomingNotifications = notificationData?.documents || [];
      if (incomingNotifications.length === 0 && supabaseDms.length === 0) {
        if (notificationsLoading) setNotificationsLoading(false);
        hasLoadedRef.current = true;
        return;
      }
      let mergedCount = 0;
      let mergedList = [];
      setNotifications((prev) => {
        // Drop the previous Supabase rows from `prev` first — we'll re-add
        // the freshly-fetched set below. Without this the read-state of
        // existing rows wouldn't reflect server-side updates.
        const prevAppwrite = prev.filter((n) => n?._backend !== "supabase");
        const mergedAppwrite = mergeNotifications(prevAppwrite, incomingNotifications);
        const merged = filterOutDismissed(mergeAcrossBackends(mergedAppwrite, supabaseDms));
        mergedCount = merged.length;
        mergedList = merged;
        return merged;
      });
      const resolvedLastId = lastId || mergedList[mergedList.length - 1]?.$id;
      if (resolvedLastId) setLastId(resolvedLastId);
      if (mergedCount && notificationData?.total != null) setHasMore(mergedCount < notificationData.total);
      if (notificationsLoading) setNotificationsLoading(false);
      hasLoadedRef.current = true;
    } catch (error) {
      console.log("silentRefreshNotifications: error", error);
    }
  };

  const fetchMoreNotification = async () => {
    try {
      if (isFetchingMore || !hasMore) return;
      const resolvedLastId = lastId || notifications[notifications.length - 1]?.$id;
      if (!resolvedLastId) return;
      setIsFetchingMore(true);
      const notificationData = await notificationService.fetchNotifications({ userId: user?.$id, lastId: resolvedLastId, limit: 10 });
      const incomingNotifications = notificationData?.documents || [];
      if (incomingNotifications.length === 0) {
        setHasMore(false);
        return;
      }
      const uniqueNotification = incomingNotifications.filter((notification) => !notifications.some((existing) => existing.$id === notification.$id));
      if (uniqueNotification.length === 0) {
        if (notificationData?.total != null) {
          setHasMore(notifications.length < notificationData.total);
        }
        return;
      }
      const updatedFetchedNotification = [...notifications, ...uniqueNotification];
      setNotifications(updatedFetchedNotification);
      setLastId(incomingNotifications[incomingNotifications.length - 1].$id);
      if (updatedFetchedNotification.length >= notificationData.total) setHasMore(false);
    } catch (error) {
      console.log("fetchMoreNotification: error", error);
    } finally {
      setIsFetchingMore(false);
    }
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchUserNotification();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleMarkAllAsViewed = async () => {
    if (markingAllViewed || unreadCount === 0 || !user?.$id) return;
    const previousNotifications = notifications;

    setMarkingAllViewed(true);
    setNotifications((prev) => prev.map((notification) => ({ ...notification, isViewed: true })));

    // Run both backends in parallel — the bell-panel "Mark all read" should
    // clear Appwrite (video / post / book / etc.) AND Supabase dm_message
    // rows in one user gesture.
    const [appwriteSuccess] = await Promise.all([
      notificationService.markAllAsViewed({ userId: user.$id }),
      markAllDmNotificationsRead().catch(() => null),
    ]);
    if (!appwriteSuccess) {
      setNotifications(previousNotifications);
    }

    setMarkingAllViewed(false);
  };

  // Realtime — prepend / patch Supabase dm_message rows live so the bell
  // panel stays current while it's open. Appwrite types still rely on
  // poll-on-focus (their service has no realtime channel today).
  //
  // PERF: previously every onInsert/onUpdate fired `.sort(sortByCreatedAtDesc)`
  // on the full notifications array. In an active DM thread (10+ messages/
  // minute), that's 10× O(n log n) per minute over a list that's already
  // sorted descending. Now we patch in place and only re-sort defensively
  // when an OUT-OF-ORDER insert lands (older doc than current head — happens
  // on backfills or clock skew). 99% of the time the array stays sorted by
  // construction since the newest doc always has the latest created_at.
  useEffect(() => {
    if (!user?.$id) return;
    const unsubscribe = subscribeToDmNotifications({
      onInsert: (doc) => {
        setNotifications((prev) => {
          const existingIdx = prev.findIndex((n) => n.$id === doc.$id);
          if (existingIdx !== -1) {
            // Replace in place — same timestamp position assumed.
            const next = prev.slice();
            next[existingIdx] = doc;
            return next;
          }
          // Fast path: doc is newer than head → just prepend, no sort.
          const headTs = prev[0]?.$createdAt || prev[0]?.created_at;
          const docTs = doc?.$createdAt || doc?.created_at;
          if (!headTs || !docTs || docTs >= headTs) {
            return [doc, ...prev];
          }
          // Out-of-order insert (backfill / clock skew) — defensive sort.
          return [doc, ...prev].sort(sortByCreatedAtDesc);
        });
      },
      onUpdate: (doc) => {
        setNotifications((prev) => {
          const idx = prev.findIndex((n) => n.$id === doc.$id);
          if (idx === -1) return prev;
          // Updates rarely change created_at, so position is preserved.
          const next = prev.slice();
          next[idx] = doc;
          return next;
        });
      },
    });
    return unsubscribe;
  }, [user?.$id]);

  const renderListEmptyComponent = () => {
    return notificationsLoading ? (
      <View>
        {[...Array(8)].map((_, index) => (
          <View key={index} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12 }}>
            <AnimatedSkeleton className="h-11 w-11 rounded-full" />
            <View style={{ marginLeft: 12, flex: 1 }}>
              <AnimatedSkeleton className="h-3.5 rounded-md" style={{ width: Math.max(getRandomSkeletonWidth() - 40, 160) }} />
              <AnimatedSkeleton className="mt-2 h-3 rounded-md" style={{ width: Math.max(getRandomSkeletonWidth() - 80, 100) }} />
            </View>
          </View>
        ))}
      </View>
    ) : (
      <View className="flex-1 items-center justify-center px-6 py-16">
        <View className="items-center rounded-3xl px-6 py-8" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
          <View className="h-16 w-16 items-center justify-center rounded-2xl" style={{ backgroundColor: theme.surfaceMuted }}>
            <FontAwesome name="bell" size={30} color={theme.icon} />
          </View>
          <Text className="mt-4 text-center text-lg font-semibold" style={{ color: theme.text }}>
            You're all caught up!
          </Text>
          <Text className="mt-2 text-center text-xs" style={{ color: theme.textSoft }}>
            New updates and mentions will show up here.
          </Text>
        </View>
      </View>
    );
  };

  const renderItem = ({ item }) => {
    if (!item) return null;

    return (
      <NotificationCard
        item={item}
        onViewed={(notificationId) => {
          if (!notificationId) return;
          dispatch(markNotificationViewed({ userId: user?.$id, notificationId }));
          setNotifications((prev) =>
            prev.map((notification) => (notification.$id === notificationId ? { ...notification, isViewed: true } : notification)),
          );
        }}
        onDeleted={(notificationId) => {
          // Private-DM tap path — the card has just kicked off a
          // server-side deleteNotification(); drop the row from the
          // local list immediately so the bell reflects the new
          // privacy floor without waiting for a refetch. Also dispatch
          // removeNotification so the persisted Redux/MMKV cache loses
          // the row — without this dispatch, navigating away and
          // returning would replay the row from cache hydration even
          // though the server DELETE succeeded.
          if (!notificationId) return;
          dispatch(removeNotification({ userId: user?.$id, notificationId }));
          setNotifications((prev) => prev.filter((notification) => notification?.$id !== notificationId));
        }}
      />
    );
  };

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
      <View className="flex-1">
        <View className="px-4 pb-3 pt-2">
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center">
              <TouchableOpacity
                onPress={() => router.back()}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                className="h-10 w-10 items-center justify-center rounded-full"
                style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
              >
                <MaterialIcons name="arrow-back" size={22} color={theme.icon} />
              </TouchableOpacity>
              <View className="ml-3">
                <Text className="text-2xl font-bold" style={{ color: theme.text }}>
                  Notifications
                </Text>
              </View>
            </View>
            {unreadCount > 0 ? (
              <TouchableOpacity onPress={handleMarkAllAsViewed} disabled={markingAllViewed} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                {markingAllViewed ? (
                  <ActivityIndicator size="small" color={theme.primary} />
                ) : (
                  <Text style={{ fontSize: 13, fontWeight: "600", color: theme.primary }}>Mark all read</Text>
                )}
              </TouchableOpacity>
            ) : null}
          </View>

          {/* Filter tabs — All / You / Following (matches web) */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              marginTop: 12,
              paddingBottom: 4,
            }}
          >
            {[
              { key: "all", label: "All" },
              { key: "you", label: "You" },
              { key: "following", label: "Following" },
            ].map((tab) => {
              const isActive = activeTab === tab.key;
              return (
                <TouchableOpacity
                  key={tab.key}
                  onPress={() => setActiveTab(tab.key)}
                  activeOpacity={0.85}
                  style={{
                    paddingVertical: 6,
                    paddingHorizontal: 14,
                    borderRadius: 999,
                    marginRight: 4,
                    backgroundColor: isActive ? theme.primary : "transparent",
                  }}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: isActive ? "700" : "500",
                      letterSpacing: 0.1,
                      color: isActive ? (theme.primaryContrast ?? "#ffffff") : (theme.textMuted ?? theme.text),
                    }}
                  >
                    {tab.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
        <View className="flex-1">
          {/* When the list is empty, render the empty component directly inside
              this flex-1 parent so its own `flex-1 items-center justify-center`
              actually centers. FlashList sizes its content container to its
              children, so the previous `flexGrow: 1` workaround on
              contentContainerStyle did the centering — but FlashList only
              accepts padding/backgroundColor there and was warning loudly
              ("FlashList only supports padding related props..."). */}
          {filteredNotifications.length === 0 ? (
            renderListEmptyComponent()
          ) : (
            <FlashList
              data={filteredNotifications}
              refreshing={refreshing}
              estimatedItemSize={72}
              keyExtractor={(item) => item.$id}
              showsVerticalScrollIndicator={false}
              renderItem={renderItem}
              onRefresh={onRefresh}
              onEndReached={fetchMoreNotification}
              contentContainerStyle={{
                paddingBottom: 24,
                paddingTop: 4,
              }}
              ListFooterComponent={
                isFetchingMore ? (
                  <View className="items-center py-4">
                    <ActivityIndicator size="small" color={theme.primary} />
                  </View>
                ) : null
              }
              refreshControl={
                <RefreshControl
                  tintColor={theme.primary}
                  titleColor={theme.primary}
                  colors={[theme.primary]}
                  progressBackgroundColor={theme.surface}
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                />
              }
            />
          )}
        </View>
      </View>
    </SafeAreaView>
  );
};

export default Notification;
