import { Feather, FontAwesome6, MaterialCommunityIcons, MaterialIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import { RefreshControl, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ChannelList, ChannelPreviewMessenger } from "stream-chat-expo";
import { CustomAlertModal } from "../../components";
import { StackedAvatars } from "../../components/StackedAvatars";
import { MaintenanceModules, Modules } from "../../constants/app";
import { useGlobalContext } from "../../context/global-provider";
import useAppTheme from "../../hooks/useAppTheme";
import { streamClient } from "../../lib/stream";
import { useModalMessage } from "../../hooks/useModalMessage";

const ChannelListScreen = () => {
  const { theme } = useAppTheme();
  const { user } = useGlobalContext();
  const [refreshing, setRefreshing] = React.useState(false);
  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();
  const filters = { members: { $in: [streamClient.userID] }, "member.user.name": { $eq: user?.username } };
  const sort = { last_message_at: -1 };
  const options = {
    state: true,
    watch: true,
    presence: true,
  };
  const isMaintenance = MaintenanceModules.includes(Modules.chats);

  const CustomPreviewAvatar = ({ channel }) => {
    // Only active members (skip removed/null users)
    const members = Object.values(channel.state.members).filter((m) => m.user?.id !== streamClient.userID);

    if ((channel.data?.member_count ?? 0) > 2 || channel?.data?.isGroup) {
      const groupAvatars = channel.data?.image ? [channel.data.image] : members.map((m) => m.user?.image).filter(Boolean);
      return <StackedAvatars avatars={groupAvatars} size={45} />;
    }

    const otherMember = members.find((m) => m.user?.id !== streamClient.userID);
    return <StackedAvatars avatars={[otherMember?.user?.image].filter(Boolean)} size={45} isOnline={otherMember?.user?.online} />;
  };

  const CustomChannelPreview = (props) => {
    const { channel } = props;

    // check if current user is still a member
    const isMember = !!channel.state.members[streamClient.userID];

    if (!isMember) {
      return null; // hide the channel completely
    }

    return <ChannelPreviewMessenger {...props} PreviewAvatar={(avatarProps) => <CustomPreviewAvatar {...avatarProps} channel={channel} />} />;
  };

  return (
    <SafeAreaView className="flex-1" style={{ backgroundColor: theme.background }}>
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 pb-3 pt-2">
        <View className="flex-row items-center">
          <TouchableOpacity
            onPress={() => router.back()}
            className="h-10 w-10 items-center justify-center rounded-full border"
            style={{ borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
          >
            <MaterialIcons name="arrow-back" size={20} color={theme.icon} />
          </TouchableOpacity>
          <Text className="ml-3 font-sans text-2xl font-bold" style={{ color: theme.text }}>
            Messages
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => (isMaintenance ? showMessage("Chat maintenance in progress.") : router.push("new-chat"))}
          className="h-10 w-10 items-center justify-center rounded-full border"
          style={{ borderColor: theme.border, backgroundColor: theme.surfaceMuted }}
        >
          <Feather name="edit" size={18} color={theme.icon} />
        </TouchableOpacity>
      </View>

      {!isMaintenance ? (
        <ChannelList
          filters={filters}
          sort={sort}
          options={options}
          additionalFlatListProps={{
            style: { backgroundColor: theme.background },
            contentContainerStyle: { backgroundColor: theme.background },
            refreshControl: (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => setRefreshing(false)}
                tintColor={theme.primary}
                colors={[theme.primary]}
                titleColor={theme.primary}
              />
            ),
          }}
          numberOfSkeletons={10}
          onSelect={(channel) => {
            router.push({
              pathname: "channel",
              params: { channelId: channel.id },
            });
          }}
          Preview={CustomChannelPreview}
        />
      ) : (
        <View className="flex-1 items-center justify-center px-6">
          <View className="items-center">
            {/* Maintenance Icon */}
            <FontAwesome6 name="screwdriver-wrench" size={80} color={theme.accentAmber} />

            {/* Maintenance Text */}
            <Text className="mt-8 text-center text-4xl font-bold font-pextrabold" style={{ color: theme.text }}>
              MAINTENANCE MODE
            </Text>

            {/* Subtitle */}
            <View className="mt-6 flex-row items-center space-x-2">
              <MaterialCommunityIcons name="clock-outline" size={20} color={theme.textSoft} />
              <Text className="text-center text-base" style={{ color: theme.textSoft }}>
                We'll be back soon
              </Text>
            </View>
          </View>
        </View>
      )}

      <CustomAlertModal message={message} messageOpen={messageOpen} closeMessage={closeMessage} />
    </SafeAreaView>
  );
};

export default ChannelListScreen;
