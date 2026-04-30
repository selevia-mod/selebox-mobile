import { Ionicons } from "@expo/vector-icons";
import { memo } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";

const MessageBubble = ({ item, user, otherUsers, seenIndicatorsMap, showDeleteModal, setImages, setShowImageViewer }) => {
  const { theme } = useAppTheme();
  const isSentByUser = item.senderId?.$id === user?.$id;
  const sender = otherUsers.length > 1 ? otherUsers.find((otherUser) => otherUser.$id === item.senderId?.$id) : otherUsers[0];
  const isGroup = otherUsers?.length > 1;

  const radiusStyles = {
    single: {
      borderTopLeftRadius: 12,
      borderTopRightRadius: 12,
      borderBottomLeftRadius: 12,
      borderBottomRightRadius: 12,
      marginTop: isGroup ? 0 : 10,
    },
    top: {
      borderTopLeftRadius: isSentByUser ? 12 : 0,
      borderTopRightRadius: isSentByUser ? 0 : 12,
      borderBottomLeftRadius: 12,
      borderBottomRightRadius: 12,
    },
    middle: {
      borderTopLeftRadius: isSentByUser ? 12 : 0,
      borderTopRightRadius: isSentByUser ? 0 : 12,
      borderBottomLeftRadius: isSentByUser ? 12 : 0,
      borderBottomRightRadius: isSentByUser ? 0 : 12,
    },
    bottom: {
      borderTopLeftRadius: 12,
      borderTopRightRadius: 12,
      borderBottomLeftRadius: isSentByUser ? 12 : 0,
      borderBottomRightRadius: isSentByUser ? 0 : 12,
      marginTop: isGroup ? 0 : 10,
    },
  };

  const handleImagePress = () => {
    setImages(item.attachments);
    setShowImageViewer(true);
  };

  const handleLongPressMessage = () => {
    showDeleteModal();
  };

  const renderSeenIndicators = () => {
    const seenUsers = Object.entries(seenIndicatorsMap)
      .filter(([messageId]) => messageId === item?.$id) // Only show for the last seen message(s)
      .flatMap(([_, users]) => users);

    if (!seenUsers.length) return null;

    return (
      <View key={`${item?.$id}-seen`} className="mt-1 flex-row space-x-1 self-end">
        {seenUsers.map((seenUser) => (
          <FastImage
            key={seenUser.$id}
            source={{ uri: seenUser?.avatar, priority: FastImage.priority.normal }}
            style={{
              width: 16,
              height: 16,
              borderRadius: 3,
              backgroundColor: theme.surface,
              marginRight: 4,
              borderWidth: 1,
              borderColor: theme.border,
            }}
          />
        ))}
      </View>
    );
  };

  // Layout for received messages (with optional avatar at side)
  if (!isSentByUser) {
    return (
      <View style={{ marginHorizontal: 13 }}>
        <View style={{ marginVertical: 1, flexDirection: "row", alignItems: "flex-end" }}>
          {item.showAvatar ? (
            <>
              <FastImage
                style={{
                  height: 28,
                  width: 28,
                  borderRadius: 5,
                  marginRight: 10,
                  backgroundColor: theme.surfaceStrong,
                }}
                source={{ uri: sender?.avatar }}
              />
              {item.deletedForEveryone ? (
                <View
                  style={{
                    paddingVertical: 8,
                    paddingHorizontal: 13,
                    maxWidth: "75%",
                    borderWidth: 1,
                    borderStyle: "dashed",
                    borderColor: theme.border,
                    ...radiusStyles[item.position],
                    flexDirection: "row",
                    alignItems: "center",
                  }}
                >
                  <Ionicons name="ban-outline" size={13} color={theme.textSubtle} style={{ marginRight: 5 }} />
                  <Text style={{ color: theme.textSubtle, fontSize: 13, fontStyle: "italic" }}>
                    {isSentByUser ? `You deleted a message` : `${item?.senderId?.username} deleted a message`}
                  </Text>
                </View>
              ) : (
                <View style={{ maxWidth: "75%" }}>
                  {item.position === "single" && isGroup && (
                    <Text style={{ color: theme.accentPurple, fontSize: 12, marginBottom: 5, marginTop: 10 }}>{item?.senderId?.username}</Text>
                  )}
                  <TouchableOpacity
                    style={{
                      backgroundColor: theme.surfaceMuted,
                      paddingVertical: 8,
                      paddingHorizontal: 13,
                      ...radiusStyles[item.position],
                      alignSelf: "flex-start", // important to prevent stretching
                    }}
                    onLongPress={handleLongPressMessage}
                  >
                    {item.attachments?.length > 0 && (
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 150 }}>
                        {item.attachments.map((img, idx) => {
                          const uri = typeof img === "string" ? img : img.uri;
                          return (
                            <TouchableOpacity key={idx} onPress={() => handleImagePress(img)} activeOpacity={0.9}>
                              <View className="relative overflow-hidden rounded-xl" style={{ marginRight: item.attachments.length > 1 ? 8 : 0 }}>
                                <FastImage
                                  source={{ uri, priority: FastImage.priority.high }}
                                  style={{
                                    width: 140,
                                    height: 140,
                                    borderRadius: 12,
                                    opacity: typeof img === "string" ? 1 : 0.6,
                                  }}
                                  resizeMode="cover"
                                />
                              </View>
                            </TouchableOpacity>
                          );
                        })}
                      </ScrollView>
                    )}

                    {item.message && <Text style={{ color: theme.text, fontSize: 15 }}>{item.message}</Text>}
                  </TouchableOpacity>
                </View>
              )}
            </>
          ) : item.deletedForEveryone ? (
            <View
              style={{
                paddingVertical: 8,
                paddingHorizontal: 13,
                maxWidth: "75%",
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: theme.border,
                ...radiusStyles[item.position],
                marginLeft: 38,
                flexDirection: "row",
                alignItems: "center",
              }}
            >
              <Ionicons name="ban-outline" size={13} color={theme.textSubtle} style={{ marginRight: 5 }} />
              <Text style={{ color: theme.textSubtle, fontSize: 13, fontStyle: "italic" }}>
                {isSentByUser ? `You deleted a message` : `${item?.senderId?.username} deleted a message`}
              </Text>
            </View>
          ) : (
            // No avatar, align left with margin (like normal)
            <View style={{ marginLeft: 38, maxWidth: "75%" }}>
              {item.position === "bottom" && isGroup && (
                <Text style={{ color: theme.accentPurple, fontSize: 12, marginBottom: 5, marginTop: 10 }}>{item?.senderId?.username}</Text>
              )}
              <TouchableOpacity
                style={{
                  backgroundColor: theme.surfaceMuted,
                  paddingVertical: 8,
                  paddingHorizontal: 13,
                  ...radiusStyles[item.position],
                  alignSelf: "flex-start",
                }}
                onLongPress={handleLongPressMessage}
              >
                {item.attachments?.length > 0 && (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 150 }}>
                    {item.attachments.map((img, idx) => {
                      const uri = typeof img === "string" ? img : img.uri;
                      return (
                        <TouchableOpacity key={idx} onPress={() => handleImagePress(img)} activeOpacity={0.9}>
                          <View className="relative overflow-hidden rounded-xl" style={{ marginRight: item.attachments.length > 1 ? 8 : 0 }}>
                            <FastImage
                              source={{ uri, priority: FastImage.priority.high }}
                              style={{
                                width: 140,
                                height: 140,
                                borderRadius: 12,
                                opacity: typeof img === "string" ? 1 : 0.6,
                              }}
                              resizeMode="cover"
                            />
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                )}

                {item.message && <Text style={{ color: theme.text, fontSize: 15 }}>{item.message}</Text>}
              </TouchableOpacity>
            </View>
          )}
        </View>
        {renderSeenIndicators()}
      </View>
    );
  }

  // Layout for user's own messages
  return (
    <View style={{ marginHorizontal: 13, marginVertical: 1, alignItems: "flex-end" }}>
      {item.deletedForEveryone ? (
        <View
          style={{
            paddingVertical: 8,
            paddingHorizontal: 13,
            maxWidth: "75%",
            borderWidth: 1,
            borderStyle: "dashed",
            borderColor: theme.border,
            ...radiusStyles[item.position],
            flexDirection: "row",
            alignItems: "center",
          }}
        >
          <Ionicons name="ban-outline" size={13} color={theme.textSubtle} style={{ marginRight: 5 }} />
          <Text style={{ color: theme.textSubtle, fontSize: 13, fontStyle: "italic" }}>
            {isSentByUser ? `You deleted a message` : `${item?.senderId?.username} deleted a message`}
          </Text>
        </View>
      ) : (
        <TouchableOpacity
          style={{
            backgroundColor: theme.primary,
            paddingVertical: 8,
            paddingHorizontal: 13,
            ...radiusStyles[item.position],
            maxWidth: "75%",
          }}
          onLongPress={handleLongPressMessage}
        >
          {item.attachments?.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 150 }}>
              {item.attachments.map((img, idx) => {
                const uri = typeof img === "string" ? img : img.uri;
                return (
                  <TouchableOpacity key={idx} onPress={() => handleImagePress(img)} activeOpacity={0.9}>
                    <View className="relative overflow-hidden rounded-xl" style={{ marginRight: item.attachments.length > 1 ? 8 : 0 }}>
                      <FastImage
                        source={{ uri, priority: FastImage.priority.high }}
                        style={{
                          width: 140,
                          height: 140,
                          borderRadius: 12,
                          opacity: typeof img === "string" ? 1 : 0.6,
                        }}
                        resizeMode="cover"
                      />
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          {item.message && <Text style={{ color: theme.primaryContrast, fontSize: 15 }}>{item.message}</Text>}
        </TouchableOpacity>
      )}
      {renderSeenIndicators()}
    </View>
  );
};

function areEqual(prevProps, nextProps) {
  const prevItem = prevProps.item;
  const nextItem = nextProps.item;

  const prevSeen = prevProps.seenIndicatorsMap?.[prevItem.$id]?.map((u) => u.$id).join(",");
  const nextSeen = nextProps.seenIndicatorsMap?.[nextItem.$id]?.map((u) => u.$id).join(",");

  return (
    prevItem.$id === nextItem.$id &&
    prevItem.message === nextItem.message &&
    prevItem.position === nextItem.position &&
    prevItem.showAvatar === nextItem.showAvatar &&
    prevItem.deletedForEveryone === nextItem.deletedForEveryone &&
    prevItem.deletedForSelf === nextItem.deletedForSelf && // Include this if you support per-user deletes
    prevProps.user?.$id === nextProps.user?.$id &&
    prevSeen === nextSeen
  );
}

export default memo(MessageBubble, areEqual);
