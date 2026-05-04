// Group info screen — Facebook-style "View members + manage group" surface.
//
// Routes here from the channel header (see SupabaseThread's tap handler).
// Shows for any group conversation; manage affordances render conditionally
// based on whether the viewer is the conversation creator.
//
// Layout (top-to-bottom):
//   1. Back button + screen title.
//   2. Group identity card — large avatar + name. Creator gets a pencil
//      icon to inline-edit the name. (Avatar editing is left for a future
//      pass — needs the same image-picker plumbing that the post composer
//      uses; not gated on tonight's ship.)
//   3. "Add members" row (creator only) — tappable, navigates to the add-
//      members screen.
//   4. Members list. Each row: avatar, username, optional "Creator" badge,
//      optional kick affordance (creator viewing a non-creator member).
//   5. "Leave group" row at the bottom — destructive style, available to
//      every member including the creator (creator leaves means... they
//      lose the group, which is fine for v1; in a future iteration we'd
//      promote the next-oldest member or warn them).
//
// Permission model:
//   The lib/messages-supabase helpers (addGroupMembers, kickGroupMember,
//   updateGroupInfo) enforce creator-only at the call site. This screen
//   ALSO hides the affordances for non-creators so the failure path isn't
//   reachable from the UI under normal use. The two-layer check is
//   intentional — defense in depth against UI bugs.

import { Feather, MaterialIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams, useFocusEffect } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Text, TextInput, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import {
  isGroupCreator,
  kickGroupMember,
  leaveGroup,
  loadGroupMembers,
  updateGroupInfo,
  uploadGroupAvatar,
} from "../../lib/messages-supabase";
import supabase from "../../lib/supabase";
import { optimizedImageUri } from "../../lib/utils/image-source";

const GroupInfo = () => {
  const { theme } = useAppTheme();
  const { chatUserId } = useGlobalContext();
  const { conversationId } = useLocalSearchParams();

  const [conversation, setConversation] = useState(null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Inline name editing — held in local state until "Save" so the user can
  // back out without committing.
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const isCreator = isGroupCreator(conversation, chatUserId);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!conversationId) return;
      if (!silent) setLoading(true);
      try {
        const { conversation: conv, members: mem } = await loadGroupMembers(conversationId);
        setConversation(conv);
        setMembers(mem);
      } catch (e) {
        Alert.alert("Could not load group", e?.message || "Try again.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [conversationId],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Re-fetch when the screen comes back into focus — ensures any change
  // made in the add-members screen (push-then-pop) is reflected here.
  useFocusEffect(
    useCallback(() => {
      load({ silent: true });
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load({ silent: true });
  }, [load]);

  const handleSaveName = useCallback(async () => {
    const trimmed = (draftName || "").trim();
    if (!trimmed) {
      Alert.alert("Name required", "Group name cannot be empty.");
      return;
    }
    if (trimmed === conversation?.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      await updateGroupInfo({ conversationId, name: trimmed });
      setConversation((prev) => (prev ? { ...prev, name: trimmed } : prev));
      setEditingName(false);
    } catch (e) {
      Alert.alert("Could not rename", e?.message || "Try again.");
    } finally {
      setSavingName(false);
    }
  }, [draftName, conversation, conversationId]);

  // Open a member's profile. Mirrors the chat thread's goToProfile helper —
  // resolves Supabase UUID → Appwrite hex via profiles.legacy_appwrite_id
  // (creator-profile expects the hex), then pushes to that route. For
  // members without a legacy_appwrite_id (post-migration signups) we
  // surface a friendly empty alert rather than navigating to a broken
  // profile.
  //
  // Tapping yourself is allowed — same affordance the chat header already
  // gives. The viewer can use Back to return.
  const handleOpenMemberProfile = useCallback(async (member) => {
    if (!member?.id) return;
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("legacy_appwrite_id")
        .eq("id", member.id)
        .maybeSingle();
      if (error) throw error;
      const appwriteId = data?.legacy_appwrite_id;
      if (!appwriteId) {
        Alert.alert("Profile unavailable", "This user's profile isn't ready yet.");
        return;
      }
      router.push({ pathname: "/creator-profile", params: { userId: appwriteId } });
    } catch (e) {
      console.log("[group-info] open profile failed:", e?.message);
      Alert.alert("Profile unavailable", e?.message || "Couldn't load this profile.");
    }
  }, []);

  // Avatar edit — creator only. Launches image picker → compresses + uploads
  // via uploadGroupAvatar → calls updateGroupInfo with the new public URL.
  // Optimistic local update so the new image is visible immediately.
  const handleEditAvatar = useCallback(async () => {
    if (!isCreator || uploadingAvatar) return;
    try {
      // Permission for the photo library. expo-image-picker handles its
      // own "permission denied" UI on iOS — we only surface a soft fallback.
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", "Allow photo access to choose a group picture.");
        return;
      }
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        // Square crop matches the round avatar render — no awkward
        // off-center letterboxing at display time.
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });
      if (picked.canceled || !picked.assets?.[0]?.uri) return;

      setUploadingAvatar(true);
      const localUri = picked.assets[0].uri;
      const publicUrl = await uploadGroupAvatar(localUri, conversationId);
      await updateGroupInfo({ conversationId, avatarUrl: publicUrl });
      setConversation((prev) => (prev ? { ...prev, avatar_url: publicUrl } : prev));
    } catch (e) {
      Alert.alert("Could not update photo", e?.message || "Try again.");
    } finally {
      setUploadingAvatar(false);
    }
  }, [conversationId, isCreator, uploadingAvatar]);

  const handleKick = useCallback(
    (member) => {
      Alert.alert(
        "Remove member",
        `Remove ${member.username || "this user"} from the group?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: async () => {
              try {
                await kickGroupMember({ conversationId, userId: member.id });
                setMembers((prev) => prev.filter((m) => m.id !== member.id));
              } catch (e) {
                Alert.alert("Could not remove", e?.message || "Try again.");
              }
            },
          },
        ],
      );
    },
    [conversationId],
  );

  const handleLeave = useCallback(() => {
    Alert.alert(
      "Leave group",
      "You'll stop receiving messages from this group. You won't be added back unless someone invites you.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Leave",
          style: "destructive",
          onPress: async () => {
            try {
              await leaveGroup(conversationId);
              // Exit out of the group surface entirely. Pop twice so we
              // skip the now-stale thread screen and land on the chat list.
              router.replace("/(message)/channel-list");
            } catch (e) {
              Alert.alert("Could not leave", e?.message || "Try again.");
            }
          },
        },
      ],
    );
  }, [conversationId]);

  // ── Render ──────────────────────────────────────────────────────────

  const renderMember = ({ item }) => {
    const showKick = isCreator && !item.isCreator;
    return (
      <TouchableOpacity
        onPress={() => handleOpenMemberProfile(item)}
        activeOpacity={0.85}
        className="flex-row items-center px-4 py-3"
        style={{ borderBottomWidth: 0.5, borderBottomColor: theme.divider }}
      >
        {item.avatar_url ? (
          <FastImage
            source={{ uri: optimizedImageUri(item.avatar_url, { width: 44 }) }}
            style={{ width: 44, height: 44, borderRadius: 999, backgroundColor: theme.surfaceMuted }}
          />
        ) : (
          <View
            className="items-center justify-center"
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              backgroundColor: theme.primarySoft,
              borderWidth: 1,
              borderColor: theme.primary,
            }}
          >
            <Text className="font-pbold" style={{ color: theme.primary, fontSize: 14 }}>
              {(item.username || "?").slice(0, 1).toUpperCase()}
            </Text>
          </View>
        )}
        <View className="ml-3 flex-1">
          <Text className="font-pbold text-base" style={{ color: theme.text }} numberOfLines={1}>
            {item.username || "Unknown"}
            {item.id === chatUserId ? " (You)" : ""}
          </Text>
          {item.isCreator ? (
            <Text className="text-xs" style={{ color: theme.primary }}>
              Creator
            </Text>
          ) : null}
        </View>
        {showKick ? (
          <TouchableOpacity
            onPress={() => handleKick(item)}
            activeOpacity={0.85}
            className="h-9 w-9 items-center justify-center rounded-full"
            style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
          >
            <Feather name="x" size={16} color={theme.icon} />
          </TouchableOpacity>
        ) : null}
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center" style={{ backgroundColor: theme.background }}>
        <ActivityIndicator size="large" color={theme.primary} />
      </SafeAreaView>
    );
  }

  if (!conversation) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center px-6" style={{ backgroundColor: theme.background }}>
        <Text className="font-pbold text-base" style={{ color: theme.text }}>
          Group not found
        </Text>
        <TouchableOpacity onPress={() => router.back()} className="mt-3">
          <Text className="text-sm" style={{ color: theme.primary }}>
            Go back
          </Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const headerName = conversation.name || (members.map((m) => m.username).slice(0, 3).join(", ") || "Group");

  // List header — group identity + manage rows. Rendered as a FlatList header
  // so the whole screen scrolls as one unit on small devices.
  const ListHeader = (
    <View>
      {/* Group identity */}
      <View className="items-center pt-4 pb-6">
        <TouchableOpacity
          onPress={handleEditAvatar}
          disabled={!isCreator || uploadingAvatar}
          activeOpacity={isCreator ? 0.85 : 1}
          style={{ position: "relative" }}
        >
          {conversation.avatar_url ? (
            <FastImage
              source={{ uri: optimizedImageUri(conversation.avatar_url, { width: 96 }) }}
              style={{ width: 96, height: 96, borderRadius: 999, backgroundColor: theme.surfaceMuted }}
            />
          ) : (
            <View
              className="items-center justify-center"
              style={{
                width: 96,
                height: 96,
                borderRadius: 999,
                backgroundColor: theme.primarySoft,
                borderWidth: 1,
                borderColor: theme.primary,
              }}
            >
              <Text className="font-pbold" style={{ color: theme.primary, fontSize: 32 }}>
                {(headerName || "?").slice(0, 1).toUpperCase()}
              </Text>
            </View>
          )}
          {/* Camera badge on the avatar — only renders for the creator
              so non-creators don't get a "tap me" affordance they can't
              act on. While uploading, swap the camera for a spinner. */}
          {isCreator ? (
            <View
              style={{
                position: "absolute",
                bottom: 0,
                right: 0,
                width: 32,
                height: 32,
                borderRadius: 999,
                backgroundColor: theme.primary,
                borderWidth: 2,
                borderColor: theme.background,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {uploadingAvatar ? (
                <ActivityIndicator size="small" color={theme.primaryContrast} />
              ) : (
                <Feather name="camera" size={14} color={theme.primaryContrast} />
              )}
            </View>
          ) : null}
        </TouchableOpacity>

        {editingName ? (
          <View className="mt-3 w-full px-6">
            <TextInput
              value={draftName}
              onChangeText={setDraftName}
              autoFocus
              maxLength={60}
              className="rounded-2xl px-3 py-2.5 text-center text-base font-pbold"
              style={{
                borderWidth: 1,
                borderColor: theme.inputBorder,
                backgroundColor: theme.inputBackground,
                color: theme.inputText,
              }}
              placeholder="Group name"
              placeholderTextColor={theme.placeholder}
            />
            <View className="mt-2 flex-row justify-center">
              <TouchableOpacity
                onPress={() => {
                  setEditingName(false);
                  setDraftName(conversation.name || "");
                }}
                className="mr-2 rounded-full px-4 py-2"
                style={{ backgroundColor: theme.surfaceMuted, borderWidth: 1, borderColor: theme.border }}
              >
                <Text className="font-pbold text-sm" style={{ color: theme.text }}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSaveName}
                disabled={savingName}
                className="rounded-full px-4 py-2"
                style={{ backgroundColor: theme.primary, opacity: savingName ? 0.6 : 1 }}
              >
                {savingName ? (
                  <ActivityIndicator size="small" color={theme.primaryContrast} />
                ) : (
                  <Text className="font-pbold text-sm" style={{ color: theme.primaryContrast }}>
                    Save
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity
            disabled={!isCreator}
            onPress={() => {
              setDraftName(conversation.name || "");
              setEditingName(true);
            }}
            className="mt-3 flex-row items-center"
            activeOpacity={isCreator ? 0.85 : 1}
          >
            <Text className="font-pbold text-xl" style={{ color: theme.text }} numberOfLines={2}>
              {headerName}
            </Text>
            {isCreator ? <Feather name="edit-2" size={14} color={theme.iconMuted} style={{ marginLeft: 6 }} /> : null}
          </TouchableOpacity>
        )}
        <Text className="mt-1 text-xs" style={{ color: theme.textSoft }}>
          {members.length} {members.length === 1 ? "member" : "members"}
        </Text>
      </View>

      {/* Add members row — creator only */}
      {isCreator ? (
        <TouchableOpacity
          onPress={() =>
            router.push({ pathname: "/(message)/group-add-members", params: { conversationId } })
          }
          activeOpacity={0.85}
          className="flex-row items-center px-4 py-3"
          style={{ borderTopWidth: 0.5, borderBottomWidth: 0.5, borderColor: theme.divider }}
        >
          <View
            className="items-center justify-center"
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              backgroundColor: theme.primarySoft,
              borderWidth: 1,
              borderColor: theme.primary,
            }}
          >
            <Feather name="user-plus" size={18} color={theme.primary} />
          </View>
          <Text className="ml-3 flex-1 font-pbold text-base" style={{ color: theme.text }}>
            Add members
          </Text>
          <Feather name="chevron-right" size={18} color={theme.iconMuted} />
        </TouchableOpacity>
      ) : null}

      {/* Section label above member list */}
      <Text className="px-4 pb-1 pt-4 text-xs uppercase tracking-wide" style={{ color: theme.textSoft }}>
        Members
      </Text>
    </View>
  );

  // List footer — leave group (destructive). Always shown.
  const ListFooter = (
    <TouchableOpacity
      onPress={handleLeave}
      activeOpacity={0.85}
      className="mx-4 mt-6 mb-10 flex-row items-center justify-center rounded-2xl py-3"
      style={{ borderWidth: 1, borderColor: "#ef4444", backgroundColor: theme.background }}
    >
      <Feather name="log-out" size={16} color="#ef4444" />
      <Text className="ml-2 font-pbold text-sm" style={{ color: "#ef4444" }}>
        Leave group
      </Text>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
      {/* Top bar */}
      <View className="flex-row items-center px-4 pb-3 pt-2">
        <TouchableOpacity
          onPress={() => router.back()}
          activeOpacity={0.85}
          className="h-10 w-10 items-center justify-center rounded-full"
          style={{ borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
        >
          <MaterialIcons name="arrow-back" size={20} color={theme.icon} />
        </TouchableOpacity>
        <Text className="ml-3 flex-1 font-pbold text-2xl" style={{ color: theme.text }}>
          Group info
        </Text>
      </View>

      <FlatList
        data={members}
        keyExtractor={(item) => item.id}
        renderItem={renderMember}
        ListHeaderComponent={ListHeader}
        ListFooterComponent={ListFooter}
        refreshing={refreshing}
        onRefresh={onRefresh}
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </SafeAreaView>
  );
};

export default GroupInfo;
