import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { StackActions, useNavigation } from "@react-navigation/native";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { CustomAlertModal, MessageAddUserModal, MessageAvatars } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import { MessagesService } from "../../lib/messages";
import { getRoleNames } from "../../lib/user-roles";
import { useModalMessage } from "../../hooks/useModalMessage";

const MessageSettings = () => {
  const navigation = useNavigation();
  const { user, currentChat, setCurrentChat } = useGlobalContext();
  const { message, messageOpen, showMessage, closeMessage } = useModalMessage();
  const [addUserVisible, setAddUserVisible] = useState(false);
  const [chat, setChat] = useState(currentChat);
  const isGroup = chat?.type === "group";
  const isGroupOwner = chat?.createdBy?.$id === user?.$id;

  useEffect(() => {
    setChat({
      ...currentChat,
      otherUsers: currentChat?.otherUsers || [],
    });
  }, [currentChat]);

  const getUserType = (otherUser) => getRoleNames(otherUser).join(", ");

  const handleAddUsers = async (users) => {
    try {
      const newUserIds = users?.map((user) => user?.$id);
      await MessagesService.updateChat({ chatId: chat?.$id, userIds: [...chat?.userIds, ...newUserIds] });
      users?.map(async (user, index) => {
        const messageData = await MessagesService.sendMessage({
          chatId: chat?.$id,
          type: "system",
          message: `Group owner added ${user?.username} to the group`,
        });
        if (index === users?.length - 1) {
          setAddUserVisible(false);
          const updatedChat = await MessagesService.updateChat({ chatId: chat?.$id, lastMessageId: messageData?.$id });
          setCurrentChat({ ...updatedChat, otherUsers: [...chat?.otherUsers, ...users] });
          Alert.alert("Success", "Successfully added user to the group");
        }
      });
    } catch (error) {
      console.log("handleAddUsers: error", error);
    }
  };

  const handleRemoveUser = async (user) => {
    try {
      const updatedUserIds = chat?.userIds.filter((userId) => userId !== user?.$id);
      const updatedOtherUsers = chat?.otherUsers?.filter((otherUser) => otherUser?.$id !== user?.$id);
      await MessagesService.updateChat({ chatId: chat?.$id, userIds: updatedUserIds });
      const messageData = await MessagesService.sendMessage({
        chatId: chat?.$id,
        type: "system",
        message: `Group owner removed ${user?.username} from the group`,
      });
      const updatedChat = await MessagesService.updateChat({ chatId: chat?.$id, lastMessageId: messageData?.$id });
      setCurrentChat({ ...updatedChat, otherUsers: updatedOtherUsers });
      Alert.alert("Success", "Successfully removed user from the group");
    } catch (error) {
      console.log("handleRemoveUser: error", error);
    }
  };

  const handleLeaveChat = async () => {
    try {
      const updatedUserIds = chat?.userIds.filter((userId) => userId !== user?.$id);
      await MessagesService.updateChat({ chatId: chat?.$id, userIds: updatedUserIds });
      const messageData = await MessagesService.sendMessage({
        chatId: chat?.$id,
        type: "system",
        message: `${user?.username} left the group chat`,
      });
      await MessagesService.updateChat({ chatId: chat?.$id, lastMessageId: messageData?.$id });
      navigation.dispatch(StackActions.pop(2));
      navigation.navigate("chats");
    } catch (error) {
      console.log("handleLeaveChat: error", error);
    }
  };

  const removeUser = (item) => {
    Alert.alert(
      "Remove",
      "Are you sure you want to remove this user?",
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Yes",
          onPress: async () => {
            handleRemoveUser(item);
          },
        },
      ],
      { cancelable: true },
    );
  };

  const leaveChat = () => {
    Alert.alert(
      "Leave",
      "Are you sure you want to leave this group chat?",
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Yes",
          onPress: async () => {
            handleLeaveChat();
          },
        },
      ],
      { cancelable: true },
    );
  };

  const handleDevInProgress = () => showMessage("🚧 New Feature Incoming! \n\n 🚀Something awesome is in the works—stay tuned!", 400);

  return (
    <SafeAreaView className="flex-1 bg-gray-900">
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
      <View className="items-center justify-between px-4 py-2">
        <MessageAvatars users={[...(chat?.otherUsers || []), user]} size={100} isGroup={isGroup} />
        <Text className="pt-2 text-center font-sans text-2xl font-bold text-white">
          {isGroup
            ? chat.name ||
              chat.otherUsers
                ?.filter((otherUser) => otherUser?.$id !== user?.$id)
                .map((otherUser) => otherUser?.username)
                .join(", ")
            : (chat?.otherUsers[0]?.username ?? "Deleted user")}
        </Text>
        {!isGroup && <Text className="text-base font-medium text-white">{getUserType(chat?.otherUsers[0])}</Text>}
      </View>
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
          {[...chat?.otherUsers, user]?.map((item) => (
            <TouchableOpacity
              onPress={() => router.push({ pathname: "creator-profile", params: { userId: item?.$id } })}
              key={item?.$id}
              className="mb-2 flex-row items-center justify-between rounded-2xl bg-white/5 p-3"
            >
              <View className="flex-row items-center">
                <FastImage source={{ uri: item?.avatar, priority: FastImage.priority.normal }} className="h-12 w-12 rounded-xl bg-white/10" />
                <View className="ml-4">
                  <View className="flex-row items-center">
                    <Text className="font-sans text-base font-medium text-white">{item?.username ?? "Deleted User"}</Text>
                    {item?.$id === user.$id && (
                      <View
                        style={{ backgroundColor: "rgba(121,117,212,0.2)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginLeft: 6 }}
                      >
                        <Text style={{ fontSize: 11, color: "#a78bfa", fontWeight: "600" }}>You</Text>
                      </View>
                    )}
                    {item?.$id === chat?.createdBy?.$id && (
                      <View
                        style={{ backgroundColor: "rgba(245,158,11,0.2)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginLeft: 6 }}
                      >
                        <Text style={{ fontSize: 11, color: "#f59e0b", fontWeight: "600" }}>Owner</Text>
                      </View>
                    )}
                  </View>
                </View>
              </View>
              {isGroup && isGroupOwner && item?.$id !== user?.$id && (
                <TouchableOpacity onPress={() => removeUser(item)} className="rounded-xl border border-red-500/30 bg-red-500/10 px-2 py-1">
                  <Text className="text-red-400">Remove</Text>
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          ))}
        </View>

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
            <TouchableOpacity onPress={handleDevInProgress} className="flex-row items-center justify-between p-3">
              <View className="flex-row items-center">
                <View style={{ backgroundColor: "rgba(245,158,11,0.15)", borderRadius: 12, padding: 8, marginRight: 12 }}>
                  <Ionicons name="notifications-outline" size={20} color="#f59e0b" />
                </View>
                <Text className="text-md font-sans font-semibold text-white">Notifications</Text>
              </View>
              <View className="flex-row items-center">
                <Text className="mr-3 font-sans text-base font-medium text-white/50">Off</Text>
                <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.3)" />
              </View>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleDevInProgress} className="flex-row items-center justify-between p-3">
              <View className="flex-row items-center">
                <View style={{ backgroundColor: "rgba(34,197,94,0.15)", borderRadius: 12, padding: 8, marginRight: 12 }}>
                  <Ionicons name="checkmark-done-outline" size={20} color="#22c55e" />
                </View>
                <Text className="text-md font-sans font-semibold text-white">Read receipts</Text>
              </View>
              <View className="flex-row items-center">
                <Text className="mr-3 font-sans text-base font-medium text-white/50">Off</Text>
                <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.3)" />
              </View>
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
      <CustomAlertModal message={message} messageOpen={messageOpen} closeMessage={closeMessage} />
      <MessageAddUserModal
        existingUsers={chat?.userIds}
        isVisible={addUserVisible}
        onClose={() => setAddUserVisible(false)}
        handleAddUsers={handleAddUsers}
      />
    </SafeAreaView>
  );
};

export default MessageSettings;
