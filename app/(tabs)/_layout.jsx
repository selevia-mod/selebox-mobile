import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { Tabs, useNavigationContainerRef } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Animated, Keyboard, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomNavPopup, ThemedStatusBar } from "../../components";
import ProfileMenuModal from "../../components/ProfileMenuModal";
import { ProfileDrawerProvider } from "../../context/profile-drawer-provider";
import useAppTheme from "../../hooks/useAppTheme";
import tabNavigationEvents from "../../lib/tab-navigation-events";

const TabsLayout = () => {
  const { theme } = useAppTheme();
  const [popupVisible, setPopupVisible] = useState(false);
  const popupVisibleRef = useRef(false);
  const insets = useSafeAreaInsets();
  const navigationRef = useNavigationContainerRef();
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const lastTapTime = useRef({});
  const DOUBLE_TAP_DELAY = 300; // milliseconds
  const ACTIVE_TINT = theme.primary;
  const INACTIVE_TINT = theme.textSoft;
  const TAB_BAR_HEIGHT = 72;
  const TAB_BAR_RADIUS = 22;
  const tabBarTranslateY = useRef(new Animated.Value(0)).current;
  const tabBarOpacity = useRef(new Animated.Value(1)).current;
  const tabBarVisibleRef = useRef(true);
  const lastPopupOpenTime = useRef(0);
  const previousRoute = useRef(null);
  const POPUP_PROTECTION_WINDOW = 300; // ms
  const tabBarHideOffset = TAB_BAR_HEIGHT + Math.max(insets.bottom, 8) + 24;

  const handleTabPress = (routeName) => {
    const now = Date.now();
    const lastTap = lastTapTime.current[routeName] || 0;

    if (now - lastTap < DOUBLE_TAP_DELAY) {
      // Double-tap detected - emit event
      tabNavigationEvents.emit("scrollToTop", { tab: routeName });
      lastTapTime.current[routeName] = 0; // Reset to prevent triple-tap
    } else {
      lastTapTime.current[routeName] = now;
    }
  };

  useEffect(() => {
    popupVisibleRef.current = popupVisible;
  }, [popupVisible]);

  useEffect(() => {
    const handleTabBarVisibility = ({ visible }) => {
      if (visible === tabBarVisibleRef.current) return;
      tabBarVisibleRef.current = visible;

      Animated.parallel([
        Animated.timing(tabBarTranslateY, {
          toValue: visible ? 0 : tabBarHideOffset,
          duration: 220,
          useNativeDriver: true,
        }),
        Animated.timing(tabBarOpacity, {
          toValue: visible ? 1 : 0,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start();

      if (!visible && popupVisibleRef.current) {
        setPopupVisible(false);
      }
    };

    tabNavigationEvents.on("tabBarVisibility", handleTabBarVisibility);

    return () => {
      tabNavigationEvents.off("tabBarVisibility", handleTabBarVisibility);
    };
  }, [tabBarHideOffset, tabBarOpacity, tabBarTranslateY]);

  useEffect(() => {
    const unsubscribe = navigationRef.addListener("state", () => {
      const currentRoute = navigationRef.current?.getCurrentRoute?.()?.name;
      const prevRoute = previousRoute.current;

      previousRoute.current = currentRoute;

      const TAB_ROUTES = ["home", "videos", "books", "playlist"];

      const isLeavingTabs = TAB_ROUTES.includes(prevRoute) && !TAB_ROUTES.includes(currentRoute);
      const timeSinceOpen = Date.now() - lastPopupOpenTime.current;
      const isRecentlyOpened = timeSinceOpen < POPUP_PROTECTION_WINDOW;

      // Only close when leaving tabs AND popup not just opened
      if (isLeavingTabs && !isRecentlyOpened) {
        setPopupVisible(false);
      }
    });

    const showSub = Keyboard.addListener("keyboardDidShow", () => {
      setKeyboardVisible(true);
    });

    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardVisible(false);
    });

    return () => {
      unsubscribe();
      showSub.remove();
      hideSub.remove();
    };
  }, [navigationRef]);

  useEffect(() => {
    const currentRoute = navigationRef.current?.getCurrentRoute?.()?.name;
    if (currentRoute) {
      previousRoute.current = currentRoute;
    }
  }, [navigationRef]);

  const handlePlusPress = () => {
    if (!popupVisible) {
      lastPopupOpenTime.current = Date.now();
    }
    setPopupVisible((prev) => !prev);
  };

  const AnimatedTabBarButton = ({ children, accessibilityState, onPress, onLongPress, style, ...rest }) => {
    const focused = accessibilityState?.selected;
    const scale = useRef(new Animated.Value(focused ? 1.05 : 0.97)).current;
    const highlightOpacity = useRef(new Animated.Value(focused ? 1 : 0)).current;

    useEffect(() => {
      Animated.spring(scale, {
        toValue: focused ? 1.05 : 0.97,
        friction: 7,
        tension: 120,
        useNativeDriver: true,
      }).start();
      Animated.timing(highlightOpacity, {
        toValue: focused ? 1 : 0,
        duration: 180,
        useNativeDriver: true,
      }).start();
    }, [focused, scale, highlightOpacity]);

    const handlePressIn = () => {
      Animated.spring(scale, {
        toValue: 0.93,
        speed: 22,
        bounciness: 0,
        useNativeDriver: true,
      }).start();
    };

    const handlePressOut = () => {
      Animated.spring(scale, {
        toValue: focused ? 1.05 : 0.97,
        friction: 7,
        tension: 120,
        useNativeDriver: true,
      }).start();
    };

    return (
      <Pressable
        {...rest}
        onPress={onPress}
        onLongPress={onLongPress}
        android_ripple={{ color: theme.primarySoft, borderless: true }}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={({ pressed }) => [
          style,
          {
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            paddingVertical: 6,
            opacity: pressed ? 0.95 : 1,
          },
        ]}
      >
        <Animated.View style={{ transform: [{ scale }] }}>
          <Animated.View
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
              borderRadius: 16,
              backgroundColor: theme.primarySoft,
              borderWidth: 1,
              borderColor: theme.primary,
              opacity: highlightOpacity,
            }}
          />
          <Animated.View
            style={{
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 14,
              paddingVertical: 6,
              borderRadius: 16,
            }}
          >
            {children}
          </Animated.View>
        </Animated.View>
      </Pressable>
    );
  };

  const TabIcon = ({ outlineName, solidName, color, focused }) => <Ionicons name={focused ? solidName : outlineName} size={22} color={color} />;

  const FloatingActionButton = () => {
    const scale = useRef(new Animated.Value(1)).current;
    const rotation = useRef(new Animated.Value(0)).current;

    useEffect(() => {
      Animated.spring(rotation, {
        toValue: popupVisible ? 1 : 0,
        friction: 8,
        tension: 90,
        useNativeDriver: true,
      }).start();
    }, [popupVisible, rotation]);

    const handlePressIn = () => {
      Animated.spring(scale, {
        toValue: 0.93,
        speed: 22,
        bounciness: 0,
        useNativeDriver: true,
      }).start();
    };

    const handlePressOut = () => {
      Animated.spring(scale, {
        toValue: 1,
        friction: 8,
        tension: 110,
        useNativeDriver: true,
      }).start();
    };

    const rotate = rotation.interpolate({
      inputRange: [0, 1],
      outputRange: ["0deg", "45deg"],
    });

    return (
      <Animated.View
        style={{
          position: "absolute",
          zIndex: 30,
          alignSelf: "center",
          transform: [{ translateY: tabBarTranslateY }, { scale }],
          bottom: Math.max(insets.bottom + 6, 12),
          opacity: Platform.OS === "android" && keyboardVisible ? 0 : tabBarOpacity,
        }}
      >
        <Pressable
          onPress={handlePlusPress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          android_ripple={{ color: theme.primarySoft, borderless: false }}
          style={({ pressed }) => ({
            height: 62,
            width: 62,
            borderRadius: 31,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.primary,
            borderWidth: 1,
            borderColor: theme.border,
            shadowColor: theme.primary,
            shadowOpacity: 0.35,
            shadowRadius: 14,
            shadowOffset: { width: 0, height: 8 },
            elevation: 12,
            opacity: pressed ? 0.96 : 1,
          })}
        >
          <Animated.View style={{ transform: [{ rotate }] }}>
            <Ionicons name="add" size={30} color={theme.primaryContrast} />
          </Animated.View>
        </Pressable>
      </Animated.View>
    );
  };

  return (
    <ProfileDrawerProvider>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: ACTIVE_TINT,
          tabBarInactiveTintColor: INACTIVE_TINT,
          tabBarShowLabel: true,
          tabBarHideOnKeyboard: true,
          tabBarButton: (props) => <AnimatedTabBarButton {...props} />,
          tabBarLabelStyle: {
            fontSize: 9,
            marginBottom: 0,
            includeFontPadding: false,
          },
          tabBarStyle: {
            backgroundColor: theme.surfaceElevated,
            position: "absolute",
            borderTopWidth: 0,
            paddingHorizontal: 0,
            paddingTop: 8,
            paddingBottom: 8,
            height: TAB_BAR_HEIGHT,
            left: 16,
            right: 16,
            bottom: Math.max(insets.bottom, 8),
            borderRadius: TAB_BAR_RADIUS,
            borderWidth: 1,
            borderColor: theme.border,
            shadowColor: theme.overlayStrong,
            shadowOpacity: 0.35,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 10 },
            elevation: 18,
            transform: [{ translateY: tabBarTranslateY }],
            opacity: tabBarOpacity,
          },
        }}
      >
        <Tabs.Screen
          name="home"
          options={{
            title: "Home",
            tabBarIcon: ({ color, focused }) => <TabIcon outlineName="home-outline" solidName="home" color={color} focused={focused} />,
          }}
          listeners={() => ({
            tabPress: (e) => {
              const currentRoute = navigationRef.current?.getCurrentRoute?.()?.name;
              if (currentRoute === "home") {
                e.preventDefault();
                handleTabPress("home");
              }
            },
          })}
        />

        {/* Reels — coming soon. Reuses the route slot left by the
            retired Clips tab (clips.jsx still exists as a no-op route
            file; expo-router needs the entry to register the slot).
            tabPress is intercepted with e.preventDefault() so it never
            navigates to the underlying clips screen. The user gets a
            "Coming soon" alert instead. The icon + SOON badge make it
            visually distinct from the active tabs without breaking the
            tab bar's geometry. When Reels actually ships, swap the
            tap handler for a real route push and remove the badge. */}

        <Tabs.Screen
          name="clips"
          options={{
            title: "Reels",
            tabBarIcon: ({ color, focused }) => (
              <View style={{ width: 30, height: 26, alignItems: "center", justifyContent: "center" }}>
                <MaterialCommunityIcons name={focused ? "movie-open-play" : "movie-open-play-outline"} size={22} color={color} />
                <View
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -10,
                    paddingHorizontal: 4,
                    paddingVertical: 1,
                    borderRadius: 6,
                    backgroundColor: theme.primary,
                  }}
                  pointerEvents="none"
                >
                  <Text style={{ fontSize: 7, fontWeight: "700", letterSpacing: 0.3, color: theme.primaryContrast }}>
                    SOON
                  </Text>
                </View>
              </View>
            ),
          }}
          listeners={() => ({
            tabPress: (e) => {
              e.preventDefault();
              Alert.alert(
                "Reels is coming soon",
                "We're building a fresh short-form video experience. Stay tuned — it'll be worth the wait.",
                [{ text: "Got it" }],
              );
            },
          })}
        />

        <Tabs.Screen
          name="playlist"
          options={{
            tabBarLabel: "",
            tabBarIcon: () => null,
          }}
          listeners={{
            tabPress: (e) => {
              e.preventDefault();
            },
          }}
        />

        <Tabs.Screen
          name="videos"
          options={{
            title: "Videos",
            tabBarIcon: ({ color, focused }) => <TabIcon outlineName="film-outline" solidName="film" color={color} focused={focused} />,
          }}
          listeners={() => ({
            tabPress: (e) => {
              const currentRoute = navigationRef.current?.getCurrentRoute?.()?.name;
              if (currentRoute === "videos") {
                e.preventDefault();
                handleTabPress("videos");
              }
            },
          })}
        />

        <Tabs.Screen
          name="books"
          options={{
            title: "Books",
            tabBarIcon: ({ color, focused }) => <TabIcon outlineName="book-outline" solidName="book" color={color} focused={focused} />,
          }}
          listeners={() => ({
            tabPress: (e) => {
              const currentRoute = navigationRef.current?.getCurrentRoute?.()?.name;
              if (currentRoute === "books") {
                e.preventDefault();
                handleTabPress("books");
              }
            },
          })}
        />
      </Tabs>

      {/* Floating + Button */}
      <FloatingActionButton />

      {/* Overlay Popup */}
      {popupVisible && <BottomNavPopup handlePlusPress={handlePlusPress} />}

      {/* FB-style profile drawer — mounted ONCE at the (tabs) layout
          so it persists across drawer-tap → destination → back round-
          trips. ProfileMenuModal reads its open-state from the
          ProfileDrawerProvider context above. With coverScreen=false
          on the modal, it renders inline within this layout's render
          tree, so when navigation pushes a destination route group
          (community / payments / leaderboard / …) the (tabs) layout
          is covered and the drawer goes with it; on back, both come
          back together — no remount, no flag, no animation re-trigger. */}
      <ProfileMenuModal />

      <ThemedStatusBar backgroundColor={theme.background} />
    </ProfileDrawerProvider>
  );
};

export default TabsLayout;
