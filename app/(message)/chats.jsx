import { Feather, MaterialIcons, Octicons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MessageAvatars, PostSuggestedCreators } from "../../components";
import AnimatedSkeleton, { getRandomSkeletonWidth } from "../../components/AnimatedSkeleton";
import { useGlobalContext } from "../../context/global-provider";
import { client } from "../../lib/appwrite";
import { MessagesService } from "../../lib/messages";
import secrets from "../../private/secrets";
import useResetOnBlur from "../../hooks/useResetOnBlur";
import logger from "../../lib/utils/logger";
import { formatTime } from "../../utils/formatTime";
import { waitForAppwriteWebSocketReady } from "../../utils/waitUntilRealtimeIsReady";

const Chats = () => {
  const { user, setCurrentChat } = useGlobalContext();
  const [chats, setChats] = useState([]);
  const [chatsLoading, setChatsLoading] = useState(true);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  useResetOnBlur(setRefreshing, setIsFetchingMore);

  useFocusEffect(
    useCallback(() => {
      fetchUserChats();
    }, [user]),
  );

  useEffect(() => {
    // Race-safe realtime subscription. Without `isCancelled`, an unmount that
    // happens while `waitForAppwriteWebSocketReady` is still pending would let
    // the subsequent `client.subscribe` register AFTER cleanup ran, leaking
    // an orphan subscription that fires for the rest of the app session.
    let unsubscribe = null;
    let isCancelled = false;

    const setupRealtimeListeners = async () => {
      try {
        await waitForAppwriteWebSocketReady(secrets.appwriteConfig.projectId, client?.config?.endpoint);
        if (isCancelled) return;
        unsubscribe = client.subscribe(
          `databases.${secrets.appwriteConfig.databaseId}.collections.${secrets.appwriteConfig.chatsCollectionId}.documents`,
          (response) => handleRealTimeChatsEvents(response),
        );
        // Belt-and-suspenders: if cleanup ran between the await and the
        // assignment, immediately unsubscribe what we just registered.
        if (isCancelled && unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      } catch (err) {
        logger.error("Chats", "Realtime subscription failed", err);
      }
    };

    setupRealtimeListeners();

    return () => {
      isCancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const handleRealTimeChatsEvents = async (response) => {
    const isNewDoc = response.events.includes("databases.*.collections.*.documents.*.create");
    const isUpdatedDoc = response.events.includes("databases.*.collections.*.documents.*.update");
    if (isNewDoc) {
      if (response?.payload?.userIds.includes(user?.$id)) {
        const newChat = await MessagesService.getUserChat({
          chatId: response?.payload?.$id,
          senderId: user?.$id,
        });

        setChats((prevChats) => {
          const isExisting = prevChats.some((chat) => chat?.$id === newChat?.$id);
          if (isExisting) return prevChats;

          return [newChat, ...prevChats];
        });
      }
    } else if (isUpdatedDoc) {
      const updated = response.payload;
      const newChat = await MessagesService.getUserChat({
        chatId: updated?.$id,
        senderId: user?.$id,
      });

      setChats((prevChats) => {
        const isCurrentUserInChat = updated.userIds.includes(user.$id);
        const existingChat = prevChats.find((chat) => chat?.$id === updated.$id);

        // If the user has been removed and the chat exists, remove it
        if (!isCurrentUserInChat && existingChat) {
          return prevChats.filter((chat) => chat?.$id !== updated.$id);
        }

        // If user is part of the chat
        if (isCurrentUserInChat) {
          const mergedChat = {
            ...existingChat,
            ...newChat,
          };

          // If chat existed before, update it
          if (existingChat) {
            const filtered = prevChats.filter((chat) => chat?.$id !== updated.$id);
            return [mergedChat, ...filtered];
          } else {
            // If chat is new to this user, add it
            return [newChat, ...prevChats];
          }
        }

        // Default fallback: return previous state
        return prevChats;
      });
    }
  };

  const fetchUserChats = async () => {
    try {
      const chatsData = await MessagesService.fetchUserChats({ senderId: user?.$id, limit: 15 });
      if (chatsData.documents.length > 0) {
        setChats(chatsData.documents);
        setLastId(chatsData.documents[chatsData.documents.length - 1].$id);
        setHasMore(chatsData.documents.length < chatsData.total);
      }
      setChatsLoading(false);
    } catch (error) {
      setChatsLoading(false);
      console.log("fetchUserChats: error", error);
    }
  };

  const fetchMoreUserChats = async () => {
    try {
      if (!lastId || !hasMore) return;
      setIsFetchingMore(true);
      const chatsData = await MessagesService.fetchUserChats({ senderId: user?.$id, limit: 10, lastId: lastId });
      const uniqueChats = chatsData.documents.filter((chat) => !chats.some((existing) => existing.$id === chat.$id));
      if (uniqueChats.length === 0) {
        setHasMore(false);
        return;
      }
      const updatedFetchedChats = [...chats, ...uniqueChats];
      setChats(updatedFetchedChats);
      setLastId(chatsData.documents[chatsData.documents.length - 1].$id);
      if (updatedFetchedChats.length >= chatsData.total) setHasMore(false);
    } catch (error) {
      console.log("fetchUserChats: error", error);
    } finally {
      setIsFetchingMore(false);
    }
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchUserChats();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const getLastMessage = (item) => {
    const lastMsg = item?.lastMessageId;
    const sender = lastMsg?.senderId;
    const isSentByUser = sender?.$id === user?.$id;

    if (!lastMsg) return "";

    if (lastMsg.deletedForEveryone) {
      return isSentByUser ? "You deleted a message" : `${sender?.username} deleted a message`;
    }

    if (lastMsg.deletedForSelfBy?.includes(user?.$id)) {
      return "Deleted message";
    }

    const hasAttachmentOnly = lastMsg.attachments?.length > 0 && !lastMsg.message;

    if (hasAttachmentOnly) {
      return isSentByUser ? "You sent a photo" : `${sender?.username} sent a photo`;
    }

    return lastMsg.message || "";
  };

  const renderListEmptyComponent = () => {
    return chatsLoading ? (
      <View className="px-4">
        {[...Array(8)].map((_, index) => (
          <View key={index} className="mb-2 flex-row items-center rounded-2xl bg-white/5 p-3">
            <AnimatedSkeleton className="h-12 w-12 rounded-xl bg-white/20" />
            <View className="ml-4 flex-1">
              <AnimatedSkeleton className="h-5 rounded-lg bg-white/40" style={{ width: getRandomSkeletonWidth() }} />
              <AnimatedSkeleton className="mt-2 h-3 rounded-md bg-white/30" style={{ width: getRandomSkeletonWidth() }} />
            </View>
          </View>
        ))}
      </View>
    ) : (
      <View className="flex-1 items-center justify-center px-4">
        <View className="items-center rounded-2xl bg-white/5 px-8 py-10">
          <View style={{ backgroundColor: "rgba(121,117,212,0.15)", borderRadius: 999, padding: 16, marginBottom: 8 }}>
            <Feather name="message-circle" size={48} color="#7975D4" />
          </View>
          <Text className="mt-4 font-sans text-lg font-bold text-white">No messages yet</Text>
          <Text className="mt-1 text-center text-sm text-white/50">Start a conversation with someone</Text>
          <TouchableOpacity
            onPress={() => router.push("new-chat")}
            style={{ backgroundColor: "#7975D4", paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12, marginTop: 16 }}
          >
            <Text className="font-sans text-base font-bold text-white">Start a Chat</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderItem = ({ item }) => {
    const isGroup = item.userIds.length > 2 || item.type === "group";

    const displayName = isGroup
      ? item.name ||
        item.otherUsers
          ?.filter((otherUser) => otherUser?.$id !== user?.$id)
          .map((otherUser) => otherUser?.username)
          .join(", ")
      : item.otherUsers[0]?.username || "Unknown User";
    const isLastSenderLoggedinUser = item?.lastMessageId?.senderId?.$id === user?.$id;
    const isLastSendMessageSystem = item?.lastMessageId?.type === "system";
    const userLastMessageRead = item?.lastMessageRead?.find((lastMessageItem) => lastMessageItem?.userId?.$id === user?.$id);
    const hasNewMessage = item?.lastMessageId?.$id !== userLastMessageRead?.lastMessageReadId?.$id;
    const lastMessage = getLastMessage(item);

    return (
      <TouchableOpacity
        onPress={() => {
          setCurrentChat(item);
          router.push("messages");
        }}
        className="mx-4 mb-2 flex-row items-center rounded-2xl bg-white/5 p-3"
        style={hasNewMessage ? { borderLeftWidth: 3, borderLeftColor: "#7975D4" } : undefined}
      >
        <MessageAvatars users={[...item?.otherUsers, user]} isGroup={isGroup} />
        <View className="ml-4 flex-1">
          <View className="flex-row justify-between">
            <Text className="text-base text-white" numberOfLines={1} style={{ fontWeight: hasNewMessage ? "bold" : "normal" }}>
              {displayName}
            </Text>
            {hasNewMessage && <Octicons name="dot-fill" color={"#7975D4"} size={20} />}
          </View>
          <View className="flex-row justify-between">
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              className="flex-1 truncate text-sm"
              style={{ color: hasNewMessage ? "#fff" : "#9ca3af", fontWeight: hasNewMessage ? "bold" : "normal" }}
            >
              {isLastSenderLoggedinUser
                ? `You: ${lastMessage ?? ""}`
                : isLastSendMessageSystem
                  ? (lastMessage ?? "")
                  : isGroup
                    ? `${item?.lastMessageId?.senderId?.username ?? ""}: ${lastMessage ?? ""}`
                    : (lastMessage ?? "")}
            </Text>
            <Text className="text-sm" style={{ color: hasNewMessage ? "#7975D4" : "#9ca3af", fontWeight: hasNewMessage ? "bold" : "normal" }}>
              {item?.lastMessageId?.$createdAt ? formatTime(item?.lastMessageId?.$createdAt) : ""}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

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
          <Text className="ml-3 font-sans text-2xl font-bold text-white">Messages</Text>
        </View>
        <TouchableOpacity
          onPress={() => router.push("new-chat")}
          className="h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5"
        >
          <Feather name="edit" size={18} color={"#fff"} />
        </TouchableOpacity>
      </View>
      <FlashList
        data={chats}
        refreshing={refreshing}
        keyExtractor={(item) => item.$id}
        estimatedItemSize={100}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View className="px-4 pb-2">
            <PostSuggestedCreators hideDivider forceUpdate={refreshing} />
          </View>
        }
        renderItem={renderItem}
        ListEmptyComponent={renderListEmptyComponent}
        ListFooterComponent={
          isFetchingMore ? (
            <View className="items-center py-4">
              <ActivityIndicator size="small" color="#7975D4" />
            </View>
          ) : null
        }
        onEndReached={fetchMoreUserChats}
        onRefresh={onRefresh}
        refreshControl={<RefreshControl tintColor="#FFF" titleColor="#FFF" refreshing={refreshing} onRefresh={onRefresh} />}
      />
    </SafeAreaView>
  );
};

export default Chats;
