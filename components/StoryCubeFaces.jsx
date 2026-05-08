import { Animated, Dimensions, StyleSheet, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const { width: screenWidth, height: screenHeight } = Dimensions.get("window");

// Cube-faces wrapper for the moments viewer.
//
// Was previously a perspective rotation (rotateY) which pivoted the
// current face in place rather than sliding it. With perspective, the
// "next user appears from which side" was ambiguous — the new face
// rotated into view rather than translating, and a couple of users
// reported that the next user looked like it was coming from the
// wrong side. Replaced with a translateX slide:
//
//   cubeAnim = -1  ▶ user is committing to NEXT (swipe left).
//                    Current is fully off to the left, next is at 0
//                    (centered), prev is hidden way off to the left.
//   cubeAnim =  0  ▶ neutral. Current is centered. Next is parked
//                    one screen-width to the right (waiting). Prev is
//                    parked one screen-width to the left (waiting).
//   cubeAnim = +1  ▶ user is committing to PREV (swipe right).
//                    Current is fully off to the right, prev is at 0,
//                    next is hidden way off to the right.
//
// The math:
//   currentTx = cubeAnim * screenWidth
//   nextTx    = (cubeAnim + 1) * screenWidth   // -1 ▶ 0,  0 ▶ +W
//   prevTx    = (cubeAnim - 1) * screenWidth   //  0 ▶ -W, +1 ▶ 0
//
// Net visual: swipe finger left → current slides off the left, next
// slides in from the right. Swipe finger right → current slides off
// the right, prev slides in from the left. Matches Facebook /
// Instagram / TikTok stories.
const StoryCubeFaces = ({ cubeAnim, currentFace, prevFace, nextFace }) => {
  const { theme } = useAppTheme();

  const currentTranslateX = cubeAnim.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: [-screenWidth, 0, screenWidth],
  });

  const nextTranslateX = cubeAnim.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: [0, screenWidth, screenWidth * 2],
  });

  const prevTranslateX = cubeAnim.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: [-screenWidth * 2, -screenWidth, 0],
  });

  return (
    <View style={[styles.cubeRoot, { backgroundColor: theme.mediaBackground }]}>
      {/* Current face — slides with the gesture. */}
      <Animated.View
        style={[
          styles.face,
          styles.absoluteFace,
          {
            backgroundColor: theme.mediaBackground,
            transform: [{ translateX: currentTranslateX }],
          },
        ]}
      >
        {currentFace}
      </Animated.View>

      {/* Previous face — parked off to the LEFT, slides RIGHT into
          view as the user swipes RIGHT. pointerEvents disabled so
          the parked face doesn't intercept gestures from the
          current face. */}
      {prevFace && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.face,
            styles.absoluteFace,
            {
              backgroundColor: theme.mediaBackground,
              transform: [{ translateX: prevTranslateX }],
            },
          ]}
        >
          {prevFace}
        </Animated.View>
      )}

      {/* Next face — parked off to the RIGHT, slides LEFT into view
          as the user swipes LEFT. */}
      {nextFace && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.face,
            styles.absoluteFace,
            {
              backgroundColor: theme.mediaBackground,
              transform: [{ translateX: nextTranslateX }],
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
    overflow: "hidden",
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
