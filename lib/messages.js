import { ID, Query } from "react-native-appwrite";
import secrets from "../private/secrets";
import { client, databases, storage } from "./appwrite";
import { getUserByID } from "./users";

export class MessagesService {
  static async findChat({ senderId, receiverIds, isGroup = false }) {
    const userIds = isGroup ? [...new Set([senderId, ...receiverIds])] : [senderId, receiverIds[0]];
    const sortedUserIds = [...userIds].sort(); // consistent order

    const filters = [
      Query.equal("type", isGroup ? "group" : "direct"),
      Query.contains("userIds", userIds), // contains will match any containing those ids
    ];

    const response = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.chatsCollectionId, filters);

    // 🔍 For direct chat: find exact 2-user match
    if (!isGroup) {
      const exactChat = response.documents.find(
        (doc) => Array.isArray(doc.userIds) && doc.userIds.length === 2 && doc.userIds.includes(senderId) && doc.userIds.includes(receiverIds[0]),
      );

      if (exactChat) return exactChat;
    }

    // 🔍 For group chat: find exact match with same members
    if (isGroup) {
      const exactGroup = response.documents.find(
        (doc) =>
          Array.isArray(doc.userIds) &&
          doc.userIds.length === sortedUserIds.length &&
          [...doc.userIds].sort().every((id, idx) => id === sortedUserIds[idx]),
      );

      if (exactGroup) return exactGroup;
    }
  }

  static async createChat({ senderId, receiverIds, isGroup = false, groupName = "", groupAvatar = "" }) {
    const userIds = isGroup ? [...new Set([senderId, ...receiverIds])] : [senderId, receiverIds[0]];
    const sortedUserIds = [...userIds].sort();
    const newChat = await databases.createDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.chatsCollectionId, ID.unique(), {
      userIds: sortedUserIds,
      type: isGroup ? "group" : "direct",
      createdBy: senderId,
      ...(isGroup && { name: groupName, avatar: groupAvatar }),
    });

    return newChat;
  }

  static async updateChat({ chatId, ...props }) {
    const response = await databases.updateDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.chatsCollectionId, chatId, {
      ...props,
    });

    return response;
  }

  static async getMessages({ chatId, limit = 10, lastId }) {
    const queries = [Query.equal("chatId", chatId), Query.limit(limit), Query.orderDesc("$createdAt")];
    if (lastId) queries.push(Query.cursorAfter(lastId));
    const res = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.messagesCollectionsId, queries);
    return res;
  }

  static async sendMessage({ messageId, chatId, senderId, message, type = "normal", attachments = [] }) {
    const res = await databases.createDocument(
      secrets.appwriteConfig.databaseId,
      secrets.appwriteConfig.messagesCollectionsId,
      messageId ?? ID.unique(),
      {
        chatId,
        type,
        senderId,
        message,
        attachments,
      },
    );

    return res;
  }

  static async updateMessage({ messageId, ...props }) {
    const response = await databases.updateDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.messagesCollectionsId, messageId, {
      ...props,
    });

    return response;
  }

  static async listenToMessages({ chatId, onMessage }) {
    return client.subscribe(
      `databases.${secrets.appwriteConfig.databaseId}.collections.${secrets.appwriteConfig.messagesCollectionsId}.documents`,
      (response) => {
        console.log("🔔 Realtime event received:", response);

        const isNewDoc = response.events.includes("databases.*.collections.*.documents.*.create");
        const isForChat = response.payload?.chatId === chatId;

        if (isNewDoc && isForChat) {
          onMessage(response.payload);
        }
      },
    );
  }

  static groupMessages(items) {
    const result = [];
    let group = [];

    const flushGroup = () => {
      for (let i = 0; i < group.length; i++) {
        const current = group[i];
        const prev = group[i + 1];
        const next = group[i - 1];
        const currentSender = current.senderId?.$id;

        const isSameAsPrev = prev?.senderId?.$id === currentSender;
        const isSameAsNext = next?.senderId?.$id === currentSender;

        let position = "single";
        if (isSameAsPrev && isSameAsNext) position = "middle";
        else if (isSameAsPrev && !isSameAsNext) position = "top";
        else if (!isSameAsPrev && isSameAsNext) position = "bottom";

        result.push({
          ...current,
          position,
          showAvatar: !isSameAsNext, // show avatar at the end of group
        });
      }

      group = [];
    };

    for (const item of items) {
      if (item.type === "date-separator") {
        flushGroup();
        result.push(item);
      } else {
        group.push(item);
      }
    }

    flushGroup(); // flush any remaining group
    return result;
  }

  static insertDateSeparators(messages, gapMinutes = 30) {
    const result = [];
    const now = new Date();

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const createdAt = new Date(message.$createdAt);

      const nextMessage = messages[i + 1]; // Next message in array = previous message in time (because FlashList is inverted)
      const nextCreatedAt = nextMessage ? new Date(nextMessage.$createdAt) : null;

      const isLastMessage = i === messages.length - 1;
      let shouldInsertSeparator = false;

      // Insert separator if:
      // 1. It's the last message (oldest in time)
      // 2. Time gap between this and next message exceeds threshold
      if (isLastMessage) {
        shouldInsertSeparator = true;
      } else {
        const diffMs = Math.abs(createdAt.getTime() - nextCreatedAt.getTime());
        const diffMinutes = diffMs / (1000 * 60);
        if (diffMinutes > gapMinutes) {
          shouldInsertSeparator = true;
        }
      }

      // Push message first — since FlashList is inverted, this ensures
      // the separator appears visually *above* the message
      result.push(message);

      if (shouldInsertSeparator) {
        result.push({
          type: "date-separator",
          formatted: this.formatTimestamp(createdAt, now),
          $id: `separator-${message.$id}`, // Unique ID to help FlashList rendering
        });
      }
    }

    return result;
  }

  static formatTimestamp(createdAt, now) {
    const hours = createdAt.getHours();
    const minutes = createdAt.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    const hour12 = hours % 12 || 12;
    const time = `${hour12}:${minutes} ${ampm}`;

    const isToday = createdAt.toDateString() === now.toDateString();
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(now.getDate() - 7);
    const isThisWeek = createdAt > oneWeekAgo && !isToday;
    const isThisYear = createdAt.getFullYear() === now.getFullYear();

    if (isToday) {
      return time;
    } else if (isThisWeek) {
      const weekday = createdAt.toLocaleDateString("en-US", { weekday: "short" });
      return `${weekday} ${time}`;
    } else if (isThisYear) {
      const month = createdAt.toLocaleDateString("en-US", { month: "long" });
      const day = createdAt.getDate();
      return `${month} ${day} at ${time}`;
    } else {
      const month = createdAt.toLocaleDateString("en-US", { month: "long" });
      const day = createdAt.getDate();
      const year = createdAt.getFullYear();
      return `${month} ${day}, ${year} at ${time}`;
    }
  }

  static async fetchUserChats({ senderId, limit = 10, lastId }) {
    const queries = [Query.contains("userIds", [senderId]), Query.orderDesc("$updatedAt"), Query.limit(limit)];
    if (lastId) queries.push(Query.cursorAfter(lastId));
    const response = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.chatsCollectionId, queries);

    const enrichChatsWithUsers = async (chats, currentUserId) => {
      const enriched = await Promise.all(
        chats.map(async (chat) => {
          const otherUserIds = chat.userIds.filter((id) => id !== currentUserId);
          const otherUsers = await Promise.all(otherUserIds.map((id) => getUserByID({ ID: id })));
          const lastMessageReads = await this.findChatRead({ chatId: chat?.$id });

          return {
            ...chat,
            lastMessageRead: lastMessageReads.documents,
            otherUsers: otherUsers,
          };
        }),
      );

      return { documents: enriched, total: response.total };
    };

    return enrichChatsWithUsers(response.documents, senderId);
  }

  static async getUserChat({ chatId, senderId }) {
    const response = await databases.getDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.chatsCollectionId, chatId);

    const enrichChatWithUsers = async (chat, currentUserId) => {
      const otherUserIds = chat.userIds.filter((id) => id !== currentUserId);
      const otherUsers = await Promise.all(otherUserIds.map((id) => getUserByID({ ID: id })));
      const lastMessageReads = await this.findChatRead({ chatId: chat?.$id });
      return {
        ...chat,
        lastMessageRead: lastMessageReads.documents,
        otherUsers: otherUsers,
      };
    };

    return enrichChatWithUsers(response, senderId);
  }

  static async findChatRead({ chatId }) {
    const response = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.chatsReadCollectionId, [
      Query.equal("chatId", chatId),
    ]);

    return response;
  }

  static async findUserChatRead({ chatId, userId }) {
    const response = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.chatsReadCollectionId, [
      Query.and([Query.equal("chatId", chatId), Query.equal("userId", userId)]),
    ]);

    return response;
  }

  static async createUserChatRead({ chatId, userId, lastMessageReadId }) {
    const response = await databases.createDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.chatsReadCollectionId, ID.unique(), {
      chatId,
      userId,
      lastMessageReadId,
    });

    return response;
  }

  static async updateUserChatRead({ chatReadId, ...props }) {
    const response = await databases.updateDocument(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.chatsReadCollectionId, chatReadId, {
      ...props,
    });

    return response;
  }

  static async submitPushNotifications({ chat, message, user }) {
    const isGroup = chat.userIds.length > 2 || chat.type === "group";
    const displayName = isGroup ? `${user?.username} to ${chat?.name ?? "your group"}` : user?.username;
    const otherUsers = chat?.otherUsers ?? [];
    const recipients = otherUsers.filter((u) => u?.$id !== user?.$id);

    for (const recipient of recipients) {
      try {
        const expoPushToken = recipient?.expoPushToken;

        if (expoPushToken) {
          await fetch("https://exp.host/--/api/v2/push/send", {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Accept-Encoding": "gzip, deflate",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              to: expoPushToken,
              sound: "default",
              title: displayName,
              body: `${message.trim()}`,
              data: {
                chatId: chat?.$id,
                isGroup: isGroup,
              },
              android: {
                channelId: "messages",
                group: chat?.$id,
                groupSummary: false,
                priority: "max",
              },
              ios: {
                _displayInForeground: true,
                threadId: chat?.$id,
                threadIdentifier: chat?.$id,
              },
              threadIdentifier: chat?.$id,
            }),
          });
        }
      } catch (err) {
        console.log(`Failed to send push to ${recipient?.$id}`, err);
      }
    }
  }

  static async uploadAttachmentToStorage(file) {
    const { convertToWebP, cleanupTempFile } = require("./image-utils");
    const webp = await convertToWebP(file.uri, { maxWidth: 1000 });
    try {
      const asset = {
        name: (file.fileName || file.uri.split("/").pop()).replace(/\.\w+$/, ".webp"),
        size: webp.fileSize,
        type: "image/webp",
        uri: webp.uri,
      };
      const uploadedFile = await storage.createFile(secrets.appwriteConfig.messagesStorageId, ID.unique(), asset);
      const fileUrl = storage.getFilePreview(secrets.appwriteConfig.messagesStorageId, uploadedFile.$id);
      return fileUrl;
    } catch (error) {
      throw error;
    } finally {
      cleanupTempFile(webp.uri, file.uri);
    }
  }

  static async countChatsWithUnreadMessages({ userId }) {
    try {
      const response = await databases.listDocuments(secrets.appwriteConfig.databaseId, secrets.appwriteConfig.chatsCollectionId, [
        Query.contains("userIds", [userId]),
      ]);

      const chats = response.documents;
      const count = await Promise.all(
        chats.map(async (chat) => {
          const lastMessageReads = await this.findChatRead({ chatId: chat.$id });
          const userLastRead = lastMessageReads.documents.find((item) => item?.userId?.$id === userId);
          const hasUnread = chat.lastMessageId?.$id !== userLastRead?.lastMessageReadId?.$id;
          return hasUnread ? 1 : 0;
        }),
      );

      const totalUnreadChats = count.reduce((acc, val) => acc + val, 0);
      return totalUnreadChats;
    } catch (error) {
      throw error;
    }
  }
}
