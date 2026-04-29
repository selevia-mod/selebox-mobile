import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { CustomAlertModal, MessageAddUserModal } from "../../components";
import AnimatedSkeleton, { getRandomSkeletonWidth } from "../../components/AnimatedSkeleton";
import { StackedAvatars } from "../../components/StackedAvatars";
import { streamClient } from "../../lib/stream";
import { useModalMessage } from "../../lib/useModalMessage";

const ChannelSettings = () => {
  const { channelId } = useLocalSearchParams();
  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();

  const [channelSettingsLoading, setChannelSettingsLoading] = useState(true);
  const [channel, setChannel] = useState(null);
  const [members, setMembers] = useState([]);
  const [addUserVisible, setAddUserVisible] = useState(false);
  const [currentUser, setCurrentUser] = useState(streamClient.user);

  const isGroup = channel?.data?.member_count > 2 || channel?.data?.isGroup;
  const isGroupOwner = channel?.data?.created_by?.id === currentUser?.id;

  useEffect(() => {
    const loadChannelData = async () => {
      const ch = streamClient.channel("messaging", channelId);
      await ch.watch();
      setChannel(ch);

      const memberRes = await ch.queryMembers({});
      const streamUsers = memberRes.members.map((m) => m.user);

      setMembers(streamUsers);
      setChannelSettingsLoading(false);
    };

    if (channelId) {
      loadChannelData();
    }
  }, [channel, channelId]);

  const { displayName, avatars, isOnline } = useMemo(() => {
    if (!channel) return { displayName: "", avatars: [], isOnline: false };
    const members = Object.values(channel?.state?.members).filter((m) => m.user?.id !== streamClient.userID);

    // Group
    if (channel.data?.member_count > 2) {
      const groupName =
        channel.data?.name ||
        members
          .map((m) => m.user?.name)
          .filter(Boolean)
          .join(", ");

      // If no channel image, take first 3 member images
      const groupAvatars = channel.data?.image ? [channel.data.image] : members.map((m) => m.user?.image).filter(Boolean);

      return {
        displayName: groupName || "Group Chat",
        avatars: groupAvatars,
        isOnline: false,
      };
    }

    // 1:1
    const otherMember = members.find((m) => m.user?.id !== currentUser.id);

    return {
      displayName: otherMember?.user?.name || "Chat",
      avatars: [otherMember?.user?.image].filter(Boolean),
      isOnline: otherMember?.user?.online ?? false,
    };
  }, [channel?.state.members, streamClient.userID]);

  const handleViewUser = async (item) => {
    if (currentUser.id === item.id) router.push("profile");
    else router.push({ pathname: "creator-profile", params: { userId: item.id } });
  };

  const handleAddUsers = async (users) => {
    try {
      const newUserIds = users.map((u) => u.$id);
      await channel.addMembers(newUserIds, { text: `Group owner added ${users.map((u) => u.username).join(", ")} to the group` });
      const memberRes = await channel.queryMembers({});
      setMembers(memberRes.members.map((m) => m.user));
      setAddUserVisible(false);
      Alert.alert("Success", "Successfully added user(s) to the group");
    } catch (error) {
      console.log("handleAddUsers error", error);
    }
  };

  const handleRemoveUser = async (user) => {
    try {
      await channel.removeMembers([user.id], { text: `Group owner removed ${user.name} from the group` });
      const memberRes = await channel.queryMembers({});
      setMembers(memberRes.members.map((m) => m.user));
      Alert.alert("Success", "Successfully removed user from the group");
    } catch (error) {
      console.log("handleRemoveUser error", error);
    }
  };

  const handleLeaveChat = async () => {
    try {
      await channel.removeMembers([currentUser.id], { text: `${currentUser.name} left the group chat` });
      router.dismiss(3);
    } catch (error) {
      console.log("handleLeaveChat error", error);
    }
  };

  const removeUser = (item) => {
    Alert.alert("Remove", "Are you sure you want to remove this user?", [
      { text: "Cancel", style: "cancel" },
      { text: "Yes", onPress: () => handleRemoveUser(item) },
    ]);
  };

  const leaveChat = () => {
    Alert.alert("Leave", "Are you sure you want to leave this group chat?", [
      { text: "Cancel", style: "cancel" },
      { text: "Yes", onPress: () => handleLeaveChat() },
    ]);
  };

  const handleDevInProgress = () => showMessage("🚧 New Feature Incoming! \n\n 🚀Something awesome is in the works—stay tuned!", 400);

  return (
    <SafeAreaView className="flex-1 bg-gray-900">
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 pb-3 pt-2">
        <View className="flex-row items-center">
          <TouchableOpacity
            onPress={() => router.back()}
            className="h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5"
          >
            <MaterialIcons name="arrow-back" size={20} color="white" />
          </TouchableOpacity>
          <Text className="ml-3 font-sans text-2xl font-bold text-white">Chat Info</Text>
        </View>
      </View>

      {channelSettingsLoading ? (
        <View className="flex-1 px-4">
          {/* Avatar skeleton */}
          <View className="items-center py-4">
            <AnimatedSkeleton className="h-[100px] w-[100px] rounded-full bg-white/10" />
            <AnimatedSkeleton className="mt-3 h-6 w-40 rounded-lg bg-white/15" />
          </View>

          {/* Members header skeleton */}
          <View className="mt-2 flex-row items-center">
            <View style={{ backgroundColor: "rgba(20,184,166,0.15)", borderRadius: 8, padding: 6, marginRight: 8 }}>
              <Ionicons name="people" size={14} color="#14b8a6" />
            </View>
            <AnimatedSkeleton className="h-4 w-20 rounded-md bg-white/15" />
          </View>

          {/* Member card skeletons */}
          {[...Array(3)].map((_, index) => (
            <View key={index} className="mt-2 flex-row items-center rounded-2xl bg-white/5 p-3">
              <AnimatedSkeleton className="h-12 w-12 rounded-xl bg-white/10" />
              <View className="ml-4 flex-1">
                <AnimatedSkeleton className="h-4 rounded-lg bg-white/15" style={{ width: getRandomSkeletonWidth() }} />
                <AnimatedSkeleton className="mt-2 h-3 w-16 rounded-md bg-white/10" />
              </View>
            </View>
          ))}

          {/* Settings header skeleton */}
          <View className="mt-6 flex-row items-center">
            <View style={{ backgroundColor: "rgba(148,163,184,0.15)", borderRadius: 8, padding: 6, marginRight: 8 }}>
              <Ionicons name="settings-outline" size={14} color="#94a3b8" />
            </View>
            <AnimatedSkeleton className="h-4 w-20 rounded-md bg-white/15" />
          </View>

          {/* Settings card skeletons */}
          <View className="mt-2 rounded-2xl bg-white/5 p-2">
            {[...Array(2)].map((_, index) => (
              <View key={index} className="flex-row items-center p-3">
                <AnimatedSkeleton className="h-9 w-9 rounded-xl bg-white/10" />
                <AnimatedSkeleton className="ml-3 h-4 w-32 rounded-md bg-white/15" />
              </View>
            ))}
          </View>
        </View>
      ) : (
        <>
          {/* Avatar & Name */}
          <View className="items-center px-4 py-2">
            <StackedAvatars avatars={avatars} size={100} />
            <Text className="pt-2 text-center font-sans text-2xl font-bold text-white">{displayName}</Text>
          </View>

          {/* Members List */}
          <ScrollView showsVerticalScrollIndicator={false}>
            <View className="px-4 py-2">
              <View className="flex-row items-center justify-between mb-2">
                <View className="flex-row items-center">
                  <Ionicons name="people" size={16} color="#14b8a6" style={{ marginRight: 6 }} />
                  <Text className="font-sans text-base font-bold tracking-[1px] text-white">Members</Text>
                </View>
                {isGroup && isGroupOwner && (
                  <TouchableOpacity onPress={() => setAddUserVisible(true)}>
                    <View style={{ backgroundColor: "rgba(121,117,212,0.15)", borderRadius: 999, padding: 8 }}>
                      <Ionicons name="person-add" size={18} color="#7975D4" />
                    </View>
                  </TouchableOpacity>
                )}
              </View>

              {members.map((item) => (
                <TouchableOpacity
                  onPress={() => handleViewUser(item)}
                  key={item.id}
                  className="mb-2 flex-row items-center justify-between rounded-2xl bg-white/5 p-3"
                >
                  <View className="flex-row items-center">
                    <FastImage source={{ uri: item.image, priority: FastImage.priority.high }} className="h-12 w-12 rounded-xl bg-white/10" />
                    <View className="ml-4">
                      <View className="flex-row items-center">
                        <Text className="font-sans text-base font-medium text-white">{item.name}</Text>
                        {item.id === currentUser.id && (
                          <View
                            style={{
                              backgroundColor: "rgba(121,117,212,0.2)",
                              paddingHorizontal: 6,
                              paddingVertical: 2,
                              borderRadius: 6,
                              marginLeft: 6,
                            }}
                          >
                            <Text style={{ fontSize: 11, color: "#a78bfa", fontWeight: "600" }}>You</Text>
                          </View>
                        )}
                        {item.id === channel?.data?.created_by?.id && (
                          <View
                            style={{
                              backgroundColor: "rgba(245,158,11,0.2)",
                              paddingHorizontal: 6,
                              paddingVertical: 2,
                              borderRadius: 6,
                              marginLeft: 6,
                            }}
                          >
                            <Text style={{ fontSize: 11, color: "#f59e0b", fontWeight: "600" }}>Owner</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  </View>
                  {isGroup && isGroupOwner && item.id !== currentUser.id && (
                    <TouchableOpacity onPress={() => removeUser(item)} className="rounded-xl border border-red-500/30 bg-red-500/10 px-2 py-1">
                      <Text className="text-red-400">Remove</Text>
                    </TouchableOpacity>
                  )}
                </TouchableOpacity>
              ))}
            </View>

            {/* Settings */}
            <View className="px-4 py-2">
              <View className="flex-row items-center">
                <Ionicons name="settings-outline" size={16} color="#94a3b8" style={{ marginRight: 6 }} />
                <Text className="font-sans text-base font-bold tracking-[1px] text-white">Settings</Text>
              </View>
              <View className="mt-2 rounded-2xl bg-white/5 p-2">
                <TouchableOpacity onPress={handleDevInProgress} className="flex-row items-center justify-between p-3">
                  <View className="flex-row items-center">
                    <View style={{ backgroundColor: "rgba(59,130,246,0.15)", borderRadius: 12, padding: 8, marginRight: 12 }}>
                      <Ionicons name="images-outline" size={20} color="#3b82f6" />
                    </View>
                    <Text className="text-md font-sans font-semibold text-white">View attachments</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.3)" />
                </TouchableOpacity>

                {isGroup && !isGroupOwner && (
                  <TouchableOpacity onPress={leaveChat} className="flex-row items-center p-3">
                    <View style={{ backgroundColor: "rgba(239,68,68,0.15)", borderRadius: 12, padding: 8, marginRight: 12 }}>
                      <Ionicons name="exit-outline" size={20} color="#ef4444" />
                    </View>
                    <Text className="text-md font-sans font-semibold text-red-500">Leave chat</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </ScrollView>
        </>
      )}

      {/* Modals */}
      <CustomAlertModal message={message} messageOpen={messageOpen} closeMessage={closeMessage} />
      <MessageAddUserModal
        existingUsers={members.map((m) => m.id)}
        isVisible={addUserVisible}
        onClose={() => setAddUserVisible(false)}
        handleAddUsers={handleAddUsers}
      />
    </SafeAreaView>
  );
};

export default ChannelSettings;
