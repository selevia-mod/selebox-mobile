import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { useIsFocused } from "@react-navigation/native";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Platform, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Channel, MessageInput, MessageList } from "stream-chat-expo";
import { StackedAvatars } from "../../components/StackedAvatars";
import { streamClient } from "../../lib/stream";

const ChannelScreen = () => {
  const { channelId } = useLocalSearchParams();
  const channel = streamClient.channel("messaging", channelId);

  const [members, setMembers] = useState(Object.values(channel.state.members));
  const isFocused = useIsFocused();

  useEffect(() => {
    let mounted = true;

    // Ensure channel is watched
    channel.watch();

    const handleMemberChange = () => {
      if (mounted) {
        setMembers(Object.values(channel.state.members));
      }
    };

    // Listen for Stream membership events
    channel.on("member.added", handleMemberChange);
    channel.on("member.removed", handleMemberChange);

    return () => {
      mounted = false;
      channel.off("member.added", handleMemberChange);
      channel.off("member.removed", handleMemberChange);
    };
  }, [channelId, isFocused]); // re-run when you focus or change channel

  const { displayName, avatars, statusText, isOnline } = useMemo(() => {
    const otherMembers = members.filter((m) => m.user?.id !== streamClient.userID);

    // Group chat
    if ((channel.data?.member_count ?? 0) > 2 || channel?.data?.isGroup) {
      const groupName =
        channel.data?.name ||
        otherMembers
          .map((m) => m.user?.name)
          .filter(Boolean)
          .join(", ");

      const groupAvatars = channel.data?.image ? [channel.data.image] : otherMembers.map((m) => m.user?.image).filter(Boolean);

      return {
        displayName: groupName || "Group Chat",
        avatars: groupAvatars,
        isOnline: false,
        statusText: "",
      };
    }

    // 1:1 chat
    const otherMember = otherMembers.find((m) => m.user?.id !== streamClient.userID);
    const isOnline = otherMember?.user?.online ?? false;
    const lastActive = otherMember?.user?.last_active;

    let statusText = "Inactive";

    if (isOnline) {
      statusText = "Active now";
    } else if (lastActive) {
      const diff = Date.now() - new Date(lastActive).getTime();

      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (seconds < 60) statusText = "Active just now";
      else if (minutes < 60) statusText = `Active ${minutes}m ago`;
      else if (hours < 24) statusText = `Active ${hours}h ago`;
      else statusText = `Active ${days}d ago`;
    }

    return {
      displayName: otherMember?.user?.name || "Chat",
      avatars: [otherMember?.user?.image].filter(Boolean),
      isOnline: otherMember?.user?.online ?? false,
      statusText,
    };
  }, [members, channel.data, streamClient.userID]);

  const handleChannelDetailPress = () => {
    router.push({
      pathname: "channel-settings",
      params: {
        channelId: channel.id,
      },
    });
  };

  const DarkEmptyStateIndicator = () => (
    <View style={{ flex: 1, backgroundColor: "#111827", justifyContent: "center", alignItems: "center" }}>
      <View style={{ backgroundColor: "rgba(121,117,212,0.15)", borderRadius: 999, padding: 20, marginBottom: 12 }}>
        <Ionicons name="chatbubbles-outline" size={40} color="#7975D4" />
      </View>
      <Text style={{ color: "#fff", fontSize: 18, fontWeight: "bold", marginBottom: 4 }}>No messages yet</Text>
      <Text style={{ color: "rgba(255,255,255,0.5)", fontSize: 14 }}>Say hello to start the conversation</Text>
    </View>
  );

  return (
    <SafeAreaView className="flex-1 bg-gray-900">
      {/* Header */}
      <View className="flex-row items-center justify-between border-b border-white/5 px-4 pb-3 pt-2">
        <View className="flex-row items-center">
          <TouchableOpacity
            onPress={() => router.back()}
            className="h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5"
          >
            <MaterialIcons name="arrow-back" size={20} color="white" />
          </TouchableOpacity>

          <TouchableOpacity onPress={handleChannelDetailPress} className="flex-row items-center">
            <StackedAvatars avatars={avatars} isOnline={isOnline} />

            <View className="ml-2">
              <Text className="font-sans text-lg font-bold text-white" style={{ lineHeight: 20 }}>
                {displayName}
              </Text>
              {avatars.length === 1 && (
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  {isOnline && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#22c55e", marginRight: 4 }} />}
                  <Text className="text-xs" style={{ color: isOnline ? "#22c55e" : "rgba(255,255,255,0.5)" }}>
                    {statusText}
                  </Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* Chat */}
      <Channel channel={channel} keyboardVerticalOffset={Platform.OS === "ios" ? -50 : -100}>
        <MessageList
          onThreadSelect={(thread) => {
            router.push({
              pathname: "thread",
              params: {
                channelId: channel.id,
                parentMessageId: thread.id,
              },
            });
          }}
          EmptyStateIndicator={DarkEmptyStateIndicator}
        />
        <View style={{ paddingBottom: Platform.OS === "ios" ? 50 : 100 }}>
          <MessageInput />
        </View>
      </Channel>
    </SafeAreaView>
  );
};

export default ChannelScreen;
