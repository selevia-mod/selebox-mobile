// VideosBecauseYouWatched — videos sharing tags with the user's most
// recently watched video. The shelf title is dynamic — "Because you
// watched <anchor.title>" — so the user can see the connection. The
// caller passes the anchor video as a separate prop so it doesn't
// appear inside the carousel itself (it'd be redundant — they just
// watched it).
//
// Server contract: feed_because_you_watched returns the anchor as
// the FIRST row + recommendations as subsequent rows. The lib/video
// fetcher splits those into { anchor, recommendations } so this
// component receives them already separated.

import { router } from "expo-router";
import { useCallback, useMemo } from "react";
import { FlatList, Platform, View, useWindowDimensions } from "react-native";
import { getSectionTitleHeight, getVideoCardLayout } from "../utils/videoCardLayout";
import VideoCardNew from "./VideoCardNew";
import VideosSectionTitle from "./VideosSectionTitle";

const VideosBecauseYouWatched = ({ videos = [], anchor = null }) => {
  const { width } = useWindowDimensions();
  const { cardWidth, imageHeight, containerHeight } = useMemo(() => {
    const cw = width * 0.8;
    const layout = getVideoCardLayout({ cardWidth: cw, aspectRatio: 0.59 });
    return { cardWidth: cw, imageHeight: layout.imageHeight, containerHeight: getSectionTitleHeight() + layout.cardHeight };
  }, [width]);

  const renderItem = useCallback(
    ({ item }) => <VideoCardNew item={item} customHeight={imageHeight} customWidth={cardWidth} />,
    [cardWidth, imageHeight],
  );
  const keyExtractor = useCallback((item, index) => item?.$id || `${item.type}-${index}`, []);
  // +12 accounts for VideoCardNew's mr-3 (Tailwind = 12px); without it
  // FlatList's predicted offsets drift 12px per card and cause stutter.
  const getItemLayout = useCallback(
    (_data, index) => ({ length: cardWidth + 12, offset: (cardWidth + 12) * index, index }),
    [cardWidth],
  );

  if (!videos.length) return null;

  // Dynamic title — fall back to a generic label if the anchor title
  // is missing or absurdly long. 40 chars caps the truncation point;
  // section title row only fits ~60 chars total before wrapping on
  // smaller screens, and "Because you watched " eats 20 of those.
  const anchorTitleRaw = String(anchor?.title || "").trim();
  const anchorTitle = anchorTitleRaw.length > 40 ? `${anchorTitleRaw.slice(0, 37)}…` : anchorTitleRaw;
  const title = anchorTitle ? `Because you watched ${anchorTitle}` : "Because You Watched";

  return (
    <View style={{ minHeight: containerHeight }} className="space-y-2">
      <VideosSectionTitle
        title={title}
        onSeeAllPress={() => router.push({ pathname: "/(video)/shelf-all", params: { type: "becauseYouWatched" } })}
      />
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={keyExtractor}
        data={videos}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        initialNumToRender={4}
        maxToRenderPerBatch={4}
        windowSize={3}
        removeClippedSubviews={Platform.OS === "android"}
      />
    </View>
  );
};

export default VideosBecauseYouWatched;
