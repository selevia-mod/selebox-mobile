import { Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const BookTag = ({ tagName }) => {
  const { theme } = useAppTheme();

  const tagStyles = {
    Ongoing: { bg: theme.accentAmberSoft, text: theme.accentAmber },
    Completed: { bg: theme.accentGreenSoft, text: theme.accentGreen },
    "Rated PG": { bg: theme.accentBlueSoft, text: theme.accentBlue },
    "Rated 18": { bg: theme.dangerSoft, text: theme.danger },
    Paid: { bg: theme.accentPurpleSoft, text: theme.accentPurple },
    Free: { bg: theme.accentGreenSoft, text: theme.accentGreen },
    Downloaded: { bg: theme.primarySoft, text: theme.primary },
    Draft: { bg: theme.surfaceMuted, text: theme.textSoft },
  };

  const style = tagStyles[tagName] || {
    bg: theme.surfaceMuted,
    text: theme.text,
  };

  return (
    <View className="mr-1 self-start rounded-md px-2 py-0.5" style={{ backgroundColor: style.bg }}>
      <Text className="text-xs font-semibold uppercase" style={{ color: style.text }}>
        {tagName}
      </Text>
    </View>
  );
};

export default BookTag;
