import { Animated, Dimensions, StyleSheet, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const { width: screenWidth, height: screenHeight } = Dimensions.get("window");

const StoryCubeFaces = ({ cubeAnim, currentFace, prevFace, nextFace }) => {
  const { theme } = useAppTheme();
  const currentRotateY = cubeAnim.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: ["-90deg", "0deg", "90deg"],
  });

  const prevRotateY = cubeAnim.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: ["-90deg", "-90deg", "0deg"],
  });

  const nextRotateY = cubeAnim.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: ["0deg", "90deg", "90deg"],
  });

  const prevOpacity = cubeAnim.interpolate({
    inputRange: [0, 0.01, 1],
    outputRange: [0, 0, 1],
  });

  const nextOpacity = cubeAnim.interpolate({
    inputRange: [-1, -0.01, 0],
    outputRange: [1, 0, 0],
  });

  const scale = cubeAnim.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: [0.93, 1, 0.93],
  });

  return (
    <View style={[styles.cubeRoot, { backgroundColor: theme.mediaBackground }]}>
      {/* Current face */}
      <Animated.View
        style={[
          styles.face,
          {
            backgroundColor: theme.mediaBackground,
            transform: [{ perspective: 1000 }, { rotateY: currentRotateY }, { scale }],
          },
        ]}
      >
        {currentFace}
      </Animated.View>

      {/* Previous face */}
      {prevFace && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.face,
            styles.absoluteFace,
            {
              backgroundColor: theme.mediaBackground,
              opacity: prevOpacity,
              transform: [{ perspective: 1000 }, { rotateY: prevRotateY }, { scale }],
            },
          ]}
        >
          {prevFace}
        </Animated.View>
      )}

      {/* Next face */}
      {nextFace && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.face,
            styles.absoluteFace,
            {
              backgroundColor: theme.mediaBackground,
              opacity: nextOpacity,
              transform: [{ perspective: 1000 }, { rotateY: nextRotateY }, { scale }],
            },
          ]}
        >
          {nextFace}
        </Animated.View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  cubeRoot: {
    flex: 1,
    width: screenWidth,
    height: screenHeight,
  },
  face: {
    width: screenWidth,
    height: screenHeight,
  },
  absoluteFace: {
    position: "absolute",
    top: 0,
    left: 0,
  },
});

export default StoryCubeFaces;
