import { MaterialCommunityIcons } from "@expo/vector-icons";
import { memo, useCallback } from "react";
import { FlatList, Text, View, useWindowDimensions } from "react-native";
import { useSelector } from "react-redux";
import useAppTheme from "../hooks/useAppTheme";
import BookCard from "./BookCard";
import BooksSectionTitle from "./BooksSectionTitle";

const selectFreshRead = (state) => state.books.freshRead;

const BooksFreshRead = () => {
  const { theme } = useAppTheme();
  const freshRead = useSelector(selectFreshRead);
  const { width } = useWindowDimensions();

  const renderItem = useCallback(({ item }) => {
    return <BookCard item={item} />;
  }, []);
  const keyExtractor = useCallback((item, index) => item?.$id || `fresh-${index}`, []);

  return (
    <View className="space-y-2">
      <BooksSectionTitle title={"Fresh Reads"} />
      <FlatList
        removeClippedSubviews={false}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={keyExtractor}
        data={freshRead}
        renderItem={renderItem}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={5}
        ListEmptyComponent={
          <View style={{ width }} className="flex-1 items-center justify-center px-4 py-12">
            <MaterialCommunityIcons name="book-open-page-variant" size={48} color={theme.textSubtle} />
            <Text className="mt-4 text-lg font-semibold" style={{ color: theme.text }}>
              No Books Found
            </Text>
            <Text className="mt-2 text-center text-sm" style={{ color: theme.textSoft }}>
              We couldn't find any books in this category.{"\n"}
              Try exploring another one or upload your own!
            </Text>
          </View>
        }
      />
    </View>
  );
};

export default memo(BooksFreshRead);
