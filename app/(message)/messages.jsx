import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Text, TouchableOpacity, View } from "react-native";
import { ID } from "react-native-appwrite";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { ImageViewer, Loader, MessageAvatars, MessageBubble, MessageInputSection, MessageSettingModal } from "../../components";
import { useGlobalContext } from "../../context/global-provider";
import { client } from "../../lib/appwrite";
import { MessagesService } from "../../lib/messages";
import secrets from "../../private/secrets";
import logger from "../../lib/utils/logger";
import { waitForAppwriteWebSocketReady } from "../../utils/waitUntilRealtimeIsReady";

const Messages = () => {
  const insets = useSafeAreaInsets();
  const { user, currentChat } = useGlobalContext();
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [messageAttachments, setMessageAttachments] = useState([]);
  const [lastId, setLastId] = useState();
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [chat, setChat] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showImageViewer, setShowImageViewer] = useState(false);
  const [images, setImages] = useState([]);
  const chatIdRef = useRef();
  const selectedMessageRef = useRef();

  // Fetch or create chatId between users
  useEffect(() => {
    if (currentChat) {
      if (currentChat?.$id) setChat(currentChat);
      else {
        findChat(currentChat);
      }
    }
  }, [currentChat]);

  const findChat = async (currentChat) => {
    try {
      const chatData = await MessagesService.findChat({
        senderId: user?.$id,
        receiverIds: currentChat?.otherUsers?.map((otherUser) => otherUser?.$id),
        isGroup: currentChat?.otherUsers?.length > 1,
      });
      if (!chatData) setChat(currentChat);
      else {
        setChat({
          ...chatData,
          otherUsers: currentChat.otherUsers,
        });
      }
    } catch (error) {
      console.log("findChat: error", error);
    }
  };

  useEffect(() => {
    if (!chat) return;

    fetchMessages();
    if (chat?.$id) {
      chatIdRef.current = chat.$id;
    }
  }, [chat]);

  useEffect(() => {
    // Race-safe realtime subscription. See comment in chats.jsx for the
    // unmount-during-await race we're guarding against.
    let unsubscribe = null;
    let isCancelled = false;

    const setupRealtimeListeners = async () => {
      try {
        await waitForAppwriteWebSocketReady(secrets.appwriteConfig.projectId, client?.config?.endpoint);
        if (isCancelled) return;
        unsubscribe = client.subscribe(
          [
            `databases.${secrets.appwriteConfig.databaseId}.collections.${secrets.appwriteConfig.messagesCollectionsId}.documents`,
            `databases.${secrets.appwriteConfig.databaseId}.collections.${secrets.appwriteConfig.chatsReadCollectionId}.documents`,
          ],
          (response) => {
            if (response.payload?.$collectionId === secrets.appwriteConfig.messagesCollectionsId) {
              handleRealTimeMessagesEvents(response);
            } else if (response.payload?.$collectionId === secrets.appwriteConfig.chatsReadCollectionId) {
              handleRealTimeMessageReadEvents(response);
            }
          },
        );
        if (isCancelled && unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      } catch (err) {
        logger.error("Messages", "Realtime subscription failed", err);
      }
    };

    setupRealtimeListeners();

    return () => {
      isCancelled = true;
      if (unsubscribe) unsubscribe();
      chatIdRef.current = null;
    };
  }, []);

  const handleRealTimeMessagesEvents = (response) => {
    if (!response?.payload || !response.payload.$id || !response.payload.chatId) return;
    const chatId = chat?.$id ?? chatIdRef.current;

    const isNewDoc = response.events.includes("databases.*.collections.*.documents.*.create");
    const isUpdateDoc = response.events.includes("databases.*.collections.*.documents.*.update");
    const isForChat = response.payload.chatId.$id === chatId;

    if (isNewDoc && isForChat) {
      if (response.payload.attachments.length > 0) {
        setMessages((prev) => prev.map((msg) => (msg.$id === response.payload.$id ? { ...msg, ...response.payload } : msg)));
      } else {
        setMessages((prev) => {
          const alreadyExists = prev.some((msg) => msg.$id === response.payload.$id);
          if (alreadyExists) return prev;
          return [response.payload, ...prev];
        });
      }
    }

    if (isUpdateDoc && isForChat) {
      setMessages((prev) => prev.map((msg) => (msg.$id === response.payload.$id ? { ...msg, ...response.payload } : msg)));
    }

    if (isForChat && response.payload.senderId?.$id !== user?.$id) {
      updateLastMessageReadByUser({ chatId: chat?.$id, lastMessageReadId: response.payload.$id });
    }
  };

  const seenIndicatorsMap = useMemo(() => {
    const map = {};

    if (chat?.lastMessageRead && Array.isArray(chat.lastMessageRead)) {
      for (const entry of chat.lastMessageRead) {
        const seenMsgId = entry?.lastMessageReadId?.$id;
        const userId = entry?.userId?.$id;

        if (userId !== user?.$id && seenMsgId) {
          if (!map[seenMsgId]) map[seenMsgId] = [];
          map[seenMsgId].push(entry.userId);
        }
      }
    }

    return map;
  }, [JSON.stringify(chat?.lastMessageRead), user?.$id]);

  const handleRealTimeMessageReadEvents = (response) => {
    if (!response?.payload || !response.payload.$id || !response.payload.chatId) return;
    const chatId = chat?.$id ?? chatIdRef.current;
    const isForChat = response.payload.chatId.$id === chatId;
    if (!isForChat) return;

    setChat((prev) => {
      if (!prev) return prev;

      const existing = prev?.lastMessageRead?.find((item) => item.$id === response.payload.$id);
      const isSame = existing && existing.lastMessageReadId?.$id === response.payload.lastMessageReadId?.$id;

      if (isSame) return prev;

      const index = existing ? prev.lastMessageRead.findIndex((item) => item.$id === response.payload.$id) : -1;
      const payloadClone = JSON.parse(JSON.stringify(response.payload));

      let updatedLastMessageRead;

      if (!prev?.lastMessageRead) {
        updatedLastMessageRead = [payloadClone];
      } else if (index === -1) {
        updatedLastMessageRead = [...prev.lastMessageRead, payloadClone];
      } else {
        updatedLastMessageRead = [...prev.lastMessageRead];
        updatedLastMessageRead[index] = payloadClone;
      }

      return {
        ...prev,
        lastMessageRead: updatedLastMessageRead,
      };
    });
  };

  const fetchMessages = async () => {
    try {
      if (chat?.$id) {
        const messagesData = await MessagesService.getMessages({ chatId: chat?.$id, limit: 18 });
        if (messagesData.documents.length > 0) {
          setMessages(messagesData.documents);
          setLastId(messagesData.documents[messagesData.documents.length - 1].$id);
          setHasMore(messagesData.documents.length < messagesData.total);
          await updateLastMessageReadByUser({ chatId: chat?.$id, lastMessageReadId: messagesData.documents[0]?.$id });
        }
      }
      setMessagesLoading(false);
    } catch (error) {
      console.log("fetchMessages: error", error);
      setMessagesLoading(false);
    }
  };

  const fetchMoreMessages = async () => {
    try {
      if (!lastId || !hasMore) return;
      setIsFetchingMore(true);
      const messagesData = await MessagesService.getMessages({ chatId: chat?.$id, limit: 10, lastId: lastId });
      const uniqueMessages = messagesData.documents.filter((message) => !messages.some((existing) => existing.$id === message.$id));
      if (uniqueMessages.length === 0) {
        setHasMore(false);
        setIsFetchingMore(false);
        return;
      }
      const updatedFetchedMessages = [...messages, ...uniqueMessages];
      setMessages(updatedFetchedMessages);
      setLastId(messagesData.documents[messagesData.documents.length - 1].$id);
      if (updatedFetchedMessages >= messagesData.total) setHasMore(false);
    } catch (error) {
      console.log("fetchMoreMessages: error", error);
    }
  };

  const sendMessage = async () => {
    if (!message.trim() && messageAttachments.length === 0) return;

    try {
      const tempId = ID.unique();
      if (messageAttachments.length > 0) {
        const tempMessage = {
          $id: tempId,
          chatId: chat?.$id,
          senderId: user,
          message: message.trim(),
          attachments: messageAttachments.map((a) => ({ uri: a.uri })),
        };

        setMessages((prev) => [tempMessage, ...prev]);
      }
      setMessage("");
      setMessageAttachments([]);

      const uploadedUrls = await Promise.all(messageAttachments.map((img) => MessagesService.uploadAttachmentToStorage(img)));

      if (chat?.$id) {
        const messageData = await MessagesService.sendMessage({
          messageId: tempId,
          chatId: chat?.$id,
          senderId: user?.$id,
          message: message.trim(),
          attachments: uploadedUrls,
        });
        await MessagesService.updateChat({ chatId: chat?.$id, lastMessageId: messageData?.$id });
        await updateLastMessageReadByUser({ chatId: chat?.$id, lastMessageReadId: messageData?.$id });
        MessagesService.submitPushNotifications({ chat: chat, message: !message.trim() ? `${user?.username} sent a photo` : message, user: user });
      } else {
        const chatData = await MessagesService.createChat({
          senderId: user?.$id,
          receiverIds: chat?.otherUsers?.map((otherUser) => otherUser?.$id),
          isGroup: chat?.otherUsers?.length > 1,
          groupName: chat?.name,
        });
        chatIdRef.current = chatData?.$id;
        setChat({
          ...chatData,
          otherUsers: chat?.otherUsers,
        });
        const messageData = await MessagesService.sendMessage({
          messageId: tempId,
          chatId: chat?.$id,
          senderId: user?.$id,
          message: message.trim(),
          attachments: uploadedUrls,
        });
        if (messageData) {
          setMessages([messageData]);
          await MessagesService.updateChat({ chatId: chatData?.$id, lastMessageId: messageData?.$id });
          await updateLastMessageReadByUser({ chatId: chat?.$id, lastMessageReadId: messageData?.$id });
          MessagesService.submitPushNotifications({ chat: chat, message: !message.trim() ? `${user?.username} sent a photo` : message, user: user });
        }
      }
    } catch (error) {
      console.log("sendMessage: error", error);
    }
  };

  const updateLastMessageReadByUser = async ({ chatId, lastMessageReadId }) => {
    const userId = user?.$id;
    const chatReadData = await MessagesService.findUserChatRead({ chatId, userId });
    if (chatReadData.documents.length > 0) {
      // update chat read
      MessagesService.updateUserChatRead({ chatReadId: chatReadData.documents[0].$id, lastMessageReadId });
    } else {
      // create chat read
      MessagesService.createUserChatRead({ chatId, userId, lastMessageReadId });
    }
  };

  const handleDeleteMessage = async (isForEveryone) => {
    try {
      const currentMessage = selectedMessageRef.current;
      if (!currentMessage?.$id) return;

      if (isForEveryone) {
        await MessagesService.updateMessage({
          messageId: currentMessage.$id,
          deletedForEveryone: true,
        });
      } else {
        const deletedForSelfBy = Array.isArray(currentMessage.deletedForSelfBy) ? currentMessage.deletedForSelfBy : [];

        // Avoid duplicate $id in array
        const updatedDeletedForSelfBy = deletedForSelfBy.includes(user?.$id) ? deletedForSelfBy : [...deletedForSelfBy, user?.$id];

        await MessagesService.updateMessage({
          messageId: currentMessage.$id,
          deletedForSelfBy: updatedDeletedForSelfBy,
        });
      }

      setShowDeleteModal(false);
    } catch (error) {
      console.log("handleDeleteMessage: error", error);
    }
  };

  const getUserActiveStatus = (otherUser) => {
    const lastActive = new Date(otherUser?.lastActive);
    const now = new Date();
    const diff = now.getTime() - lastActive.getTime();

    const ONE_MINUTE = 60 * 1000;
    const ONE_HOUR = 60 * ONE_MINUTE;
    const ONE_DAY = 24 * ONE_HOUR;

    if (diff < ONE_MINUTE) {
      return "Active Now";
    } else if (diff < ONE_HOUR) {
      const minutes = Math.floor(diff / ONE_MINUTE);
      return `Active ${minutes}m ago`;
    } else if (diff < ONE_DAY) {
      const hours = Math.floor(diff / ONE_HOUR);
      return `Active ${hours}h ago`;
    } else {
      return "Inactive";
    }
  };

  const getUsers = () => (chat ? [...chat?.otherUsers, user] : []);

  const getMessages = () => {
    const messagesInsertedSeparators = MessagesService.insertDateSeparators(
      messages.filter((messageItem) => !messageItem?.deletedForSelfBy?.includes(user?.$id)),
    );
    return MessagesService.groupMessages(messagesInsertedSeparators);
  };

  const renderMessage = ({ item, index }) => {
    if (item.type === "date-separator") {
      return (
        <View className="my-3 items-center">
          <View style={{ backgroundColor: "rgba(255,255,255,0.08)", paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999 }}>
            <Text className="text-xs text-white/50">{item.formatted}</Text>
          </View>
        </View>
      );
    }
    if (item.type === "system") {
      return (
        <View className="my-3 items-center">
          <View
            style={{
              backgroundColor: "rgba(255,255,255,0.08)",
              paddingHorizontal: 12,
              paddingVertical: 4,
              borderRadius: 999,
              flexDirection: "row",
              alignItems: "center",
            }}
          >
            <Ionicons name="information-circle" size={14} color="rgba(255,255,255,0.4)" style={{ marginRight: 4 }} />
            <Text className="text-xs text-white/50">{item.message}</Text>
          </View>
        </View>
      );
    }

    return (
      <MessageBubble
        item={item}
        user={user}
        otherUsers={chat?.otherUsers}
        seenIndicatorsMap={seenIndicatorsMap}
        showDeleteModal={() => {
          selectedMessageRef.current = item;
          setShowDeleteModal(true);
        }}
        setImages={setImages}
        setShowImageViewer={setShowImageViewer}
      />
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-gray-900">
      <Loader isLoading={messagesLoading} isFullHeightWidth={true} />
      {/* Header */}
      <View className="flex-row items-center justify-between border-b border-white/5 px-4 pb-3 pt-2">
        <View className="flex-row items-center">
          <TouchableOpacity
            onPress={() => router.back()}
            className="h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5"
          >
            <MaterialIcons name="arrow-back" size={20} color="white" />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push("message-settings")} className="flex-1 flex-row items-center">
            <MessageAvatars users={getUsers()} isGroup={chat?.type === "group"} style={{ marginLeft: 10 }} size={40} />
            <View className="ml-2 flex flex-1 justify-center">
              <Text numberOfLines={1} ellipsizeMode="tail" className="text-base font-bold text-white">
                {chat?.type === "group"
                  ? chat.name ||
                    chat.otherUsers
                      ?.filter((otherUser) => otherUser?.$id !== user?.$id)
                      .map((otherUser) => otherUser?.username)
                      .join(", ")
                  : (chat?.otherUsers[0]?.username ?? "Deleted user")}
              </Text>
              {chat?.type === "direct" && (
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  {getUserActiveStatus(chat?.otherUsers[0]) === "Active Now" && (
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#22c55e", marginRight: 4 }} />
                  )}
                  <Text
                    className="text-xs"
                    style={{ color: getUserActiveStatus(chat?.otherUsers[0]) === "Active Now" ? "#22c55e" : "rgba(255,255,255,0.5)" }}
                  >
                    {getUserActiveStatus(chat?.otherUsers[0])}
                  </Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        </View>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <FlashList
          data={getMessages()}
          extraData={chat}
          keyExtractor={(item) => (item.type === "date-separator" ? item.$id : `${item.$id}-${item.position}`)}
          estimatedItemSize={60}
          renderItem={renderMessage}
          contentContainerStyle={{ paddingBottom: insets.top + 25, paddingTop: 5 }}
          inverted
          showsVerticalScrollIndicator={false}
          onEndReached={fetchMoreMessages}
          ListFooterComponent={
            isFetchingMore ? (
              <View className="items-center py-4">
                <ActivityIndicator size="small" color="#7975D4" />
              </View>
            ) : (
              chat?.$id && (
                <View className="items-center py-4">
                  <Ionicons name="chatbubble-ellipses-outline" size={16} color="rgba(255,255,255,0.3)" style={{ marginBottom: 4 }} />
                  <Text style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", fontFamily: "sans-serif" }}>End of messages</Text>
                </View>
              )
            )
          }
        />
        <MessageInputSection
          message={message}
          setMessage={setMessage}
          messageAttachments={messageAttachments}
          setMessageAttachments={setMessageAttachments}
          sendMessage={sendMessage}
        />
      </KeyboardAvoidingView>
      <MessageSettingModal
        message={selectedMessageRef?.current}
        isVisible={showDeleteModal}
        onClose={() => {
          setShowDeleteModal(false);
          selectedMessageRef.current = null;
        }}
        deleteMessage={handleDeleteMessage}
      />
      <ImageViewer images={images} visible={showImageViewer} onClose={() => setShowImageViewer(false)} />
    </SafeAreaView>
  );
};

export default Messages;
