import { Ionicons } from "@expo/vector-icons";
import * as Notifications from "expo-notifications";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import useIsOffline from "../hooks/useIsOffline";
import { NotificationService } from "../lib/notifications";
import {
  getUnreadDmCount,
  markAllDmNotificationsRead,
  subscribeToDmNotifications,
} from "../lib/notifications-supabase";
import { useTotalUnreadCount } from "../hooks/useTotalUnreadCount";
import StyledCoinIndicator from "./StyledCoinIndicator";

// Module-level singleton — was being instantiated on every render before.
const notificationService = new NotificationService();

const MainScreensHeader = ({ title }) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const isOffline = useIsOffline();
  // Bell badge sums two backends:
  //   • appwriteUnread — likes / comments / replies / follows / clips (legacy)
  //   • supabaseDmUnread — chat dm_message rows (task #201)
  // Kept as separate state so each updates from its own source / channel
  // without re-fetching the other one. The badge text is the sum.
  const [appwriteUnread, setAppwriteUnread] = useState(0);
  const [supabaseDmUnread, setSupabaseDmUnread] = useState(0);
  const newNotifications = appwriteUnread + supabaseDmUnread;
  const { unreadCount } = useTotalUnreadCount();

  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener(async () => {
      await fetchNewNotificationCount();
    });
    return () => subscription.remove();
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchNewNotificationCount();
    }, []),
  );

  // Live updates for the Supabase dm_message side. The Appwrite count is
  // poll-on-focus (its service has no realtime), but Supabase rows can
  // arrive any time the recipient is online, so the badge should bump
  // without waiting for the user to navigate back to a main screen.
  useEffect(() => {
    if (!user?.$id) return;
    const unsubscribe = subscribeToDmNotifications({
      onInsert: () => {
        // Cheap recount — the unread index makes this O(unread rows).
        getUnreadDmCount().then(setSupabaseDmUnread).catch(() => {});
      },
      onUpdate: () => {
        getUnreadDmCount().then(setSupabaseDmUnread).catch(() => {});
      },
    });
    return unsubscribe;
  }, [user?.$id]);

  const fetchNewNotificationCount = async () => {
    // Defense-in-depth — getUnreadCount also early-returns 0 on missing userId now,
    // but skipping the call entirely avoids an unnecessary round-trip while logged out.
    if (!user?.$id) {
      setAppwriteUnread(0);
      setSupabaseDmUnread(0);
      return;
    }
    const [appwriteCount, supabaseCount] = await Promise.all([
      notificationService.getUnreadCount({ userId: user.$id }),
      getUnreadDmCount().catch(() => 0),
    ]);
    setAppwriteUnread(appwriteCount || 0);
    setSupabaseDmUnread(supabaseCount || 0);
  };

  const handleChatsPress = () => router.push("channel-list");
  const handleProfilePress = () => router.push("/profile");
  const handleNotificationsPress = async () => {
    // Optimistic clear — opening the bell panel is the same gesture as
    // "I've seen these," and the panel itself will reconcile from the
    // server. Mark both backends in parallel.
    setAppwriteUnread(0);
    setSupabaseDmUnread(0);
    if (!isOffline && user?.$id) {
      void notificationService.markAllAsRead({ userId: user.$id });
      void markAllDmNotificationsRead();
    }
    router.push("/notification");
  };

  return (
    <>
      {isOffline && (
        <View style={[styles.offlinePill, { backgroundColor: theme.offlineBg, borderColor: theme.offlineBorder }]}>
          <Ionicons name="cloud-offline-outline" size={14} color={theme.offlineIcon} />
          <Text className="ml-1.5 text-xs font-semibold" style={{ color: theme.isDark ? "#fee2e2" : "#b91c1c" }}>
            You are in offline mode
          </Text>
        </View>
      )}
      <View className="flex h-[56px] flex-row items-center justify-between" style={[styles.headerWrapper, { borderBottomColor: theme.divider }]}>
        <View className="flex-1 flex-row items-center">
          <TouchableOpacity activeOpacity={0.7} onPress={handleProfilePress}>
            <FastImage
              style={[styles.avatar, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }]}
              source={{ uri: user?.avatar, priority: FastImage.priority.normal }}
            />
          </TouchableOpacity>
          <StyledCoinIndicator
            onPress={() => {
              if (isOffline) return Alert.alert("You're Offline", "Please connect to the internet to access your coins.");
              router.push("/store");
            }}
            style={[styles.coinPill, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }]}
          />
        </View>
        <View className="flex-1 items-center">
          <Text style={[styles.title, { color: theme.text }]} className="font-pbold text-[20px]">
            {title}
          </Text>
        </View>

        <View className="flex-1 flex-row items-center justify-end">
          <TouchableOpacity
            style={[styles.iconButton, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}
            onPress={() => router.push("/search")}
          >
            <Ionicons name="search-outline" size={20} color={theme.icon} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.iconButton, styles.iconButtonSpaced, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}
            onPress={handleNotificationsPress}
          >
            <Ionicons name="notifications-outline" size={20} color={theme.icon} />
            {newNotifications > 0 && (
              <View style={[styles.badge, { backgroundColor: theme.badge, borderColor: theme.badgeBorder }]}>
                <Text style={[styles.badgeText, { color: theme.primaryContrast }]}>{newNotifications > 99 ? "99+" : newNotifications}</Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.iconButton, styles.iconButtonSpaced, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}
            onPress={handleChatsPress}
          >
            <Ionicons name="chatbubble-outline" size={20} color={theme.icon} />
            {unreadCount > 0 && (
              <View style={[styles.badge, { backgroundColor: theme.badge, borderColor: theme.badgeBorder }]}>
                <Text style={[styles.badgeText, { color: theme.primaryContrast }]}>{unreadCount > 99 ? "99+" : unreadCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </>
  );
};

const styles = StyleSheet.create({
  headerWrapper: {
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  offlinePill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(239,68,68,0.12)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.25)",
    marginBottom: 6,
  },
  avatar: {
    height: 38,
    width: 38,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  coinPill: {
    marginLeft: 10,
    paddingHorizontal: 10,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    letterSpacing: 0.3,
  },
  iconButton: {
    height: 36,
    width: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    position: "relative",
  },
  iconButtonSpaced: {
    marginLeft: 8,
  },
  badge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "700",
  },
});

export default MainScreensHeader;
