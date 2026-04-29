import { router } from "expo-router";
import { Text, TouchableOpacity } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const BooksSectionTitle = ({ title }) => {
  const { theme } = useAppTheme();
  const handleSectionPress = () => {
    router.push({
      pathname: "category",
      params: {
        category: title,
      },
    });
  };

  return (
    <TouchableOpacity className="my-2 self-start rounded-lg px-2 py-0.5" style={{ backgroundColor: theme.accentPurple }}>
      <Text className="text-lg font-bold" style={{ color: theme.primaryContrast }}>
        {title}
      </Text>
    </TouchableOpacity>
  );
};

export default BooksSectionTitle;
