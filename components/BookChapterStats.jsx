import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import { BookReadService } from "../lib/book-reads";
import { BookService } from "../lib/books";
import FormatNumber from "../lib/format-number";
import AnimatedSkeleton from "./AnimatedSkeleton";

const BookChapterStats = ({ chapter, bookReadingTheme, pageColor }) => {
  const { theme } = useAppTheme();
  const [likeTotal, setLikeTotal] = useState(0);
  const [commentTotal, setCommentTotal] = useState(0);
  const [readTotal, setReadTotal] = useState(0);
  const [isBookStatsLoading, setIsBookStatsLoading] = useState(true);

  const bookService = new BookService();

  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsBookStatsLoading(true);
        await Promise.all([fetchBookChapterLikes(), fetchBookChapterComments(), fetchBookChapterRead()]);
      } catch (error) {
        console.log("fetchData error", error);
      } finally {
        setIsBookStatsLoading(false);
      }
    };
    fetchData();
  }, [chapter?.$id]);

  const fetchBookChapterLikes = async () => {
    try {
      const bookChapterLikes = await bookService.getBookChapterLikes({ bookChapterId: chapter.$id });
      setLikeTotal(bookChapterLikes.total ?? 0);
    } catch (error) {
      console.log("fetchBookChapterLikes: error", error);
    }
  };

  const fetchBookChapterComments = async () => {
    try {
      const bookChapterComments = await bookService.getBookChapterComments({ bookChapterId: chapter.$id });
      setCommentTotal(bookChapterComments.total ?? 0);
    } catch (error) {
      console.log("fetchBookChapterLikes: error", error);
    }
  };

  const fetchBookChapterRead = async () => {
    try {
      const bookChapterRead = await BookReadService.fetchChapterRead({ chapterId: chapter.$id });
      setReadTotal(bookChapterRead ?? 0);
    } catch (error) {
      console.log("fetchBookChapterRead: error", error);
    }
  };

  const currentPageTheme = bookReadingTheme[pageColor];
  const skeletonColor = currentPageTheme.skeletonBase;
  const valueColor = currentPageTheme.textSoft;

  return (
    <View className="mb-4 items-center">
      <Text className="text-lg font-bold" style={{ color: bookReadingTheme[pageColor].fontColor }}>
        {chapter?.title}
      </Text>
      <View className="mt-2 flex-row space-x-4">
        {isBookStatsLoading ? (
          <>
            <View className="flex-row items-center space-x-1">
              <AnimatedSkeleton className="h-5 w-4 rounded-md" style={{ backgroundColor: skeletonColor }} />
              <AnimatedSkeleton className="h-4 w-5 rounded" style={{ backgroundColor: skeletonColor }} />
            </View>
            <View className="flex-row items-center space-x-1">
              <AnimatedSkeleton className="h-5 w-4 rounded-md" style={{ backgroundColor: skeletonColor }} />
              <AnimatedSkeleton className="h-4 w-5 rounded" style={{ backgroundColor: skeletonColor }} />
            </View>
            <View className="flex-row items-center space-x-1">
              <AnimatedSkeleton className="h-5 w-4 rounded-md" style={{ backgroundColor: skeletonColor }} />
              <AnimatedSkeleton className="h-4 w-5 rounded" style={{ backgroundColor: skeletonColor }} />
            </View>
          </>
        ) : (
          <>
            <View className="flex-row items-center space-x-1">
              <Ionicons name="eye-outline" size={18} color={theme.accentAmber} />
              <Text style={{ color: valueColor }}>{FormatNumber(readTotal)}</Text>
            </View>
            <View className="flex-row items-center space-x-1">
              <Ionicons name="heart-outline" size={18} color={theme.danger} />
              <Text style={{ color: valueColor }}>{FormatNumber(likeTotal)}</Text>
            </View>
            <View className="flex-row items-center space-x-1">
              <Ionicons name="chatbubble-outline" size={18} color={theme.accentBlue} />
              <Text style={{ color: valueColor }}>{FormatNumber(commentTotal)}</Text>
            </View>
          </>
        )}
      </View>
    </View>
  );
};

export default BookChapterStats;
