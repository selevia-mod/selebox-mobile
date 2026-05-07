import { Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const BookTag = ({ tagName }) => {
  const { theme } = useAppTheme();

  // Lowercase keys so the lookup matches `book.status` values from
  // Supabase (normalized to "ongoing" / "completed" lowercase) AND
  // historical Appwrite values which were "Ongoing" / "Completed"
  // capitalized. Either form resolves to the same colored pill.
  const tagStyles = {
    ongoing:    { bg: theme.accentAmberSoft, text: theme.accentAmber },
    completed:  { bg: theme.accentGreenSoft, text: theme.accentGreen },
    "rated pg": { bg: theme.accentBlueSoft,  text: theme.accentBlue },
    "rated 18": { bg: theme.dangerSoft,      text: theme.danger },
    paid:       { bg: theme.accentPurpleSoft, text: theme.accentPurple },
    free:       { bg: theme.accentGreenSoft,  text: theme.accentGreen },
    downloaded: { bg: theme.primarySoft,      text: theme.primary },
    draft:      { bg: theme.surfaceMuted,     text: theme.textSoft },
  };

  // Display label uses Title Case for visual consistency, but preserves
  // acronyms in content-rating tags so "Rated PG" / "Rated SPG" don't
  // collapse to "Rated Pg" / "Rated Spg" via the naive title-case
  // pass below.
  const RATING_ACRONYMS = new Set(["PG", "SPG", "G", "R", "X", "PG-13", "R-13", "R-16", "R-18", "NC-17"]);
  const titleCase = (s) => {
    const str = String(s || "");
    return str
      .split(/\s+/)
      .map((word) => {
        if (!word) return word;
        // Preserve numeric tokens as-is (e.g., "18" in "Rated 18").
        if (/^\d/.test(word)) return word;
        // Preserve content-rating acronyms uppercased.
        if (RATING_ACRONYMS.has(word.toUpperCase())) return word.toUpperCase();
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(" ");
  };

  const lookup = String(tagName || "").toLowerCase();
  const style = tagStyles[lookup] || {
    bg: theme.surfaceMuted,
    text: theme.text,
  };

  return (
    <View className="mr-1 self-start rounded-md px-2 py-0.5" style={{ backgroundColor: style.bg }}>
      <Text className="text-xs font-semibold" style={{ color: style.text }}>
        {titleCase(tagName)}
      </Text>
    </View>
  );
};

export default BookTag;
