// Vertical stack of placeholders that visually rhyme with the real Videos
// tab sections (Most People Want, Suggested For You, Continue Watching, …).
// Each skeleton "section" mirrors the same shape as a Videos* component:
//   - a violet-soft section header chip with a small icon + uppercase label
//   - a horizontal row of 3 video card skeletons (thumbnail rectangle +
//     title bars + meta row)
//
// Mirrors the PostCardSkeleton pattern used by the home feed and the
// EditProfileSkeleton used by settings: a fixed number of repeating cards
// with the AnimatedSkeleton shimmer, mounted as a non-interactive overlay
// while the real data loads. Replaces the full-screen `<Loader>` modal that
// was previously used on the Videos tab — that blocker felt out of place
// next to the inline skeletons everywhere else in the app.

import { useMemo } from "react";
import { Dimensions, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import AnimatedSkeleton from "./AnimatedSkeleton";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const CARD_WIDTH = Math.round(SCREEN_WIDTH * 0.45);
const CARD_THUMB_HEIGHT = Math.round(CARD_WIDTH / 0.59); // matches getVideoCardLayout aspectRatio 0.59

const VideosSectionSkeletonItem = () => {
  const { theme } = useAppTheme();
  return (
    <View style={{ width: CARD_WIDTH, marginRight: 12 }}>
      {/* Thumbnail */}
      <AnimatedSkeleton style={{ width: CARD_WIDTH, height: CARD_THUMB_HEIGHT, borderRadius: 12 }} />

      {/* Title (two lines) */}
      <AnimatedSkeleton style={{ marginTop: 8, height: 12, width: "92%", borderRadius: 4 }} />
      <AnimatedSkeleton style={{ marginTop: 6, height: 12, width: "70%", borderRadius: 4 }} />

      {/* Meta row — small avatar dot + creator name + dot + view count */}
      <View style={{ marginTop: 10, flexDirection: "row", alignItems: "center" }}>
        <AnimatedSkeleton style={{ width: 18, height: 18, borderRadius: 999 }} />
        <AnimatedSkeleton style={{ marginLeft: 8, height: 10, width: 70, borderRadius: 4 }} />
        <AnimatedSkeleton style={{ marginLeft: 8, height: 10, width: 30, borderRadius: 4 }} />
      </View>
    </View>
  );
};

const VideosSectionSkeleton = () => {
  const { theme } = useAppTheme();

  return (
    <View style={{ marginBottom: 16 }} pointerEvents="none">
      {/* Section header chip — violet-soft pill with small dot + label,
          rhyming with VideosSectionTitle's uppercase letter-spaced label. */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 4, marginBottom: 10 }}>
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 8,
            backgroundColor: theme.primarySoft,
            borderWidth: 1,
            borderColor: theme.primary,
            marginRight: 10,
          }}
        />
        <AnimatedSkeleton style={{ height: 12, width: 140, borderRadius: 4 }} />
      </View>

      {/* Card row — three horizontal cards is enough to peek the second
          card off the right edge, matching the rhythm of the real list. */}
      <View style={{ flexDirection: "row", paddingLeft: 4 }}>
        <VideosSectionSkeletonItem />
        <VideosSectionSkeletonItem />
        <VideosSectionSkeletonItem />
      </View>
    </View>
  );
};

const VideosSectionsSkeleton = ({ count = 4 }) => {
  // Memoize the array length so we don't reallocate on every animation tick
  // of the inner shimmer.
  const items = useMemo(() => Array.from({ length: count }), [count]);
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 4 }} pointerEvents="none">
      {items.map((_, index) => (
        <VideosSectionSkeleton key={`videos-section-skeleton-${index}`} />
      ))}
    </View>
  );
};

export default VideosSectionsSkeleton;
