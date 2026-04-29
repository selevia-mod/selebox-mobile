import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  Platform,
  SafeAreaView,
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
import FormatNumber from "../lib/format-number";
import { NotificationService } from "../lib/notifications";
import { StreamService } from "../lib/stream";
import { useModalMessage } from "../lib/useModalMessage";
import AnimatedSkeleton from "./AnimatedSkeleton";
import CustomAlertModal from "./CustomAlertModal";
import ProfileBooksTab from "./ProfileBooksTab";
import ProfileClipsTab from "./ProfileClipsTab";
import ProfileHomeTab from "./ProfileHomeTab";
import ProfilePlaylistTab from "./ProfilePlaylistTab";
import ProfilePostTab from "./ProfilePostTab";
import ProfileVideosTab from "./ProfileVideosTab";
import StyledDivider from "./StyledDivider";
import UserRoleChips from "./UserRoleChips";

const PROFILE_TABS = [
  { title: "Home", icon: "home" },
  { title: "Books", icon: "menu-book" },
  { title: "Videos", icon: "play-circle-filled" },
  { title: "Posts", icon: "article" },
  { title: "Clips", icon: "movie" },
  { title: "Playlist", icon: "playlist-play" },
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
  const [modalTabIndex, setModalTabIndex] = useState(null);
  const [isModalLoading, setIsModalLoading] = useState(false);
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
      if (!isLoggedInUser && user) {
        const response = await FollowService.isFollowing({ followerId: loggedInUser?.$id, followingId: user?.$id });
        setIsFollowing(response);
      }

      if (user) {
        const followersCount = await FollowService.getFollowersCount({ userId: user?.$id });
        setFollowers(followersCount);
        setPrevFollowerCount(followers);

        const followingCount = await FollowService.getFollowingCount({ userId: user?.$id });
        setFollowing(followingCount);
      }
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
    if (index === 0) {
      setActiveTab(0);
      setModalTabIndex(null);
      return;
    }
    setActiveTab(index);
    setIsModalLoading(true);
    setModalTabIndex(index);
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

  const closeModal = useCallback(() => {
    setModalTabIndex(null);
    setActiveTab(0);
    setIsModalLoading(false);
  }, []);

  // Prevent the modal from covering screens pushed from inside it.
  useFocusEffect(
    useCallback(() => {
      return () => {
        closeModal();
      };
    }, [closeModal]),
  );

  const renderModalSkeleton = () => (
    <View className="flex-1 px-4 pb-4 pt-2">
      <View className="space-y-3">
        {[0, 1, 2, 3].map((item) => (
          <View key={`modal-skeleton-${item}`} className="rounded-2xl p-4" style={{ backgroundColor: theme.card }}>
            <AnimatedSkeleton className="h-4 w-2/3 rounded" style={{ backgroundColor: theme.skeletonBase }} />
            <AnimatedSkeleton className="mt-3 h-3 w-5/6 rounded" style={{ backgroundColor: theme.skeletonBase }} />
            <AnimatedSkeleton className="mt-2 h-3 w-1/2 rounded" style={{ backgroundColor: theme.skeletonBase }} />
          </View>
        ))}
      </View>
    </View>
  );

  const renderModalContent = () => {
    switch (modalTabIndex) {
      case 1:
        return (
          <ProfileBooksTab
            userId={user?.$id}
            nestedScrollEnabled={nestedScrollEnabled}
            sectionTitle={null}
            contentPaddingTop={12}
            onLoadingChange={setIsModalLoading}
            suppressEmptyState={isModalLoading}
          />
        );
      case 2:
        return (
          <ProfileVideosTab
            userId={user?.$id}
            userVideos={videos}
            nestedScrollEnabled={nestedScrollEnabled}
            sectionTitle={null}
            contentPaddingTop={12}
            onLoadingChange={setIsModalLoading}
            suppressEmptyState={isModalLoading}
          />
        );
      case 3:
        return (
          <ProfilePostTab
            userId={user?.$id}
            nestedScrollEnabled={nestedScrollEnabled}
            sectionTitle={null}
            contentPaddingTop={12}
            onLoadingChange={setIsModalLoading}
            suppressEmptyState={isModalLoading}
          />
        );
      case 4:
        return (
          <ProfileClipsTab
            userId={user?.$id}
            nestedScrollEnabled={nestedScrollEnabled}
            sectionTitle={null}
            contentPaddingTop={12}
            onLoadingChange={setIsModalLoading}
            suppressEmptyState={isModalLoading}
          />
        );
      case 5:
        return (
          <ProfilePlaylistTab
            userId={user?.$id}
            nestedScrollEnabled={nestedScrollEnabled}
            sectionTitle={null}
            contentPaddingTop={12}
            onLoadingChange={setIsModalLoading}
            suppressEmptyState={isModalLoading}
          />
        );
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

      <View className="mt-3 flex-row justify-between space-x-2">
        {isProfileLoading ? (
          <>
            <View className="flex-1 items-center rounded-xl px-3 py-2" style={{ backgroundColor: theme.card }}>
              <AnimatedSkeleton className="mb-1 h-4 w-10 animate-pulse rounded" style={{ backgroundColor: theme.skeletonBase }} />
              <AnimatedSkeleton className="h-3 w-14 animate-pulse rounded" style={{ backgroundColor: theme.skeletonBase }} />
            </View>
            <View className="flex-1 items-center rounded-xl px-3 py-2" style={{ backgroundColor: theme.card }}>
              <AnimatedSkeleton className="mb-1 h-4 w-10 animate-pulse rounded" style={{ backgroundColor: theme.skeletonBase }} />
              <AnimatedSkeleton className="h-3 w-14 animate-pulse rounded" style={{ backgroundColor: theme.skeletonBase }} />
            </View>
            <View className="flex-1 items-center rounded-xl px-3 py-2" style={{ backgroundColor: theme.card }}>
              <AnimatedSkeleton className="mb-1 h-4 w-10 animate-pulse rounded" style={{ backgroundColor: theme.skeletonBase }} />
              <AnimatedSkeleton className="h-3 w-14 animate-pulse rounded" style={{ backgroundColor: theme.skeletonBase }} />
            </View>
          </>
        ) : (
          <>
            <TouchableOpacity
              onPress={() => navigateToConnections("following")}
              className="flex-1 items-center rounded-xl px-3 py-2"
              style={{ backgroundColor: theme.surfaceMuted }}
            >
              <Text className="text-base font-bold" style={{ color: theme.text }}>
                {FormatNumber(following || 0)}
              </Text>
              <Text className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: theme.textSoft }}>
                Following
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => navigateToConnections("followers")}
              className="flex-1 items-center rounded-xl px-3 py-2"
              style={{ backgroundColor: theme.surfaceMuted }}
            >
              <Animated.View style={{ transform: [{ scale: followerCountAnim }] }}>
                <Text className="text-base font-bold" style={{ color: theme.text }}>
                  {FormatNumber(followers || 0)}
                </Text>
              </Animated.View>
              <Text className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: theme.textSoft }}>
                Followers
              </Text>
            </TouchableOpacity>

            <View className="flex-1 items-center rounded-xl px-3 py-2" style={{ backgroundColor: theme.surfaceMuted }}>
              <Text className="text-base font-bold" style={{ color: theme.text }}>
                {videos?.length ?? 0}
              </Text>
              <Text className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: theme.textSoft }}>
                Videos
              </Text>
            </View>
          </>
        )}
      </View>

      {!isLoggedInUser && (
        <View className="mt-3 flex-row justify-between space-x-3">
          {isProfileLoading ? (
            <>
              <AnimatedSkeleton className="h-[36px] flex-1 animate-pulse rounded-full" style={{ backgroundColor: theme.skeletonBase }} />
              <AnimatedSkeleton className="h-[36px] flex-1 animate-pulse rounded-full" style={{ backgroundColor: theme.skeletonBase }} />
            </>
          ) : (
            <>
              <TouchableOpacity
                onPress={handleFollowFunction}
                disabled={isLoadingFollow}
                className={`flex-1 flex-row items-center justify-center rounded-full px-4 py-2.5 ${isLoadingFollow ? "opacity-60" : ""}`}
                style={{ backgroundColor: isFollowing ? theme.surfaceMuted : theme.primary }}
              >
                <MaterialIcons
                  name={isFollowing ? "person-remove" : "person-add"}
                  size={16}
                  color={isFollowing ? theme.icon : theme.primaryContrast}
                  style={{ marginRight: 6 }}
                />
                <Text className="font-semibold" style={{ color: isFollowing ? theme.text : theme.primaryContrast }}>
                  {isLoadingFollow ? "Loading..." : isFollowing ? "Unfollow" : "Follow"}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleMessage}
                className="flex-1 flex-row items-center justify-center rounded-full px-4 py-2.5"
                style={{ backgroundColor: theme.surfaceMuted }}
              >
                <MaterialIcons name="chat-bubble" size={15} color={theme.icon} style={{ marginRight: 6 }} />
                <Text className="font-semibold" style={{ color: theme.text }}>
                  Message
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      <View className="mt-3 rounded-2xl p-3" style={{ backgroundColor: theme.card }}>
        <View className="flex-row items-center justify-between">
          <Text className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: theme.textSoft }}>
            Bio
          </Text>
          {isLoggedInUser && !isEditingBio ? (
            <TouchableOpacity
              onPress={startBioEdit}
              activeOpacity={0.8}
              className="flex-row items-center rounded-full px-2.5 py-1"
              style={{ backgroundColor: theme.surfaceMuted }}
            >
              <MaterialIcons name="edit" size={12} color={theme.icon} />
              <Text className="ml-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: theme.text }}>
                {savedBio ? "Edit" : "Add"}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {isEditingBio ? (
          <>
            <View
              className="mt-3 rounded-2xl px-3 py-2.5"
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
            <View className="mt-3 flex-row justify-end space-x-2">
              <TouchableOpacity
                onPress={cancelBioEdit}
                disabled={isSavingBio}
                activeOpacity={0.8}
                className="rounded-full px-4 py-2"
                style={{ backgroundColor: theme.surfaceMuted }}
              >
                <Text className="text-sm font-semibold" style={{ color: theme.text }}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={saveBio}
                disabled={!hasPendingBioChanges || isSavingBio}
                activeOpacity={0.8}
                className="min-w-[88px] flex-row items-center justify-center rounded-full px-4 py-2"
                style={{ backgroundColor: !hasPendingBioChanges || isSavingBio ? theme.surfaceStrong : theme.primary }}
              >
                {isSavingBio ? (
                  <ActivityIndicator size="small" color={theme.primaryContrast} />
                ) : (
                  <Text className="text-sm font-semibold" style={{ color: theme.primaryContrast }}>
                    Save
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <Text className="mt-2 text-sm leading-5" style={{ color: savedBio ? theme.textMuted : theme.textSubtle }}>
            {bioText}
          </Text>
        )}
      </View>
    </View>
  );

  const renderTabBar = () => (
    <View className="pb-3 pt-2">
      <View className="rounded-2xl p-2" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
        <View className="flex-row flex-wrap">
          {PROFILE_TABS.map(({ title, icon }, index) => {
            const isActive = activeTab === index;
            return (
              <View key={title} className="w-1/3 px-1 pb-2">
                <TouchableOpacity
                  className="items-center rounded-xl px-2 py-2"
                  style={{ backgroundColor: isActive ? theme.primarySoft : theme.surfaceMuted }}
                  onPress={() => handleTabPress(index)}
                >
                  <MaterialIcons name={icon} size={16} color={isActive ? theme.primary : theme.iconMuted} />
                  <Text
                    className="mt-1 text-[10px] font-semibold uppercase tracking-wider"
                    style={{ color: isActive ? theme.primary : theme.textSoft }}
                  >
                    {title}
                  </Text>
                  <View className="mt-2 h-1 w-6 rounded-full" style={{ backgroundColor: isActive ? theme.primary : "transparent" }} />
                </TouchableOpacity>
              </View>
            );
          })}
        </View>
      </View>
      <View className="mt-3">
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
          <View className="rounded-2xl p-2" style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.card }}>
            <View className="flex-row flex-wrap">
              {PROFILE_TABS.map(({ title }) => (
                <View key={title} className="w-1/3 px-1 pb-2">
                  <View className="items-center rounded-xl px-2 py-2" style={{ backgroundColor: theme.surfaceMuted }}>
                    <AnimatedSkeleton className="h-3 w-10 rounded" style={{ backgroundColor: theme.skeletonBase }} />
                    <AnimatedSkeleton className="mt-2 h-1 w-6 rounded-full" style={{ backgroundColor: theme.skeletonBase }} />
                  </View>
                </View>
              ))}
            </View>
          </View>
          <View className="mt-3">
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

  return (
    <View className="flex-1">
      <View className="flex-1">
        <ProfileHomeTab
          userId={user?.$id}
          userVideos={videos}
          nestedScrollEnabled={nestedScrollEnabled}
          headerComponent={renderProfileHeader()}
          tabBarComponent={renderTabBar()}
        />
      </View>

      <CustomAlertModal message={message} messageOpen={messageOpen} closeMessage={closeMessage} />

      <Modal
        visible={modalTabIndex !== null}
        animationType="slide"
        presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
        onRequestClose={closeModal}
      >
        <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
          <View className="flex-row items-center justify-between px-4 pb-2 pt-2">
            <Text className="text-lg font-semibold" style={{ color: theme.text }}>
              {PROFILE_TABS[modalTabIndex]?.title ?? ""}
            </Text>
            <TouchableOpacity
              activeOpacity={0.7}
              className="h-9 w-9 items-center justify-center rounded-full"
              style={{ backgroundColor: theme.surfaceMuted }}
              onPress={closeModal}
            >
              <MaterialIcons name="close" size={20} color={theme.icon} />
            </TouchableOpacity>
          </View>
          <View className="flex-1">
            <View className="flex-1 px-4 pb-4">{renderModalContent()}</View>
            {isModalLoading ? (
              <View className="absolute inset-0 h-full w-full" style={{ backgroundColor: theme.background }} pointerEvents="auto">
                <SafeAreaView className="flex-1">{renderModalSkeleton()}</SafeAreaView>
              </View>
            ) : null}
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
};

export default Profile;
