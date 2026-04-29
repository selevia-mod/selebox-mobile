import { AntDesign } from "@expo/vector-icons";
import { router, usePathname } from "expo-router";
import { useState } from "react";
import { Alert, TextInput, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const StyledSearch = ({ initialQuery, ...props }) => {
  const { theme } = useAppTheme();
  const pathname = usePathname();
  const [query, setQuery] = useState(initialQuery || "");

  const submit = () => {
    if (query === "") return Alert.alert("Missing Query", "Please input something to search.");
    if (pathname.startsWith("/search")) router.setParams({ query });
    else router.push(`/search/${query}`);
  };

  return (
    <View
      className="flex-row items-center space-x-2 rounded-lg border px-2"
      style={{ borderColor: theme.searchBorder, backgroundColor: theme.searchBackground }}
      {...props}
    >
      <TextInput
        className="flex-1 font-plight text-sm"
        style={{ color: theme.searchText }}
        value={query}
        placeholder="Search..."
        keyboardType="search"
        placeholderTextColor={theme.searchPlaceholder}
        selectionColor={theme.primary}
        onChangeText={(e) => setQuery(e)}
        onSubmitEditing={submit}
      />

      <TouchableOpacity activeOpacity={0.7} onPress={submit}>
        <AntDesign name="search1" size={20} color={theme.icon} />
      </TouchableOpacity>
    </View>
  );
};

export default StyledSearch;
