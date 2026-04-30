import { Text, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";

const MAX_DISPLAY = 4;

const MessageAvatars = ({ users = [], isGroup = false, style, size = 48 }) => {
  const { theme } = useAppTheme();
  const visibleUsers = users.slice(0, MAX_DISPLAY);
  const extraCount = users.length - 3;

  const avatarSize = size / 2;
  const radius = size * 0.1;

  return isGroup ? (
    <View
      className="relative"
      style={[
        {
          width: size,
          height: size,
        },
        style,
      ]}
    >
      {visibleUsers.map((user, index) => {
        const isLast = index === 3 && users.length > 4;

        const positions = [
          { top: "50%", left: "25%" },
          { top: 0, left: 0 },
          { top: 0, right: 0 },
          { bottom: 0, left: "25%" },
        ];

        // For 4 users, use full 2x2 grid
        const positions4 = [
          { top: 0, left: 0 },
          { top: 0, right: 0 },
          { bottom: 0, left: 0 },
          { bottom: 0, right: 0 },
        ];

        const avatarStyle = {
          position: "absolute",
          width: avatarSize,
          height: avatarSize,
          borderRadius: radius,
          backgroundColor: isLast ? theme.surfaceStrong : theme.surfaceMuted,
          alignItems: "center",
          justifyContent: "center",
          ...(users.length <= 3 ? positions[index] : positions4[index]),
        };

        if (isLast) {
          return (
            <View key={`more-${index}`} style={avatarStyle}>
              <Text style={{ color: theme.text, fontWeight: "600", fontSize: 12 }}>+{extraCount}</Text>
            </View>
          );
        }

        return <FastImage key={user.$id} source={{ uri: user.avatar, priority: FastImage.priority.normal }} style={avatarStyle} />;
      })}
    </View>
  ) : (
    <FastImage
      source={{ uri: users[0]?.avatar, priority: FastImage.priority.normal }}
      style={[
        {
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: theme.surfaceMuted,
        },
        style,
      ]}
    />
  );
};

export default MessageAvatars;
