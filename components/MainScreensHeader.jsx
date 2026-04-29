import { Ionicons } from "@expo/vector-icons";
import * as Notifications from "expo-notifications";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Animated, Dimensions, Easing, Keyboard, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import useIsOffline from "../hooks/useIsOffline";
import { MessagesService } from "../lib/messages";
import { NotificationService } from "../lib/notifications";
import { useTotalUnreadCount } from "../lib/useTotalUnreadCount";
import StyledCoinIndicator from "./StyledCoinIndicator";

const MainScreensHeader = ({ title, searchPlaceholder, searchQuery, setSearchQuery, onSearchFocus, onSearchBlur }) => {
  const { user } = useGlobalContext();
  const { theme } = useAppTheme();
  const isOffline = useIsOffline();
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [newMessages, setNewMessages] = useState(0);
  const [newNotifications, setNewNotifications] = useState(0);
  const searchWidth = useRef(new Animated.Value(0)).current;
  const { width } = Dimensions.get("window");
  const notificationService = new NotificationService();
  const { unreadCount } = useTotalUnreadCount();

  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener(async (notification) => {
      // A new notification just arrived!
      await fetchNewNotificationCount();
    });

    return () => subscription.remove(); // clean up when unmounting
  }, []);

  const expandSearch = () => {
    setIsSearchActive(true);
    Animated.timing(searchWidth, {
      toValue: 1,
      duration: 250,
      easing: Easing.out(Easing.ease),
      useNativeDriver: false,
    }).start();
  };

  const collapseSearch = () => {
    Keyboard.dismiss();
    onSearchBlur?.();
    Animated.timing(searchWidth, {
      toValue: 0,
      duration: 200,
      easing: Easing.in(Easing.ease),
      useNativeDriver: false,
    }).start(() => {
      setIsSearchActive(false);
      setSearchQuery("");
    });
  };

  const inputWidth = searchWidth.interpolate({
    inputRange: [0, 1],
    outputRange: [0, Math.max(0, width * 0.6)],
  });

  useFocusEffect(
    useCallback(() => {
      fetchNewMessageCount();
      fetchNewNotificationCount();
    }, []),
  );

  const fetchNewMessageCount = async () => {
    const newMessageCount = await MessagesService.countChatsWithUnreadMessages({ userId: user?.$id });
    setNewMessages(newMessageCount);
  };

  const fetchNewNotificationCount = async () => {
    const newNotificationCount = await notificationService.getUnreadCount({ userId: user?.$id });
    setNewNotifications(newNotificationCount);
  };

  const handleChatsPress = () => router.push("channel-list");

  const handleProfilePress = () => {
    router.push("/profile");
  };

  const handleNotificationsPress = async () => {
    setNewNotifications(0);
    if (!isOffline && user?.$id) {
      void notificationService.markAllAsRead({ userId: user.$id });
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
      <View className="flex h-[56px] flex-row items-center justify-between " style={[styles.headerWrapper, { borderBottomColor: theme.divider }]}>
        <View className="flex-1 flex-row items-center">
          <TouchableOpacity activeOpacity={0.7} onPress={handleProfilePress}>
            <FastImage
              style={[styles.avatar, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }]}
              source={{ uri: user?.avatar, priority: FastImage.priority.high }}
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
          <Text style={[styles.title, { opacity: isSearchActive ? 0 : 1, color: theme.text }]} className="font-pbold text-[20px]">
            {title}
          </Text>
        </View>

        <View className="flex-1 flex-row items-center justify-end">
          {isSearchActive && (
            <Animated.View style={[styles.searchWrapper, { width: inputWidth }]}>
              <TextInput
                autoFocus
                placeholder={searchPlaceholder}
                placeholderTextColor={theme.searchPlaceholder}
                style={[
                  styles.searchField,
                  {
                    backgroundColor: theme.searchBackground,
                    borderColor: theme.searchBorder,
                    color: theme.searchText,
                  },
                ]}
                value={searchQuery}
                onChangeText={setSearchQuery}
                onFocus={onSearchFocus}
                onBlur={onSearchBlur}
              />
            </Animated.View>
          )}

          <TouchableOpacity
            style={[styles.iconButton, { backgroundColor: theme.surfaceMuted, borderColor: theme.border }]}
            onPress={() => (isSearchActive ? collapseSearch() : expandSearch())}
          >
            {isSearchActive ? (
              <Ionicons name="close" size={20} color={theme.icon} />
            ) : (
              <Ionicons name="search-outline" size={20} color={theme.icon} />
            )}
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
  searchWrapper: {
    marginRight: 8,
  },
  searchField: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    width: "100%",
    borderWidth: 1,
    fontSize: 13,
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
