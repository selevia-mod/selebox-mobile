import React from "react";
import { StyleSheet, Text, View } from "react-native";
import FastImage from "react-native-fast-image";
import useAppTheme from "../hooks/useAppTheme";

export function StackedAvatars({ avatars = [], size = 40, isOnline = false }) {
  const { theme } = useAppTheme();
  const count = avatars.length;

  // helper styles for avatar image
  const imgStyle = (w, h, br) => ({
    width: w,
    height: h,
    borderRadius: br,
    backgroundColor: theme.surfaceStrong,
  });

  // placeholder
  if (!count) {
    return <View style={[styles.placeholder, { width: size, height: size, borderRadius: size / 2 }]} />;
  }

  // 1 avatar: full circle
  if (count === 1) {
    return (
      <View className="ml-2" style={{ width: size, height: size }}>
        <FastImage source={{ uri: avatars[0] }} style={imgStyle(size, size, size / 2)} />
        {isOnline && <View style={[styles.online, { right: 0, top: 0, backgroundColor: theme.accentGreen }]} />}
      </View>
    );
  }

  // 2 avatars: stacked vertically (centered)
  if (count === 2) {
    const small = Math.round(size * 0.58); // avatar size for each small circle

    return (
      <View
        className="ml-2"
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: "hidden",
          justifyContent: "space-between",
          alignItems: "center",
          paddingVertical: Math.round((size - small * 2) / 3) || 2,
        }}
      >
        <FastImage source={{ uri: avatars[0] }} style={imgStyle("100%", small)} />
        <FastImage source={{ uri: avatars[1] }} style={imgStyle("100%", small)} />
        {isOnline && <View style={[styles.online, { right: 0, top: 0, backgroundColor: theme.accentGreen }]} />}
      </View>
    );
  }

  // 3 avatars: two on top row, one centered bottom
  if (count === 3) {
    const half = Math.round(size / 2);
    return (
      <View className="ml-2" style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden" }}>
        {/* Top row */}
        <View style={{ flexDirection: "row" }}>
          <FastImage source={{ uri: avatars[0] }} style={imgStyle(half, half)} />
          <FastImage source={{ uri: avatars[1] }} style={imgStyle(half, half)} />
        </View>
        {/* Bottom row - center the single avatar */}
        <View style={{ width: size, height: half, justifyContent: "center", alignItems: "center" }}>
          <FastImage source={{ uri: avatars[2] }} style={imgStyle("100%", half)} />
        </View>
        {isOnline && <View style={[styles.online, { right: 0, top: 0, backgroundColor: theme.accentGreen }]} />}
      </View>
    );
  }

  // 4 or more: use 2x2 grid; if more than 4, show +N at last cell (N = count - 3)
  // But per your request: for >4 display first 3 avatars and +remaining in last slot
  const firstThree = avatars.slice(0, 3);
  const remaining = Math.max(0, count - 4);
  const cell = Math.round(size / 2);

  return (
    <View className="ml-2" style={{ width: size, height: size, borderRadius: size / 2, overflow: "hidden" }}>
      <View style={{ flexDirection: "row" }}>
        <FastImage source={{ uri: firstThree[0] }} style={imgStyle(cell, cell)} />
        <FastImage source={{ uri: firstThree[1] }} style={imgStyle(cell, cell)} />
      </View>

      <View style={{ flexDirection: "row" }}>
        <FastImage source={{ uri: firstThree[2] }} style={imgStyle(cell, cell)} />
        {remaining > 0 ? (
          <View style={[styles.moreCell, { width: cell, height: cell, backgroundColor: theme.surfaceStrong }]}>
            <Text style={[styles.moreText, { color: theme.primaryContrast }]}>+{remaining}</Text>
          </View>
        ) : (
          // if exactly 4 avatars (remaining === 0), show the 4th avatar
          <FastImage source={{ uri: avatars[3] }} style={imgStyle(cell, cell)} />
        )}
      </View>

      {isOnline && <View style={[styles.online, { right: 0, top: 0, backgroundColor: theme.accentGreen }]} />}
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    backgroundColor: "transparent",
    justifyContent: "center",
    alignItems: "center",
  },
  online: {
    position: "absolute",
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "transparent",
  },
  moreCell: {
    justifyContent: "center",
    alignItems: "center",
  },
  moreText: {
    fontSize: 12,
    fontWeight: "600",
  },
});
