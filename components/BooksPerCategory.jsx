import { MaterialCommunityIcons } from "@expo/vector-icons";
import { memo, useCallback } from "react";
import { Dimensions, FlatList, Text, View } from "react-native";
import { useSelector } from "react-redux";
import useAppTheme from "../hooks/useAppTheme";
import BookCard from "./BookCard";
import BooksSectionTitle from "./BooksSectionTitle";

const BooksPerCategory = ({ category }) => {
  const { theme } = useAppTheme();
  const { categories } = useSelector((state) => state.books);
  const { width } = Dimensions.get("window");

  const renderItem = useCallback(({ item }) => {
    return <BookCard key={item.uri} item={item} />;
  }, []);

  if (categories[category]?.length <= 0) return;

  return (
    <View className="space-y-2">
      <BooksSectionTitle title={category} />
      <FlatList
        removeClippedSubviews={false}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item, index) => item?.$id || `${item.type}-${index}`}
        data={categories[category] || []}
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

export default memo(BooksPerCategory);
