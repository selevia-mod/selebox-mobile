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
import { markNotificationViewed, setNotificationsCache } from "../../store/reducers/notifications";

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
  useResetOnBlur(setRefreshing, setIsFetchingMore);
  const hasLoadedRef = useRef(false);
  const cacheHydratedRef = useRef(false);
  const hasCacheForUser = Boolean(notificationCache?.userId && notificationCache.userId === user?.$id && notificationCache.lastFetchedAt);
  const unreadCount = useMemo(
    () => notifications.reduce((count, notification) => count + (notification?.isViewed === false ? 1 : 0), 0),
    [notifications],
  );

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
    setNotifications(notificationCache.items || []);
    setLastId(notificationCache.lastId || undefined);
    setHasMore(typeof notificationCache.hasMore === "boolean" ? notificationCache.hasMore : false);
    setNotificationsLoading(false);
    hasLoadedRef.current = true;
    cacheHydratedRef.current = true;
  }, [hasCacheForUser, notificationCache.items, notificationCache.lastId, notificationCache.hasMore]);

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
      const notificationData = await notificationService.fetchNotifications({ userId: user?.$id, limit: 10 });
      const documents = notificationData?.documents || [];
      const notificationIDS = documents.map((item) => item.$id);
      setNotifications(documents);
      setLastId(documents.length ? documents[documents.length - 1].$id : undefined);
      setHasMore(documents.length < notificationData.total);
      setNotificationsLoading(false);
      hasLoadedRef.current = true;
      if (notificationIDS.length) {
        await notificationService.markAsRead({ notificationIds: notificationIDS });
      }
    } catch (error) {
      setNotificationsLoading(false);
      console.log("fetchUserNotification: error", error);
    }
  };

  const silentRefreshNotifications = async () => {
    try {
      const notificationData = await notificationService.fetchNotifications({ userId: user?.$id, limit: 10 });
      const incomingNotifications = notificationData?.documents || [];
      if (incomingNotifications.length === 0) {
        if (notificationsLoading) setNotificationsLoading(false);
        hasLoadedRef.current = true;
        return;
      }
      let mergedCount = 0;
      let mergedList = [];
      setNotifications((prev) => {
        const merged = mergeNotifications(prev, incomingNotifications);
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

    const success = await notificationService.markAllAsViewed({ userId: user.$id });
    if (!success) {
      setNotifications(previousNotifications);
    }

    setMarkingAllViewed(false);
  };

  const renderListEmptyComponent = () => {
    return notificationsLoading ? (
      <View className="mt-2 space-y-3">
        {[...Array(8)].map((_, index) => (
          <View
            key={index}
            className="flex-row items-center rounded-2xl p-3"
            style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
          >
            <AnimatedSkeleton className="h-12 w-12 rounded-xl" />
            <View className="ml-3 flex-1">
              <AnimatedSkeleton className="h-4 rounded-lg" style={{ width: Math.max(getRandomSkeletonWidth() - 40, 140) }} />
              <AnimatedSkeleton className="mt-2 h-3 rounded-md" style={{ width: Math.max(getRandomSkeletonWidth() - 30, 170) }} />
            </View>
            <AnimatedSkeleton className="h-[54px] w-[76px] rounded-xl" />
          </View>
        ))}
      </View>
    ) : (
      <View className="flex-1 items-center justify-center px-6 py-16">
        <View
          className="items-center rounded-3xl px-6 py-8"
          style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}
        >
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
      />
    );
  };

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
      <View className="flex-1 px-4">
        <View className="pb-3 pt-2">
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
              <TouchableOpacity
                onPress={handleMarkAllAsViewed}
                disabled={markingAllViewed}
                className="rounded-full px-3 py-2"
                style={{
                  borderWidth: 1,
                  borderColor: markingAllViewed ? theme.borderStrong : theme.primary,
                  backgroundColor: markingAllViewed ? theme.surfaceMuted : theme.primarySoft,
                }}
              >
                {markingAllViewed ? (
                  <ActivityIndicator size="small" color={theme.primary} />
                ) : (
                  <Text className="text-xs font-semibold" style={{ color: theme.primary }}>
                    Mark all viewed
                  </Text>
                )}
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
        <View className="flex-1">
          <FlashList
            data={notifications}
            refreshing={refreshing}
            estimatedItemSize={100}
            keyExtractor={(item) => item.$id}
            showsVerticalScrollIndicator={false}
            renderItem={renderItem}
            onRefresh={onRefresh}
            onEndReached={fetchMoreNotification}
            ListEmptyComponent={renderListEmptyComponent}
            contentContainerStyle={{
              paddingBottom: 24,
              paddingTop: 4,
              flexGrow: !notificationsLoading && notifications.length === 0 ? 1 : 0,
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
        </View>
      </View>
    </SafeAreaView>
  );
};

export default Notification;
