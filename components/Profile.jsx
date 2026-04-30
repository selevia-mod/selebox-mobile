import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import FastImage from "react-native-fast-image";
import { MaintenanceModules, Modules } from "../constants/app";
import { PROFILE_BANNER_ASPECT_RATIO } from "../constants/profile";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";
import { getCurrentUserWithoutStream, updateBio } from "../lib/appwrite";
import { FollowService } from "../lib/follows";
import FormatNumber from "../lib/utils/format-number";
import { NotificationService } from "../lib/notifications";
import { StreamService } from "../lib/stream";
import { useModalMessage } from "../hooks/useModalMessage";
import AnimatedSkeleton from "./AnimatedSkeleton";
import CustomAlertModal from "./CustomAlertModal";
import ProfileActionsMenu from "./ProfileActionsMenu";
import ProfileBooksTab from "./ProfileBooksTab";
import ProfileClipsTab from "./ProfileClipsTab";
import ProfilePostTab from "./ProfilePostTab";
import ProfileVideosTab from "./ProfileVideosTab";
import StyledDivider from "./StyledDivider";
import UserRoleChips from "./UserRoleChips";

const PROFILE_TABS = [
  { title: "Posts", icon: "article" },
  { title: "Books", icon: "menu-book" },
  { title: "Videos", icon: "play-circle-filled" },
  { title: "Clips", icon: "movie" },
];

const BIO_MAX_LINES = 5;

const normalizeBio = (value) => {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").trim();
};

const applyBioEditorConstraints = (value, maxCharacters) => {
  const normalizedValue = typeof value === "string" ? value.replace(/\r\n/g, "\n") : "";
  const limitedLines = normalizedValue.split("\n").slice(0, BIO_MAX_LINES).join("\n");

  if (!maxCharacters) return limitedLines;
  return limitedLines.slice(0, maxCharacters);
};

const Profile = ({ user, videos, isLoadingProfile = false }) => {
  const { width: screenWidth } = useWindowDimensions();
  const { user: loggedInUser, setUser: setLoggedInUser, globalSettings } = useGlobalContext();
  const { theme } = useAppTheme();
  const [activeTab, setActiveTab] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followers, setFollowers] = useState([]);
  const [following, setFollowing] = useState([]);
  const [isLoadingFollow, setIsLoadingFollow] = useState(false);
  const [isEditingBio, setIsEditingBio] = useState(false);
  const [isSavingBio, setIsSavingBio] = useState(false);
  const [savedBio, setSavedBio] = useState("");
  const [bioDraft, setBioDraft] = useState("");
  const [, setPrevFollowerCount] = useState(0);
  const [isProfileLoading, setIsProfileLoading] = useState(true);
  const followerCountAnim = useRef(new Animated.Value(1)).current;
  const hasLoadedOnce = useRef(false);
  const isMaintenance = MaintenanceModules.includes(Modules.chats);

  const nestedScrollEnabled = false;

  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();
  const isLoggedInUser = loggedInUser?.$id === user?.$id;
  const streamService = new StreamService();
  const notificationService = new NotificationService();
  const showProfileSkeleton = isLoadingProfile || !user;
  const bannerHeight = Math.round((screenWidth - 32) / PROFILE_BANNER_ASPECT_RATIO);
  const bannerSourceUri = user?.banner || user?.avatar;
  const bioMaxCharacters = useMemo(() => {
    const parsed = Number(globalSettings?.["PROFILE_BIO_MAX_CHARACTERS"]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 150;
  }, [globalSettings]);

  useEffect(() => {
    const nextBio = normalizeBio(user?.bio ?? user?.about ?? "");
    setSavedBio(nextBio);
    setBioDraft(nextBio);
    setIsEditingBio(false);
  }, [user?.$id, user?.bio, user?.about]);

  const bioText = useMemo(() => {
    if (savedBio.length) return savedBio;
    return isLoggedInUser ? "Add a bio so people can learn more about you." : "No bio yet.";
  }, [isLoggedInUser, savedBio]);

  const normalizedBioDraft = useMemo(() => normalizeBio(bioDraft), [bioDraft]);
  const hasPendingBioChanges = normalizedBioDraft !== savedBio;

  useFocusEffect(
    useCallback(() => {
      fetchFollowingData();
    }, [user]),
  );

  const fetchFollowingData = async () => {
    if (!user) return;
    if (!hasLoadedOnce.current) setIsProfileLoading(true);
    try {
      // Parallelized — previously these three calls were sequentially
      // awaited (isFollowing → followersCount → followingCount), so the
      // stats row took 3 round-trips before painting. The user reported
      // the profile screen feeling laggy on open; the bulk of that wait
      // was these chained awaits. Promise.all collapses it to one RTT.
      const [isFollowingResult, followersCount, followingCount] = await Promise.all([
        !isLoggedInUser ? FollowService.isFollowing({ followerId: loggedInUser?.$id, followingId: user?.$id }) : Promise.resolve(false),
        FollowService.getFollowersCount({ userId: user?.$id }),
        FollowService.getFollowingCount({ userId: user?.$id }),
      ]);

      if (!isLoggedInUser) setIsFollowing(isFollowingResult);
      setFollowers(followersCount);
      setPrevFollowerCount(followers);
      setFollowing(followingCount);
    } catch (err) {
      console.error("Error loading profile data:", err);
      showMessage("❌ Failed to load profile data.");
    } finally {
      setIsProfileLoading(false);
      hasLoadedOnce.current = true;
    }
  };

  const handleFollowFunction = async () => {
    if (isLoadingFollow) return;
    setIsLoadingFollow(true);

    try {
      if (isFollowing) {
        await FollowService.unfollowUser({ followerId: loggedInUser?.$id, followingId: user?.$id });
        setIsFollowing(false);
      } else {
        await FollowService.followUser({ followerId: loggedInUser?.$id, followingId: user?.$id });
        setIsFollowing(true);

        // Prevent duplicate follow notifications on the same day
        const alreadyNotified = await notificationService.checkFollowNotificationExists({
          senderId: loggedInUser?.$id,
          recipientId: user?.$id,
        });

        if (!alreadyNotified) {
          notificationService.notifyUser({
            sender: loggedInUser,
            recipient: user,
            type: "follow",
            resourceId: loggedInUser?.$id,
            message: `started following you`,
          });
        }
      }

      const followersData = await FollowService.getFollowersCount({ userId: user?.$id });
      setPrevFollowerCount(followers.length);
      setFollowers(followersData);

      // Animate follower count change
      Animated.sequence([
        Animated.timing(followerCountAnim, { toValue: 1.2, duration: 150, useNativeDriver: true }),
        Animated.timing(followerCountAnim, { toValue: 1, duration: 150, useNativeDriver: true }),
      ]).start();
    } catch (err) {
      console.error("Follow toggle failed", err);
      showMessage("❌ Something went wrong. Try again.");
    } finally {
      setIsLoadingFollow(false);
    }
  };

  const handleTabPress = (index) => {
    setActiveTab(index);
  };

  const startBioEdit = () => {
    if (!isLoggedInUser) {
      Alert.alert("Unavailable", "You can only edit your own bio.");
      return;
    }

    setBioDraft(applyBioEditorConstraints(savedBio, bioMaxCharacters));
    setIsEditingBio(true);
  };

  const cancelBioEdit = () => {
    setBioDraft(savedBio);
    setIsEditingBio(false);
  };

  const handleBioDraftChange = (value) => {
    setBioDraft(applyBioEditorConstraints(value, bioMaxCharacters));
  };

  const saveBio = async () => {
    if (!isLoggedInUser || isSavingBio || !hasPendingBioChanges) return;

    setIsSavingBio(true);
    try {
      await updateBio(user?.$id, normalizedBioDraft);
      const updatedUser = await getCurrentUserWithoutStream();
      setSavedBio(updatedUser?.bio ?? normalizedBioDraft);
      setBioDraft(updatedUser?.bio ?? normalizedBioDraft);
      setIsEditingBio(false);
      setLoggedInUser(updatedUser);
      showMessage(normalizedBioDraft ? "Bio updated." : "Bio removed.");
    } catch (error) {
      console.error("saveBio: error", error);
      Alert.alert("Error", error?.message || "Could not update your bio.");
    } finally {
      setIsSavingBio(false);
    }
  };

  // Renders the currently active tab's content directly below the shared header
  // (banner/avatar/name/stats/buttons/bio/tab bar). Each tab component receives
  // the shared header as `headerComponent` and mounts it inside its own
  // FlashList ListHeaderComponent so everything scrolls together — web-style.
  const renderActiveTabContent = (sharedHeader) => {
    const tabKey = PROFILE_TABS[activeTab]?.title;
    const commonProps = {
      userId: user?.$id,
      nestedScrollEnabled,
      sectionTitle: null,
      contentPaddingTop: 0,
      headerComponent: sharedHeader,
    };

    switch (tabKey) {
      case "Posts":
        return <ProfilePostTab {...commonProps} />;
      case "Books":
        return <ProfileBooksTab {...commonProps} />;
      case "Videos":
        return <ProfileVideosTab {...commonProps} userVideos={videos} />;
      case "Clips":
        return <ProfileClipsTab {...commonProps} />;
      default:
        return null;
    }
  };

  const handleMessage = async () => {
    if (isMaintenance) {
      showMessage("Chat maintenance in progress.");
      return;
    }
    try {
      const channel = await streamService.createNewChannel({
        currentUser: loggedInUser,
        selectedUsers: [user],
      });
      router.push({
        pathname: "channel",
        params: { channelId: channel.id },
      });
    } catch (error) {
      console.log("handleMessage: error", error);
      if (error?.message?.includes("deleted user") || error?.message?.includes("don't exist")) {
        Alert.alert("Unavailable", "This user's account is no longer active.");
      } else {
        Alert.alert("Error", "Could not start the conversation. Please try again.");
      }
    }
  };

  const navigateToConnections = (initialTab) => {
    router.push({
      pathname: "/user-connections",
      params: {
        followingCount: FormatNumber(following || 0),
        followerCount: FormatNumber(followers || 0),
        initLoadContent: initialTab,
        loggedInUser: user?.$id,
        username: user?.username,
      },
    });
  };

  const renderProfileHeader = () => (
    <View className="pt-2 pb-3">
      <View className="relative">
        <View className="w-full overflow-hidden rounded-2xl" style={{ height: bannerHeight, backgroundColor: theme.surfaceStrong }}>
          {bannerSourceUri ? (
            <FastImage
              source={{ uri: bannerSourceUri, priority: FastImage.priority.high }}
              className="h-full w-full"
              resizeMode={FastImage.resizeMode.cover}
            />
          ) : (
            <View className="h-full w-full" style={{ backgroundColor: theme.surfaceMuted }} />
          )}
          <View className="absolute inset-0" style={{ backgroundColor: theme.mediaOverlay }} />
        </View>

        {/* Kebab — overlays the top-right of the banner, in line with the
            screen header so it reads as part of the navigation chrome rather
            than something tacked on. The trigger is a glass-tinted disc
            (semi-transparent black + white-rim border) so it stays legible
            on any banner image — bright, dark, busy, monochrome. On own
            profile only Share is shown inside the menu; on other users'
            profiles the menu shows Share / Report / Snooze / Block. */}
        <View className="absolute right-3 top-3">
          <ProfileActionsMenu
            targetUser={user}
            isOwnProfile={isLoggedInUser}
            onBlocked={() => router.back()}
          />
        </View>

        <View
          className="absolute -bottom-6 left-4 h-16 w-16 rounded-xl p-0.5"
          style={{ borderWidth: 2, borderColor: theme.background, backgroundColor: theme.surfaceMuted }}
        >
          {user?.avatar ? (
            <FastImage
              source={{ uri: user?.avatar, priority: FastImage.priority.high }}
              className="h-full w-full rounded-lg"
              resizeMode={FastImage.resizeMode.cover}
            />
          ) : (
            <View className="h-full w-full rounded-lg" style={{ backgroundColor: theme.surfaceStrong }} />
          )}
        </View>
      </View>

      <View className="mt-10 flex flex-col space-y-1">
        <View className="flex-row flex-wrap items-center pr-2">
          <Text className="mr-2 text-xl font-bold leading-6" numberOfLines={1} style={{ flexShrink: 1, color: theme.text }}>
            {user?.username || "User"}
          </Text>
          <UserRoleChips user={user} iconSize={20} />
        </View>
      </View>

      {/* Stats row — minimal editorial style, no card, no border, no dividers. Just three
          centered text columns. Larger numbers (text-xl) carry the visual weight; muted
          uppercase labels read as captions. The whitespace alone provides the structure. */}
      <View className="mt-5 flex-row">
        {isProfileLoading ? (
          <>
            {[0, 1, 2].map((idx) => (
              <View key={`stat-skel-${idx}`} className="flex-1 items-center">
                <AnimatedSkeleton className="mb-1.5 h-6 w-12 animate-pulse rounded" style={{ backgroundColor: theme.skeletonBase }} />
                <AnimatedSkeleton className="h-3 w-16 animate-pulse rounded" style={{ backgroundColor: theme.skeletonBase }} />
              </View>
            ))}
          </>
        ) : (
          <>
            <TouchableOpacity activeOpacity={0.7} onPress={() => navigateToConnections("following")} className="flex-1 items-center">
              <Text className="text-xl font-bold" style={{ color: theme.text, letterSpacing: 0.2 }}>
                {FormatNumber(following || 0)}
              </Text>
              <Text className="mt-1 text-[10px] font-semibold uppercase" style={{ color: theme.textSoft, letterSpacing: 0.8 }}>
                Following
              </Text>
            </TouchableOpacity>

            <TouchableOpacity activeOpacity={0.7} onPress={() => navigateToConnections("followers")} className="flex-1 items-center">
              <Animated.View style={{ transform: [{ scale: followerCountAnim }] }}>
                <Text className="text-xl font-bold" style={{ color: theme.text, letterSpacing: 0.2 }}>
                  {FormatNumber(followers || 0)}
                </Text>
              </Animated.View>
              <Text className="mt-1 text-[10px] font-semibold uppercase" style={{ color: theme.textSoft, letterSpacing: 0.8 }}>
                Followers
              </Text>
            </TouchableOpacity>

            <View className="flex-1 items-center">
              <Text className="text-xl font-bold" style={{ color: theme.text, letterSpacing: 0.2 }}>
                0
              </Text>
              <Text className="mt-1 text-[10px] font-semibold uppercase" style={{ color: theme.textSoft, letterSpacing: 0.8 }}>
                Achievements
              </Text>
            </View>
          </>
        )}
      </View>

      {/* Follow + Message — primary violet pill with subtle shadow lift, secondary card pill.
          Same shadow language used by the Books/Videos active tab pill so the screen feels
          continuous with the rest of the app. */}
      {!isLoggedInUser && (
        <View className="mt-4 flex-row" style={{ gap: 10 }}>
          {isProfileLoading ? (
            <>
              <AnimatedSkeleton className="h-[40px] flex-1 animate-pulse rounded-full" style={{ backgroundColor: theme.skeletonBase }} />
              <AnimatedSkeleton className="h-[40px] flex-1 animate-pulse rounded-full" style={{ backgroundColor: theme.skeletonBase }} />
            </>
          ) : (
            <>
              <TouchableOpacity
                onPress={handleFollowFunction}
                disabled={isLoadingFollow}
                activeOpacity={0.85}
                className={`flex-1 flex-row items-center justify-center rounded-full px-4 py-2.5 ${isLoadingFollow ? "opacity-60" : ""}`}
                style={{
                  backgroundColor: isFollowing ? theme.surfaceMuted : theme.primary,
                  borderWidth: isFollowing ? 1 : 0,
                  borderColor: isFollowing ? theme.border : "transparent",
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: isFollowing ? 0 : 0.25,
                  shadowRadius: 8,
                  elevation: isFollowing ? 0 : 3,
                }}
              >
                <MaterialIcons
                  name={isFollowing ? "person-remove" : "person-add"}
                  size={16}
                  color={isFollowing ? theme.icon : theme.primaryContrast}
                  style={{ marginRight: 6 }}
                />
                <Text
                  className="text-sm font-bold"
                  style={{ color: isFollowing ? theme.text : theme.primaryContrast, letterSpacing: 0.2 }}
                >
                  {isLoadingFollow ? "Loading..." : isFollowing ? "Unfollow" : "Follow"}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleMessage}
                activeOpacity={0.85}
                className="flex-1 flex-row items-center justify-center rounded-full px-4 py-2.5"
                style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
              >
                <MaterialIcons name="chat-bubble-outline" size={15} color={theme.icon} style={{ marginRight: 6 }} />
                <Text className="text-sm font-bold" style={{ color: theme.text, letterSpacing: 0.2 }}>
                  Message
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      {/* Bio block — quieter visual: no "Bio" label, just the text itself with an inline
          edit pencil for own profile. Lighter card surface, padded for breathing room. */}
      <View className="mt-4 rounded-2xl p-4" style={{ backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border }}>
        {isEditingBio ? (
          <>
            <View
              className="rounded-2xl px-3 py-2.5"
              style={{ borderWidth: 1, borderColor: theme.inputBorder, backgroundColor: theme.inputBackground }}
            >
              <TextInput
                value={bioDraft}
                onChangeText={handleBioDraftChange}
                multiline
                autoCorrect={false}
                maxLength={bioMaxCharacters}
                placeholder={"Tell people about yourself\nYou can use multiple lines."}
                placeholderTextColor={theme.placeholder}
                textAlignVertical="top"
                className="min-h-[96px] text-sm leading-5"
                style={{ color: theme.inputText }}
              />
            </View>
            <Text className="mt-2 text-xs" style={{ color: theme.textSoft }}>
              {BIO_MAX_LINES} lines max • {bioDraft.length}/{bioMaxCharacters} characters
            </Text>
            <View className="mt-3 flex-row justify-end" style={{ gap: 8 }}>
              <TouchableOpacity
                onPress={cancelBioEdit}
                disabled={isSavingBio}
                activeOpacity={0.85}
                className="rounded-full px-4 py-2"
                style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
              >
                <Text className="text-sm font-semibold" style={{ color: theme.text }}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={saveBio}
                disabled={!hasPendingBioChanges || isSavingBio}
                activeOpacity={0.85}
                className="min-w-[88px] flex-row items-center justify-center rounded-full px-4 py-2"
                style={{
                  backgroundColor: !hasPendingBioChanges || isSavingBio ? theme.surfaceStrong : theme.primary,
                  shadowColor: theme.primary,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: !hasPendingBioChanges || isSavingBio ? 0 : 0.25,
                  shadowRadius: 8,
                  elevation: !hasPendingBioChanges || isSavingBio ? 0 : 3,
                }}
              >
                {isSavingBio ? (
                  <ActivityIndicator size="small" color={theme.primaryContrast} />
                ) : (
                  <Text className="text-sm font-bold" style={{ color: theme.primaryContrast, letterSpacing: 0.2 }}>
                    Save
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <View className="flex-row items-start justify-between" style={{ gap: 12 }}>
            <Text
              className="flex-1 text-sm leading-5"
              style={{ color: savedBio ? theme.textMuted : theme.textSubtle }}
            >
              {bioText}
            </Text>
            {isLoggedInUser ? (
              <TouchableOpacity
                onPress={startBioEdit}
                activeOpacity={0.85}
                className="h-7 w-7 items-center justify-center rounded-full"
                style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
                accessibilityLabel={savedBio ? "Edit bio" : "Add bio"}
              >
                <MaterialIcons name="edit" size={13} color={theme.iconMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
        )}
      </View>
    </View>
  );

  // Premium violet pill tabs — matches the Books / Videos / Home feed tab language. The
  // 3×2 grid of icon-tiles is replaced with a single horizontal scroll row of pills so
  // Profile shares the same nav rhythm as the rest of the app. Active pill gets the violet
  // shadow lift; inactive pills are transparent with muted text.
  const renderTabBar = () => (
    <View className="pb-2 pt-3">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ alignItems: "center", paddingTop: 4, paddingBottom: 8 }}
      >
        {PROFILE_TABS.map(({ title, icon }, index) => {
          const isActive = activeTab === index;
          return (
            <TouchableOpacity
              key={title}
              onPress={() => handleTabPress(index)}
              activeOpacity={0.85}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingVertical: 8,
                paddingHorizontal: 14,
                borderRadius: 999,
                marginRight: 6,
                backgroundColor: isActive ? theme.primary : "transparent",
                borderWidth: isActive ? 0 : 1,
                borderColor: isActive ? "transparent" : theme.border,
                shadowColor: theme.primary,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: isActive ? 0.25 : 0,
                shadowRadius: 8,
                elevation: isActive ? 3 : 0,
              }}
            >
              <MaterialIcons
                name={icon}
                size={14}
                color={isActive ? theme.primaryContrast : theme.iconMuted}
                style={{ marginRight: 6 }}
              />
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: isActive ? "700" : "500",
                  letterSpacing: 0.1,
                  color: isActive ? theme.primaryContrast : theme.textMuted,
                }}
              >
                {title}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <View className="mt-2">
        <StyledDivider color={theme.divider} />
      </View>
    </View>
  );

  if (showProfileSkeleton) {
    return (
      <View className="flex-1">
        <View className="pt-2">
          <AnimatedSkeleton className="w-full rounded-2xl" style={{ height: bannerHeight, backgroundColor: theme.skeletonBase }} />
          <View className="-mt-6 ml-4">
            <AnimatedSkeleton className="h-16 w-16 rounded-xl" style={{ backgroundColor: theme.skeletonBase }} />
          </View>

          <View className="mt-2 ml-[84px] space-y-2">
            <AnimatedSkeleton className="h-4 w-32 rounded" style={{ backgroundColor: theme.skeletonBase }} />
            <AnimatedSkeleton className="h-3 w-40 rounded" style={{ backgroundColor: theme.skeletonBase }} />
          </View>

          <View className="mt-3 flex-row justify-between space-x-2">
            {[0, 1, 2].map((idx) => (
              <View key={idx} className="flex-1 items-center rounded-xl px-3 py-2" style={{ backgroundColor: theme.card }}>
                <AnimatedSkeleton className="mb-1 h-4 w-10 rounded" style={{ backgroundColor: theme.skeletonBase }} />
                <AnimatedSkeleton className="h-3 w-14 rounded" style={{ backgroundColor: theme.skeletonBase }} />
              </View>
            ))}
          </View>

          {!isLoggedInUser && (
            <View className="mt-3 flex-row justify-between space-x-3">
              <AnimatedSkeleton className="h-[36px] flex-1 rounded-full" style={{ backgroundColor: theme.skeletonBase }} />
              <AnimatedSkeleton className="h-[36px] flex-1 rounded-full" style={{ backgroundColor: theme.skeletonBase }} />
            </View>
          )}

          <View className="mt-3 rounded-2xl p-3" style={{ backgroundColor: theme.card }}>
            <AnimatedSkeleton className="h-3 w-20 rounded" style={{ backgroundColor: theme.skeletonBase }} />
            <AnimatedSkeleton className="mt-2 h-3 w-full rounded" style={{ backgroundColor: theme.skeletonBase }} />
            <AnimatedSkeleton className="mt-2 h-3 w-5/6 rounded" style={{ backgroundColor: theme.skeletonBase }} />
          </View>
        </View>

        <View className="mt-4">
          {/* Skeleton matching the new horizontal pill tab bar. */}
          <View className="flex-row pb-2 pt-3" style={{ gap: 6 }}>
            {PROFILE_TABS.map(({ title }) => (
              <AnimatedSkeleton key={`tab-skel-${title}`} className="h-9 w-20 rounded-full" style={{ backgroundColor: theme.skeletonBase }} />
            ))}
          </View>
          <View className="mt-2">
            <StyledDivider color={theme.divider} />
          </View>
          <View className="mt-4 space-y-3">
            <AnimatedSkeleton className="h-40 w-full rounded-2xl" style={{ backgroundColor: theme.skeletonBase }} />
            <AnimatedSkeleton className="h-4 w-[70%] rounded" style={{ backgroundColor: theme.skeletonBase }} />
            <AnimatedSkeleton className="h-4 w-[50%] rounded" style={{ backgroundColor: theme.skeletonBase }} />
          </View>
        </View>
      </View>
    );
  }

  // Web-style layout: the active tab's FlashList is the outer scrollable, with the
  // shared profile header (banner/avatar/name/stats/buttons/bio/tab bar) mounted as
  // its ListHeaderComponent. Switching tabs swaps the tab component but keeps the
  // header's data — feels continuous, scrolls naturally.
  const sharedHeader = (
    <>
      {renderProfileHeader()}
      {renderTabBar()}
    </>
  );

  return (
    <View className="flex-1">
      <View className="flex-1">{renderActiveTabContent(sharedHeader)}</View>
      <CustomAlertModal message={message} messageOpen={messageOpen} closeMessage={closeMessage} />
    </View>
  );
};

export default Profile;
