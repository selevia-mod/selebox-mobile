import { AntDesign } from "@expo/vector-icons";
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { FlatList, RefreshControl, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import EmptyState from "./EmptyState";
import VideoCard from "./VideoCard";

const StyledFlatList = forwardRef(function StyledFlatList(
  {
    data,
    onRefresh = async () => {},
    onScroll,
    scrollEventThrottle = 16,
    scrollToTopStyle,
    emptyStateImageStyle,
    emptyStateTitleStyle,
    horizontal = false,
    removeClippedSubviews: removeClippedSubviewsProp,
    ...props
  },
  ref,
) {
  const { theme } = useAppTheme();
  const [refreshing, setRefreshing] = useState(false);
  const [showScrollUp, setShowScrollUp] = useState(false);
  const flatListRef = useRef(null);
  const isHorizontal = horizontal === true;
  const removeClippedSubviews = removeClippedSubviewsProp ?? !isHorizontal;

  useImperativeHandle(ref, () => ({
    scrollToIndex: (params) => flatListRef.current?.scrollToIndex(params),
    scrollToOffset: (params) => flatListRef.current?.scrollToOffset(params),
    scrollToEnd: (params) => flatListRef.current?.scrollToEnd(params),
    getScrollResponder: () => flatListRef.current?.getScrollResponder(),
    scrollToTop: () => flatListRef.current?.scrollToIndex({ index: 0, animated: true }),
  }));

  const handleScroll = (event) => {
    const offsetY = event.nativeEvent.contentOffset.y;
    setShowScrollUp(offsetY > 500);
  };

  const handleCombinedScroll = (event) => {
    handleScroll(event);
    onScroll?.(event);
  };

  const scrollToTop = () => {
    if (flatListRef.current?.props.data.length === 0) return;
    flatListRef.current.scrollToOffset({ offset: 0, animated: true });
  };

  return (
    <View className={`w-full ${isHorizontal ? "" : "flex-1"}`}>
      {showScrollUp && (
        <TouchableOpacity
          activeOpacity={0.7}
          className="absolute bottom-10 right-0 z-50 rounded-full p-3"
          style={[{ backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.border }, scrollToTopStyle]}
          onPress={scrollToTop}
        >
          <AntDesign name="arrowup" size={18} color={theme.icon} />
        </TouchableOpacity>
      )}
      <FlatList
        className={isHorizontal ? "" : "h-full"}
        ref={flatListRef}
        onScroll={handleCombinedScroll}
        scrollEventThrottle={scrollEventThrottle}
        initialNumToRender={10}
        maxToRenderPerBatch={20}
        removeClippedSubviews={removeClippedSubviews}
        windowSize={10}
        data={data}
        horizontal={horizontal}
        keyExtractor={(item, index) => item.uri || item.$id || index}
        renderItem={({ item }) => <VideoCard key={item.uri} item={item} />}
        ListEmptyComponent={() => <EmptyState imageStyle={emptyStateImageStyle} titleStyle={emptyStateTitleStyle} title="No Videos Found" />}
        ListFooterComponent={<View style={{ height: 100 }} />}
        refreshControl={
          <RefreshControl
            tintColor={theme.primary}
            titleColor={theme.primary}
            progressBackgroundColor={theme.surface}
            refreshing={refreshing}
            onRefresh={useCallback(async () => {
              setRefreshing(true);
              await onRefresh();
              setRefreshing(false);
            })}
          />
        }
        {...props}
      />
    </View>
  );
});

export default StyledFlatList;
