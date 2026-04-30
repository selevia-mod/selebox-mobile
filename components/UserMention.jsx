import { MaterialIcons } from "@expo/vector-icons";
import { memo, useMemo } from "react";
import { FlatList, Text, TouchableOpacity, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";
import { buildComposerMentionParts, buildMentionTextParts, stripMentionMarkup } from "../lib/user-mentions";

const joinClasses = (...classes) => classes.filter(Boolean).join(" ");

const MentionTextVariant = memo(
  ({
    value,
    className,
    defaultClassName = "",
    mentionClassName = "",
    selectedMentionUsers,
    onMentionPress,
    onUrlPress,
    linkStyle,
    textStyle,
    mentionStyle,
  }) => {
    const { theme } = useAppTheme();
    const text = String(value || "");
    const resolvedClassName = className || defaultClassName;
    const resolvedTextStyle = [{ color: theme.textMuted }, textStyle];
    const resolvedMentionStyle = [{ color: theme.accentBlue }, mentionStyle];
    const resolvedLinkStyle = linkStyle || {
      color: theme.accentBlue,
      textDecorationLine: "underline",
    };
    const parts = useMemo(
      () => (Array.isArray(selectedMentionUsers) ? buildComposerMentionParts(text, selectedMentionUsers) : buildMentionTextParts(text)),
      [selectedMentionUsers, text],
    );

    if (!text) return <Text className={resolvedClassName} style={resolvedTextStyle} />;
    return (
      <Text className={resolvedClassName} style={resolvedTextStyle}>
        {parts.length === 0
          ? stripMentionMarkup(text)
          : parts.map((part, index) =>
              part.type === "mention" ? (
                <Text
                  key={`mention-${index}`}
                  className={mentionClassName}
                  style={resolvedMentionStyle}
                  onPress={() => onMentionPress?.(part.username, part.userId)}
                >
                  {part.value}
                </Text>
              ) : part.type === "link" ? (
                <Text key={`link-${index}`} style={linkStyle} onPress={() => onUrlPress?.(part.value)}>
                  {part.value}
                </Text>
              ) : (
                <Text key={`text-${index}`}>{part.value}</Text>
              ),
            )}
      </Text>
    );
  },
);

const MentionSuggestionsVariant = memo(
  ({
    suggestions = [],
    selectedUserIds = [],
    ready = false,
    onSelect,
    onSelectStart,
    activeOpacity = 0.75,
    containerClassName,
    containerStyle,
    itemClassName = "flex-row items-center space-x-2 border-b px-4 py-2",
    selectedItemClassName = "",
    avatarClassName = "h-8 w-8 rounded-full",
    selectedAvatarClassName = "",
    keyboardShouldPersistTaps = "always",
    nestedScrollEnabled = false,
    listStyle,
    contentContainerStyle,
  }) => {
    const { theme } = useAppTheme();
    const selectedIdSet = useMemo(
      () => new Set((selectedUserIds || []).map((selectedUserId) => String(selectedUserId || "")).filter(Boolean)),
      [selectedUserIds],
    );

    return (
      <View className={containerClassName} style={containerStyle}>
        <FlatList
          data={suggestions}
          keyExtractor={(item) => String(item?.$id || "")}
          keyboardShouldPersistTaps={keyboardShouldPersistTaps}
          nestedScrollEnabled={nestedScrollEnabled}
          style={listStyle}
          contentContainerStyle={contentContainerStyle}
          renderItem={({ item }) => {
            const itemId = String(item?.$id || "");
            const isSelectedMention = selectedIdSet.has(itemId);

            return (
              <TouchableOpacity
                onPressIn={() => onSelectStart?.(item)}
                onPress={() => onSelect?.(item)}
                activeOpacity={activeOpacity}
                className={joinClasses(itemClassName, isSelectedMention && selectedItemClassName)}
                style={{
                  borderBottomColor: theme.divider,
                  backgroundColor: isSelectedMention ? theme.primarySoft : "transparent",
                }}
              >
                <FastImage
                  source={{ uri: item?.avatar || "", priority: FastImage.priority.normal }}
                  className={joinClasses(avatarClassName, isSelectedMention && selectedAvatarClassName)}
                  style={{ backgroundColor: theme.surfaceStrong }}
                />
                <View className="flex-1">
                  <Text className="font-sans text-sm" style={{ color: isSelectedMention ? theme.primary : theme.text }}>
                    {item?.username}
                  </Text>
                  <Text className="font-sans text-[11px]" style={{ color: isSelectedMention ? theme.primary : theme.textSoft }}>
                    {item?.name || ""}
                  </Text>
                </View>
                {isSelectedMention ? <MaterialIcons name="check-circle" size={16} color={theme.accentBlue} /> : null}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            !ready ? (
              <View className="px-4 py-3">
                <Text className="text-xs" style={{ color: theme.textSoft }}>
                  Searching users...
                </Text>
              </View>
            ) : (
              <View className="px-4 py-3">
                <Text className="text-xs" style={{ color: theme.textSoft }}>
                  No users found.
                </Text>
              </View>
            )
          }
        />
      </View>
    );
  },
);

const UserMention = (props) => {
  if (props?.variant === "suggestions") {
    return <MentionSuggestionsVariant {...props} />;
  }

  return <MentionTextVariant {...props} />;
};

export default memo(UserMention);
