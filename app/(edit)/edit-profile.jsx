import { MaterialIcons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  InteractionManager,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import FastImage from "react-native-fast-image";
import LoaderKit from "react-native-loader-kit";
import Modal from "react-native-modal";
import { useDispatch } from "react-redux";
import { DeleteAccountModal, StyledSafeAreaView, StyledTitle } from "../../components";
import AnimatedSkeleton from "../../components/AnimatedSkeleton";
import BannerCropModal from "../../components/BannerCropModal";
import RoleBadgeIcon from "../../components/RoleBadgeIcon";
import UserRoleChips from "../../components/UserRoleChips";
import { PROFILE_BANNER_ASPECT_RATIO, PROFILE_BANNER_CROP_ASPECT } from "../../constants/profile";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { getCurrentUserWithoutStream, getUsernameChangeStatus, signOut, updateAvatar, updateBanner, updateSelectedRole, updateUsername } from "../../lib/appwrite";
import { cleanupTempFile } from "../../lib/utils/image-utils";
import {
  getActiveSelectedRoleKey,
  getAssignedRoleKeys,
  getRoleBadgeBorderColor,
  getRoleBadgeSurfaceColor,
  ROLE_BADGE_META,
  SELECTABLE_ROLE_KEYS,
} from "../../lib/user-roles";
import { version } from "../../package.json";
import { toggleThemeModeReducer } from "../../store/reducers/app";
import { clearUserReducer, setIsLoggedReducer } from "../../store/reducers/auth";

const ROLE_SELECTION_DURATION_DAYS = 60;
const ROLE_SELECTION_DURATION_MS = ROLE_SELECTION_DURATION_DAYS * 24 * 60 * 60 * 1000;
const CREATOR_BADGE_META = ROLE_BADGE_META.Creator;
const WRITER_BADGE_META = ROLE_BADGE_META.Writer;

const SELECTABLE_ROLE_META = {
  [SELECTABLE_ROLE_KEYS.creator]: {
    label: "Creator",
    actionTitle: "Become a Creator",
    actionSubtitle: "Unlock creator tools and video publishing.",
    iconName: CREATOR_BADGE_META.iconName,
    iconFamily: CREATOR_BADGE_META.iconFamily,
    customIcon: CREATOR_BADGE_META.customIcon,
    iconColor: CREATOR_BADGE_META.color,
    iconBgColor: CREATOR_BADGE_META.bg,
    titleClassName: "text-amber-300",
    successMessage: "Creator role added successfully.",
  },
  [SELECTABLE_ROLE_KEYS.writer]: {
    label: "Writer",
    actionTitle: "Become a Writer",
    actionSubtitle: "Unlock writing tools and publishing access.",
    iconName: WRITER_BADGE_META.iconName,
    iconFamily: WRITER_BADGE_META.iconFamily,
    customIcon: WRITER_BADGE_META.customIcon,
    iconColor: WRITER_BADGE_META.color,
    iconBgColor: WRITER_BADGE_META.bg,
    titleClassName: "text-blue-300",
    successMessage: "Writer role added successfully.",
  },
};

const RoleChips = ({ user }) => <UserRoleChips user={user} iconSize={12} />;

const SectionCard = ({ title, children, accentColor = "#60a5fa", theme }) => (
  <View className="mb-4 rounded-2xl px-3 py-3" style={{ backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border }}>
    <View className="flex-row items-center space-x-2">
      <View style={{ width: 3, height: 14, backgroundColor: accentColor, borderRadius: 2 }} />
      <Text className="text-[11px] font-semibold" style={{ color: theme.textSoft }}>
        {title}
      </Text>
    </View>
    <View className="mt-3">{children}</View>
  </View>
);

const InfoRow = ({ icon, label, value, right, iconBgColor, isLast = false, theme }) => (
  <View className="flex-row items-center justify-between py-3" style={!isLast ? { borderBottomWidth: 1, borderBottomColor: theme.border } : null}>
    <View className="flex-row items-center space-x-3">
      <View className="h-8 w-8 items-center justify-center rounded-full" style={{ backgroundColor: iconBgColor || theme.surfaceMuted }}>
        {icon}
      </View>
      <Text className="text-sm font-semibold" style={{ color: theme.text }}>
        {label}
      </Text>
    </View>
    <View className="ml-3 flex-1 items-end">
      {right || (
        <Text className="text-sm font-semibold" style={{ color: theme.textMuted }} numberOfLines={1} ellipsizeMode="middle">
          {value}
        </Text>
      )}
    </View>
  </View>
);

const ActionRow = ({
  icon,
  iconBgColor,
  iconBorderColor,
  title,
  subtitle,
  onPress,
  titleClassName = "",
  showChevron = true,
  isLast = false,
  theme,
}) => (
  <TouchableOpacity
    onPress={onPress}
    activeOpacity={0.75}
    className="flex-row items-center justify-between py-3"
    style={!isLast ? { borderBottomWidth: 1, borderBottomColor: theme.border } : null}
  >
    <View className="flex-row items-center space-x-3">
      <View
        className="h-9 w-9 items-center justify-center rounded-full"
        style={{
          backgroundColor: iconBgColor || theme.surfaceMuted,
          borderWidth: iconBorderColor && iconBorderColor !== "transparent" ? 1 : 0,
          borderColor: iconBorderColor,
        }}
      >
        {icon}
      </View>
      <View>
        <Text className={`text-sm font-semibold ${titleClassName || ""}`} style={titleClassName ? null : { color: theme.text }}>
          {title}
        </Text>
        {subtitle ? (
          <Text className="mt-0.5 text-xs" style={{ color: theme.textSoft }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
    {showChevron ? <MaterialIcons name="chevron-right" size={20} color={theme.icon} /> : null}
  </TouchableOpacity>
);

const buildRoleExpirationDate = (baseTime = Date.now()) => new Date(baseTime + ROLE_SELECTION_DURATION_MS);

const formatRoleUnlockDate = (date) =>
  date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

const EditProfileSkeleton = () => {
  const { theme } = useAppTheme();
  const { width: screenWidth } = useWindowDimensions();
  const bannerHeight = Math.round((screenWidth - 24) / PROFILE_BANNER_ASPECT_RATIO);
  const infoRows = Array.from({ length: 4 });
  const actionRows = Array.from({ length: 6 });

  return (
    <StyledSafeAreaView style={{ backgroundColor: theme.background }}>
      <View className="h-full w-full">
        <View className="flex-row items-center justify-between px-4 pb-2 pt-2">
          <AnimatedSkeleton className="h-10 w-10 rounded-full" />
          <AnimatedSkeleton className="h-4 w-24 rounded" />
          <View className="h-10 w-10" />
        </View>
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24, paddingHorizontal: 12 }}>
          <AnimatedSkeleton className="mb-3 h-3 w-56 rounded" />

          <View className="mt-1">
            <AnimatedSkeleton className="w-full rounded-xl" style={{ height: bannerHeight }} />
            <View className="absolute bottom-[-20] left-0 right-0 items-center">
              <AnimatedSkeleton className="h-20 w-20 rounded-xl" />
            </View>
          </View>

          <View className="mt-8 items-center">
            <AnimatedSkeleton className="h-4 w-28 rounded" />
            <AnimatedSkeleton className="mt-2 h-3 w-20 rounded" />
          </View>

          <View className="space-y-4 pt-2">
            <View className="rounded-2xl px-3 py-3" style={{ backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border }}>
              <AnimatedSkeleton className="h-3 w-40 rounded" />
              <View className="mt-3 space-y-3">
                {infoRows.map((_, index) => (
                  <View key={`info-skeleton-${index}`} className="flex-row items-center justify-between">
                    <View className="flex-row items-center space-x-3">
                      <AnimatedSkeleton className="h-8 w-8 rounded-full" />
                      <AnimatedSkeleton className="h-4 w-24 rounded" />
                    </View>
                    <AnimatedSkeleton className="h-4 w-24 rounded" />
                  </View>
                ))}
              </View>
            </View>

            <View className="rounded-2xl px-3 py-3" style={{ backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border }}>
              <AnimatedSkeleton className="h-3 w-40 rounded" />
              <View className="mt-3 space-y-3">
                {actionRows.map((_, index) => (
                  <View key={`action-skeleton-${index}`} className="flex-row items-center justify-between">
                    <View className="flex-row items-center space-x-3">
                      <AnimatedSkeleton className="h-9 w-9 rounded-full" />
                      <View>
                        <AnimatedSkeleton className="h-4 w-32 rounded" />
                        <AnimatedSkeleton className="mt-2 h-3 w-24 rounded" />
                      </View>
                    </View>
                    <AnimatedSkeleton className="h-4 w-4 rounded" />
                  </View>
                ))}
              </View>
            </View>
          </View>
        </ScrollView>
      </View>
    </StyledSafeAreaView>
  );
};

const EditProfile = () => {
  const { user, setUser, setIsLogged, avatar, setAvatar } = useGlobalContext();
  const { theme, isDarkMode } = useAppTheme();
  // Sticky "we have a user" flag. The skeleton was flashing when navigating
  // from the profile screen because, for one render cycle during the stack
  // transition, the global context could re-emit a falsy user before settling
  // back to the real value. Once we've seen a non-null user we never flip
  // back to the skeleton — that prevents the swap-back-to-skeleton flicker.
  const hasSeenUserRef = useRef(Boolean(user));
  if (user) hasSeenUserRef.current = true;
  const showSkeleton = !user && !hasSeenUserRef.current;
  const { width: screenWidth } = useWindowDimensions();
  const [username, setUsername] = useState("");
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isSubmitting, setSubmitting] = useState(false);
  const [isEditSheetOpen, setEditSheetOpen] = useState(false);
  const inputRef = useRef(null);
  const dispatch = useDispatch();
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [isBannerCropOpen, setBannerCropOpen] = useState(false);
  const [selectedBannerAsset, setSelectedBannerAsset] = useState(null);
  const [isDeleteModalVisible, setDeleteModalVisible] = useState(false);
  const [roleConfirmation, setRoleConfirmation] = useState({ visible: false, roleKey: null });
  const [isApplyingRoleSelection, setIsApplyingRoleSelection] = useState(false);
  const bannerCropOpenTimerRef = useRef(null);
  const bannerCropOpenTaskRef = useRef(null);
  const roleConfirmationTaskRef = useRef(null);
  const pendingRoleSelectionRef = useRef(null);
  // Rate limit info for username changes (2 per 30 days, server-enforced).
  // Refreshed when the edit sheet opens and after every successful change.
  // null while loading; { changes_remaining, max_per_window, next_change_allowed_at } once fetched.
  const [usernameStatus, setUsernameStatus] = useState(null);
  const currentUsername = user?.username || "";
  const normalizedUsername = username.trim();
  const hasPendingChanges = normalizedUsername.length > 0 && normalizedUsername !== currentUsername;
  const displayUsername = hasPendingChanges ? normalizedUsername : currentUsername;
  const bannerHeight = Math.round((screenWidth - 24) / PROFILE_BANNER_ASPECT_RATIO);
  const bannerPreviewUri = user?.banner || user?.avatar;
  const showBlockingOverlay = isLoggingOut || uploadingAvatar || uploadingBanner;
  const assignedRoleKeys = getAssignedRoleKeys(user);
  const activeSelectedRoleKey = getActiveSelectedRoleKey(user);
  const availableSelectableRoleKeys = Object.keys(SELECTABLE_ROLE_META).filter((roleKey) => !assignedRoleKeys.includes(roleKey));
  const shouldShowRoleActionRows = availableSelectableRoleKeys.length > 0 && !activeSelectedRoleKey;
  const roleConfirmationMeta = roleConfirmation.roleKey ? SELECTABLE_ROLE_META[roleConfirmation.roleKey] : null;
  const roleConfirmationBadgeBgColor = roleConfirmationMeta ? getRoleBadgeSurfaceColor(roleConfirmationMeta.label, theme.isDark, "icon") : null;
  const roleConfirmationBadgeBorderColor = roleConfirmationMeta
    ? getRoleBadgeBorderColor(roleConfirmationMeta.label, theme.isDark, "icon")
    : "transparent";
  const roleUnlockDate = roleConfirmationMeta ? buildRoleExpirationDate() : null;
  const handleThemeModeChange = () => {
    dispatch(toggleThemeModeReducer());
  };

  const openEditSheet = () => {
    if (!hasPendingChanges) setUsername(currentUsername);
    setEditSheetOpen(true);
  };

  const discardUsernameChanges = () => {
    setUsername(currentUsername);
    setEditSheetOpen(false);
  };

  useEffect(() => {
    setUsername(user?.username || "");
  }, [user]);

  useEffect(() => {
    if (!isEditSheetOpen) return;
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 150);
    // Refresh the rate limit status every time the user opens the
    // edit sheet — covers the case where they used a change earlier
    // in the session and the local state is stale.
    let cancelled = false;
    getUsernameChangeStatus()
      .then((status) => {
        if (!cancelled) setUsernameStatus(status);
      })
      .catch((err) => {
        if (!cancelled) console.warn("[edit-profile] username status fetch failed:", err?.message);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isEditSheetOpen]);

  useEffect(() => {
    return () => {
      if (bannerCropOpenTimerRef.current) {
        clearTimeout(bannerCropOpenTimerRef.current);
        bannerCropOpenTimerRef.current = null;
      }
      bannerCropOpenTaskRef.current?.cancel?.();
      bannerCropOpenTaskRef.current = null;
      roleConfirmationTaskRef.current?.cancel?.();
      roleConfirmationTaskRef.current = null;
    };
  }, []);

  const logout = () => {
    Alert.alert(
      "Logout",
      "Are you sure you want to log out?",
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Yes",
          onPress: async () => {
            setIsLoggingOut(true);
            try {
              await signOut();
            } finally {
              setUser(false);
              setIsLogged(false);
              dispatch(clearUserReducer());
              dispatch(setIsLoggedReducer(false));
            }
          },
        },
      ],
      { cancelable: true },
    );
  };

  const openRoleConfirmation = (roleKey) => {
    if (!SELECTABLE_ROLE_META[roleKey] || !availableSelectableRoleKeys.includes(roleKey) || activeSelectedRoleKey || isApplyingRoleSelection) return;

    pendingRoleSelectionRef.current = roleKey;
    roleConfirmationTaskRef.current?.cancel?.();

    const openModal = () => {
      roleConfirmationTaskRef.current = null;
      setRoleConfirmation({ visible: true, roleKey });
    };

    if (Platform.OS === "ios") {
      roleConfirmationTaskRef.current = InteractionManager.runAfterInteractions(openModal);
      return;
    }

    openModal();
  };

  const closeRoleConfirmation = () => {
    if (isApplyingRoleSelection) return;

    roleConfirmationTaskRef.current?.cancel?.();
    roleConfirmationTaskRef.current = null;
    pendingRoleSelectionRef.current = null;
    setRoleConfirmation({ visible: false, roleKey: null });
  };

  const confirmRoleSelection = async () => {
    if (isApplyingRoleSelection) return;

    const roleKey = pendingRoleSelectionRef.current ?? roleConfirmation.roleKey;
    const roleMeta = SELECTABLE_ROLE_META[roleKey];

    if (!roleMeta) {
      closeRoleConfirmation();
      return;
    }

    const badgeExpiration = buildRoleExpirationDate();

    setIsApplyingRoleSelection(true);
    try {
      await updateSelectedRole(user, roleKey, badgeExpiration.toISOString());
      const updatedUser = await getCurrentUserWithoutStream();
      pendingRoleSelectionRef.current = null;
      setRoleConfirmation({ visible: false, roleKey: null });
      setUser(updatedUser);
      Alert.alert("Success", roleMeta.successMessage);
    } catch (error) {
      Alert.alert("Error", error?.message || "Could not update your role.");
    } finally {
      setIsApplyingRoleSelection(false);
    }
  };

  const handleAuthorSection = () => router.push("catalog");

  const handleCreatorSection = () => router.push("/creator-section");

  const handleDownloadSection = () => router.push("download-settings");

  const submit = async () => {
    const nextUsername = username.trim();
    if (!nextUsername || nextUsername === currentUsername) {
      Alert.alert("Invalid", "Username is either empty or unchanged");
      return;
    }

    // Pre-check the rate limit. The server is the source of truth, but
    // catching it here avoids a wasted RPC call when we already know
    // the user is over the limit.
    if (usernameStatus?.ok && usernameStatus.changes_remaining === 0) {
      const nextAllowed = usernameStatus.next_change_allowed_at
        ? new Date(usernameStatus.next_change_allowed_at).toLocaleDateString()
        : null;
      Alert.alert(
        "Limit reached",
        `You can only change your username ${usernameStatus.max_per_window} times every ${usernameStatus.window_days} days.${
          nextAllowed ? `\n\nYou can change it again on ${nextAllowed}.` : ""
        }`,
      );
      return;
    }

    setSubmitting(true);
    try {
      const result = await updateUsername(user?.$id, nextUsername);
      // Optimistically patch the local user state instead of round-
      // tripping through getCurrentUserWithoutStream(). The legacy
      // helper hits Appwrite's account.get() which throws under
      // USE_SUPABASE_AUTH=true. Patching locally is also faster.
      setUser((prev) => (prev ? { ...prev, username: result?.username || nextUsername } : prev));
      setUsername(result?.username || nextUsername);
      // Refresh the rate-limit status so subsequent attempts in the
      // same session reflect the change we just used up.
      getUsernameChangeStatus().then(setUsernameStatus).catch(() => {});
      Alert.alert(
        "Success",
        typeof result?.changes_remaining === "number"
          ? `Username updated. You have ${result.changes_remaining} change${
              result.changes_remaining === 1 ? "" : "s"
            } remaining this month.`
          : "Username updated successfully",
      );
      setEditSheetOpen(false);
    } catch (error) {
      Alert.alert("Error", error.message);
    } finally {
      setSubmitting(false);
    }
  };

  const openAvatarPicker = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Denied", "Please allow access to the photo library.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "Images",
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.25,
    });

    if (!result.canceled && result.assets[0]) {
      const imageAsset = result.assets[0];

      Alert.alert(
        "Update Avatar?",
        "Do you want to upload this image as your new avatar?",
        [
          {
            text: "Cancel",
            style: "cancel",
            onPress: () => {
              // Image discarded
            },
          },
          {
            text: "Upload",
            onPress: async () => {
              setUploadingAvatar(true);
              try {
                const previousAvatar = avatar;
                const response = await updateAvatar({
                  file: imageAsset,
                  userId: user.$id,
                  previousAvatar: previousAvatar,
                });

                setAvatar(response.avatar);
                const updatedUser = await getCurrentUserWithoutStream();
                setUser(updatedUser);

                Alert.alert("Success", "Avatar updated successfully");
              } catch (error) {
                Alert.alert("Avatar Error", error.message);
              } finally {
                setUploadingAvatar(false);
              }
            },
          },
        ],
        { cancelable: true },
      );
    }
  };

  const closeBannerCrop = () => {
    if (uploadingBanner) return;
    if (bannerCropOpenTimerRef.current) {
      clearTimeout(bannerCropOpenTimerRef.current);
      bannerCropOpenTimerRef.current = null;
    }
    bannerCropOpenTaskRef.current?.cancel?.();
    bannerCropOpenTaskRef.current = null;
    setBannerCropOpen(false);
    setSelectedBannerAsset(null);
  };

  const scheduleBannerCropOpen = (asset) => {
    if (!asset?.uri) return;

    if (bannerCropOpenTimerRef.current) {
      clearTimeout(bannerCropOpenTimerRef.current);
      bannerCropOpenTimerRef.current = null;
    }
    bannerCropOpenTaskRef.current?.cancel?.();
    bannerCropOpenTaskRef.current = null;

    setBannerCropOpen(false);
    setSelectedBannerAsset(asset);

    const openDelay = Platform.OS === "ios" ? 450 : 50;

    bannerCropOpenTaskRef.current = InteractionManager.runAfterInteractions(() => {
      bannerCropOpenTimerRef.current = setTimeout(() => {
        setBannerCropOpen(true);
        bannerCropOpenTimerRef.current = null;
      }, openDelay);
    });
  };

  const openBannerPicker = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Denied", "Please allow access to the photo library.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: "Images",
      allowsEditing: true,
      aspect: PROFILE_BANNER_CROP_ASPECT,
      quality: 1,
    });

    if (result.canceled || !result.assets?.[0]) return;

    scheduleBannerCropOpen(result.assets[0]);
  };

  const handleBannerCropComplete = async (croppedBanner) => {
    const originalBannerUri = selectedBannerAsset?.uri;
    setBannerCropOpen(false);
    setUploadingBanner(true);

    try {
      await updateBanner({
        file: croppedBanner,
        userId: user.$id,
        previousBanner: user?.banner,
      });

      const updatedUser = await getCurrentUserWithoutStream();
      setUser(updatedUser);
      Alert.alert("Success", "Banner updated successfully");
      setSelectedBannerAsset(null);
    } catch (error) {
      Alert.alert("Banner Error", error?.message || "Could not update your banner.");
      setBannerCropOpen(true);
    } finally {
      await cleanupTempFile(croppedBanner?.uri, originalBannerUri);
      setUploadingBanner(false);
    }
  };

  return (
    <>
      {showSkeleton ? (
        <EditProfileSkeleton />
      ) : (
        <StyledSafeAreaView style={{ backgroundColor: theme.background }}>
          <View className="h-full w-full">
            {/* Header — matches profile.jsx pattern */}
            <View className="flex-row items-center justify-between px-4 pb-2 pt-2">
              <TouchableOpacity
                activeOpacity={0.7}
                className="h-10 w-10 items-center justify-center rounded-full"
                style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
                onPress={() => router.back()}
              >
                <MaterialIcons name="arrow-back" size={22} color={theme.icon} />
              </TouchableOpacity>
              <View className="flex-row items-center space-x-2">
                <StyledTitle
                  className="py-0"
                  icon={<MaterialIcons name="tune" size={22} color={theme.icon} />}
                  title={"Settings"}
                  titleStyle={{ color: theme.text }}
                />
              </View>
              <View className="h-10 w-10" />
            </View>

            <ScrollView
              className="flex-1"
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingBottom: hasPendingChanges ? 160 : 24, paddingHorizontal: 12 }}
            >
              <Text className="mb-3 text-xs font-semibold" style={{ color: theme.textSoft }}>
                Update your profile and account preferences.
              </Text>

              {/* Banner + Avatar */}
              <View>
                {/* Banner background matches profile.jsx (theme.surfaceStrong)
                    so the navigation transition from profile → settings has
                    no color swap as FastImage re-mounts on the new screen.
                    Previously this used theme.cardStrong, which is a slightly
                    different color and read as a flicker even when the image
                    cache hit instantly. */}
                <View className="w-full overflow-hidden rounded-xl" style={{ height: bannerHeight, backgroundColor: theme.surfaceStrong }}>
                  <FastImage
                    source={{ uri: bannerPreviewUri, priority: FastImage.priority.high }}
                    className="h-full w-full"
                    resizeMode={FastImage.resizeMode.cover}
                  />
                  <View className="absolute inset-0" style={{ backgroundColor: theme.mediaOverlay }} />
                  <View className="absolute right-3 top-3">
                    <TouchableOpacity
                      activeOpacity={0.8}
                      onPress={openBannerPicker}
                      className="flex-row items-center rounded-full px-3 py-1.5"
                      style={{ backgroundColor: theme.mediaOverlayStrong }}
                    >
                      <MaterialIcons name="photo-camera" size={14} color={theme.primaryContrast} />
                      <Text className="ml-1.5 text-xs font-semibold" style={{ color: theme.primaryContrast }}>
                        {user?.banner ? "Edit cover" : "Add cover"}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
                <View className="absolute bottom-[-20] left-0 right-0 items-center">
                  <TouchableOpacity activeOpacity={0.7} onPress={openAvatarPicker}>
                    {/* Avatar placeholder also uses theme.surfaceStrong to
                        match the profile screen's avatar slot — same reason
                        as the banner above. */}
                    <View className="rounded-lg border-2" style={{ borderColor: "rgba(139,134,248,0.6)", backgroundColor: theme.surfaceStrong }}>
                      <FastImage
                        source={{ uri: user?.avatar, priority: FastImage.priority.high }}
                        className="h-20 w-20 rounded-lg"
                        resizeMode={FastImage.resizeMode.cover}
                      />
                    </View>
                    <View className="absolute bottom-[-10] right-[-10] m-1 rounded-full p-[6px]" style={{ backgroundColor: theme.accentPurple }}>
                      <MaterialIcons name="photo-camera" size={15} color={theme.primaryContrast} />
                    </View>
                  </TouchableOpacity>
                </View>
              </View>

              <View className="mt-8 items-center">
                <Text className="text-base font-bold" style={{ color: theme.text }}>
                  {displayUsername || "—"}
                </Text>
                <View className="mt-2">
                  <RoleChips user={user} />
                </View>
              </View>

              <View className="pt-2">
                <SectionCard title="Basic Information" accentColor="#a78bfa" theme={theme}>
                  <InfoRow
                    icon={<MaterialIcons name="badge" size={16} color="#60a5fa" />}
                    iconBgColor="rgba(96,165,250,0.15)"
                    label="User ID"
                    value={user?.accountId}
                    theme={theme}
                  />
                  <InfoRow
                    icon={<MaterialIcons name="email" size={16} color="#34d399" />}
                    iconBgColor="rgba(52,211,153,0.15)"
                    label="Email"
                    value={user?.email}
                    theme={theme}
                  />
                  <InfoRow
                    icon={<MaterialIcons name="alternate-email" size={16} color="#a78bfa" />}
                    iconBgColor="rgba(167,139,250,0.15)"
                    label="Username"
                    right={
                      <View className="flex-row items-center">
                        <Text
                          className="max-w-[140px] text-sm font-semibold"
                          style={{ color: theme.textMuted }}
                          numberOfLines={1}
                          ellipsizeMode="middle"
                        >
                          {displayUsername || "—"}
                        </Text>
                        {hasPendingChanges && (
                          <View className="ml-2 rounded-full bg-yellow-500/20 px-2 py-[2px]">
                            <Text className="text-[10px] font-semibold text-yellow-300">Pending</Text>
                          </View>
                        )}
                        <TouchableOpacity
                          onPress={openEditSheet}
                          className="ml-3 flex-row items-center rounded-full px-2 py-1"
                          style={{ backgroundColor: theme.surfaceMuted }}
                        >
                          <MaterialIcons name="edit" size={12} color={theme.icon} />
                          <Text className="ml-1 text-xs font-semibold" style={{ color: theme.text }}>
                            Edit
                          </Text>
                        </TouchableOpacity>
                      </View>
                    }
                    theme={theme}
                  />
                  <InfoRow
                    icon={<MaterialIcons name="verified-user" size={16} color="#fbbf24" />}
                    iconBgColor="rgba(251,191,36,0.15)"
                    label="Roles"
                    right={<RoleChips user={user} />}
                    theme={theme}
                  />
                  <InfoRow
                    icon={<MaterialIcons name="info" size={16} color="#22d3ee" />}
                    iconBgColor="rgba(34,211,238,0.15)"
                    label="Version"
                    value={version}
                    isLast
                    theme={theme}
                  />
                </SectionCard>

                <SectionCard title="Appearance" accentColor="#60a5fa" theme={theme}>
                  <View className="flex-row items-center justify-between py-3">
                    <View className="flex-row items-center space-x-3">
                      <View className="h-9 w-9 items-center justify-center rounded-full" style={{ backgroundColor: theme.primarySoft }}>
                        <MaterialIcons name={isDarkMode ? "dark-mode" : "light-mode"} size={20} color={theme.primary} />
                      </View>
                      <View>
                        <Text className="text-sm font-semibold" style={{ color: theme.text }}>
                          Dark mode
                        </Text>
                        <Text className="mt-0.5 text-xs" style={{ color: theme.textSoft }}>
                          Turn the app’s dark palette on or off.
                        </Text>
                      </View>
                    </View>
                    <Switch
                      value={isDarkMode}
                      onValueChange={handleThemeModeChange}
                      trackColor={{ false: theme.surfaceStrong, true: theme.primary }}
                      thumbColor={theme.primaryContrast}
                      ios_backgroundColor={theme.surfaceStrong}
                    />
                  </View>
                </SectionCard>

                <SectionCard title="Account Settings" accentColor="#34d399" theme={theme}>
                  <ActionRow
                    onPress={() => router.push("/payments")}
                    icon={<MaterialIcons name="payments" size={20} color="#60a5fa" />}
                    iconBgColor="rgba(96,165,250,0.15)"
                    title="Payments"
                    subtitle="Manage payouts and tax details."
                    theme={theme}
                  />
                  <ActionRow
                    onPress={handleAuthorSection}
                    icon={<MaterialIcons name="create" size={20} color="#fbbf24" />}
                    iconBgColor="rgba(251,191,36,0.15)"
                    title="Author Section"
                    subtitle="Write, edit, and publish stories."
                    theme={theme}
                  />
                  <ActionRow
                    onPress={handleCreatorSection}
                    icon={<MaterialIcons name="videocam" size={20} color="#34d399" />}
                    iconBgColor="rgba(52,211,153,0.15)"
                    title="Creator Section"
                    subtitle="Upload and manage your videos."
                    theme={theme}
                  />
                  <ActionRow
                    onPress={handleDownloadSection}
                    icon={<MaterialIcons name="download" size={20} color="#6e82ffff" />}
                    iconBgColor="rgba(98, 140, 246, 0.15)"
                    title="Downloads"
                    subtitle="Manage download settings."
                    theme={theme}
                  />
                  {shouldShowRoleActionRows && availableSelectableRoleKeys.includes(SELECTABLE_ROLE_KEYS.creator) && (
                    <ActionRow
                      onPress={() => openRoleConfirmation(SELECTABLE_ROLE_KEYS.creator)}
                      icon={<RoleBadgeIcon role={SELECTABLE_ROLE_META[SELECTABLE_ROLE_KEYS.creator].label} size={20} />}
                      iconBgColor={getRoleBadgeSurfaceColor(SELECTABLE_ROLE_META[SELECTABLE_ROLE_KEYS.creator].label, theme.isDark, "icon")}
                      iconBorderColor={getRoleBadgeBorderColor(SELECTABLE_ROLE_META[SELECTABLE_ROLE_KEYS.creator].label, theme.isDark, "icon")}
                      title={SELECTABLE_ROLE_META[SELECTABLE_ROLE_KEYS.creator].actionTitle}
                      subtitle={SELECTABLE_ROLE_META[SELECTABLE_ROLE_KEYS.creator].actionSubtitle}
                      titleClassName={SELECTABLE_ROLE_META[SELECTABLE_ROLE_KEYS.creator].titleClassName}
                      theme={theme}
                    />
                  )}
                  {shouldShowRoleActionRows && availableSelectableRoleKeys.includes(SELECTABLE_ROLE_KEYS.writer) && (
                    <ActionRow
                      onPress={() => openRoleConfirmation(SELECTABLE_ROLE_KEYS.writer)}
                      icon={<RoleBadgeIcon role={SELECTABLE_ROLE_META[SELECTABLE_ROLE_KEYS.writer].label} size={20} />}
                      iconBgColor={SELECTABLE_ROLE_META[SELECTABLE_ROLE_KEYS.writer].iconBgColor}
                      title={SELECTABLE_ROLE_META[SELECTABLE_ROLE_KEYS.writer].actionTitle}
                      subtitle={SELECTABLE_ROLE_META[SELECTABLE_ROLE_KEYS.writer].actionSubtitle}
                      titleClassName={SELECTABLE_ROLE_META[SELECTABLE_ROLE_KEYS.writer].titleClassName}
                      theme={theme}
                    />
                  )}
                  <ActionRow
                    onPress={() => setDeleteModalVisible(true)}
                    icon={<MaterialIcons name="delete-forever" size={20} color="#f87171" />}
                    iconBgColor="rgba(248,113,113,0.15)"
                    title="Delete Profile"
                    subtitle="Permanently remove your account."
                    titleClassName="text-red-400"
                    showChevron={false}
                    theme={theme}
                  />
                  <ActionRow
                    onPress={logout}
                    icon={<MaterialIcons name="logout" size={20} color="#94a3b8" />}
                    iconBgColor="rgba(148,163,184,0.15)"
                    title="Logout"
                    subtitle="Sign out from this device."
                    showChevron={false}
                    isLast
                    theme={theme}
                  />
                </SectionCard>
              </View>
            </ScrollView>

            {hasPendingChanges && (
              <View className="absolute bottom-4 left-0 right-0 px-3">
                <View className="rounded-2xl px-4 py-3" style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}>
                  <View className="flex-row items-center justify-between">
                    <View className="flex-1 pr-3">
                      <Text className="text-sm font-semibold" style={{ color: theme.text }}>
                        Unsaved changes
                      </Text>
                      <Text className="mt-1 text-xs" style={{ color: theme.textMuted }}>
                        Save your new username to update your profile.
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={submit}
                      disabled={isSubmitting}
                      activeOpacity={0.8}
                      className="flex-row items-center rounded-xl px-4 py-2"
                      style={{ backgroundColor: isSubmitting ? theme.surfaceStrong : theme.primary }}
                    >
                      <Text className="font-semibold" style={{ color: theme.primaryContrast }}>
                        {isSubmitting ? "Saving" : "Save"}
                      </Text>
                      {isSubmitting && (
                        <LoaderKit style={{ width: 14, height: 14, marginLeft: 6 }} name={"BallSpinFadeLoader"} color={theme.primaryContrast} />
                      )}
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity onPress={discardUsernameChanges} className="mt-2">
                    <Text className="text-xs" style={{ color: theme.textSoft }}>
                      Discard changes
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        </StyledSafeAreaView>
      )}
      {showBlockingOverlay && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.backdrop, alignItems: "center", justifyContent: "center", zIndex: 999 }]}>
          <View
            className="items-center rounded-2xl px-6 py-5"
            style={{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }}
          >
            <LoaderKit style={{ width: 40, height: 40 }} name={"BallSpinFadeLoader"} color={theme.primaryContrast} />
            <Text className="mt-3 text-xs font-semibold" style={{ color: theme.textMuted }}>
              {uploadingBanner ? "Updating banner..." : uploadingAvatar ? "Uploading avatar..." : "Logging out..."}
            </Text>
          </View>
        </View>
      )}
      <BannerCropModal visible={isBannerCropOpen} asset={selectedBannerAsset} onClose={closeBannerCrop} onComplete={handleBannerCropComplete} />
      <Modal
        isVisible={isEditSheetOpen}
        onBackdropPress={() => setEditSheetOpen(false)}
        onBackButtonPress={() => setEditSheetOpen(false)}
        swipeDirection="down"
        onSwipeComplete={() => setEditSheetOpen(false)}
        style={{ justifyContent: "flex-end", margin: 0 }}
        backdropOpacity={0.6}
        propagateSwipe
      >
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <View className="rounded-3xl px-4 pb-6 pt-4" style={{ backgroundColor: theme.surfaceElevated }}>
            <View className="mx-auto mb-3 h-1 w-10 rounded-full" style={{ backgroundColor: theme.handle }} />
            <Text className="text-base font-semibold" style={{ color: theme.text }}>
              Edit username
            </Text>
            <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
              This will be visible to others.
            </Text>
            <View
              className="mt-4 rounded-xl px-3 py-2"
              style={{ backgroundColor: theme.inputBackground, borderWidth: 1, borderColor: theme.inputBorder }}
            >
              <TextInput
                ref={inputRef}
                style={{ color: theme.inputText }}
                value={username}
                placeholder="Enter username"
                placeholderTextColor={theme.placeholder}
                onChangeText={setUsername}
                textAlignVertical="center"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
              />
            </View>
            <View className="mt-4 flex-row space-x-2">
              <TouchableOpacity
                onPress={() => setEditSheetOpen(false)}
                activeOpacity={0.8}
                className="flex-1 rounded-xl px-3 py-2"
                style={{ backgroundColor: theme.surfaceMuted }}
              >
                <Text className="text-center text-sm font-semibold" style={{ color: theme.text }}>
                  Close
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submit}
                disabled={!hasPendingChanges || isSubmitting}
                activeOpacity={0.8}
                className="flex-1 rounded-xl px-3 py-2"
                style={{ backgroundColor: !hasPendingChanges || isSubmitting ? theme.surfaceStrong : theme.primary }}
              >
                <View className="flex-row items-center justify-center space-x-2">
                  <Text className="text-sm font-semibold" style={{ color: theme.primaryContrast }}>
                    {isSubmitting ? "Saving" : "Save"}
                  </Text>
                  {isSubmitting && <LoaderKit style={{ width: 14, height: 14 }} name={"BallSpinFadeLoader"} color={theme.primaryContrast} />}
                </View>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <Modal
        isVisible={roleConfirmation.visible}
        onBackdropPress={closeRoleConfirmation}
        onBackButtonPress={closeRoleConfirmation}
        backdropOpacity={0.6}
        useNativeDriver
      >
        <View className="rounded-3xl px-5 py-5" style={{ backgroundColor: theme.surfaceElevated }}>
          <View
            className="h-12 w-12 items-center justify-center rounded-2xl"
            style={{
              backgroundColor: roleConfirmationBadgeBgColor || "rgba(255,255,255,0.1)",
              borderWidth: roleConfirmationBadgeBorderColor === "transparent" ? 0 : 1,
              borderColor: roleConfirmationBadgeBorderColor,
            }}
          >
            {roleConfirmationMeta ? <RoleBadgeIcon role={roleConfirmationMeta.label} size={24} /> : null}
          </View>
          <Text className="mt-4 text-lg font-semibold" style={{ color: theme.text }}>
            {roleConfirmationMeta ? `Add ${roleConfirmationMeta.label} role?` : "Confirm role selection"}
          </Text>
          <Text className="mt-2 text-sm leading-5" style={{ color: theme.textMuted }}>
            {roleConfirmationMeta
              ? `If you continue, the ${roleConfirmationMeta.label} role will be added to your account. You can add another role again only after ${ROLE_SELECTION_DURATION_DAYS} days.`
              : "Confirm your role selection to continue."}
          </Text>
          {roleUnlockDate ? (
            <View className="mt-4 rounded-2xl px-3 py-3" style={{ backgroundColor: theme.surfaceMuted }}>
              <Text className="text-xs font-semibold" style={{ color: theme.textSubtle }}>
                Role Duration
              </Text>
              <Text className="mt-1 text-sm font-semibold" style={{ color: theme.text }}>
                {ROLE_SELECTION_DURATION_DAYS} days
              </Text>
              <Text className="mt-1 text-xs leading-5" style={{ color: theme.textSoft }}>
                You can add another role again on or after {formatRoleUnlockDate(roleUnlockDate)}.
              </Text>
            </View>
          ) : null}
          <View className="mt-5 flex-row space-x-2">
            <TouchableOpacity
              onPress={closeRoleConfirmation}
              disabled={isApplyingRoleSelection}
              activeOpacity={0.8}
              className="flex-1 rounded-xl px-3 py-3"
              style={{ backgroundColor: isApplyingRoleSelection ? theme.surface : theme.surfaceMuted }}
            >
              <Text className="text-center text-sm font-semibold" style={{ color: theme.text }}>
                Cancel
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={confirmRoleSelection}
              disabled={!roleConfirmationMeta || isApplyingRoleSelection}
              activeOpacity={0.8}
              className="flex-1 rounded-xl px-3 py-3"
              style={{ backgroundColor: !roleConfirmationMeta || isApplyingRoleSelection ? theme.surfaceStrong : theme.primary }}
            >
              <View className="flex-row items-center justify-center space-x-2">
                <Text className="text-sm font-semibold" style={{ color: theme.primaryContrast }}>
                  {isApplyingRoleSelection ? "Applying" : "Continue"}
                </Text>
                {isApplyingRoleSelection ? (
                  <LoaderKit style={{ width: 14, height: 14 }} name={"BallSpinFadeLoader"} color={theme.primaryContrast} />
                ) : null}
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      <DeleteAccountModal
        isVisible={isDeleteModalVisible}
        onClose={() => setDeleteModalVisible(false)}
        user={user}
        dispatch={dispatch}
        setUser={setUser}
        setIsLogged={setIsLogged}
        clearUserReducer={clearUserReducer}
        setIsLoggedReducer={setIsLoggedReducer}
      />
    </>
  );
};

export default EditProfile;
