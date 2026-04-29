import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { Text, TextInput, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const StyledFormField = ({ title, value, placeholder, handleChangeText, icon, ...props }) => {
  const { theme } = useAppTheme();
  const [showPassword, setShowPassword] = useState(false);

  return (
    <View className="w-full space-y-2" {...props}>
      <Text className="ml-1 font-pmedium text-sm uppercase tracking-wider" style={{ color: theme.textSoft }}>
        {title}
      </Text>

      <View
        className="w-full flex-row items-center space-x-3 rounded-xl px-4 py-3.5"
        style={{ backgroundColor: theme.inputBackground, borderWidth: 1, borderColor: theme.inputBorder }}
      >
        {icon}

        <TextInput
          className="flex-1 font-plight text-base"
          style={{ color: theme.inputText }}
          value={value}
          placeholder={placeholder}
          placeholderTextColor={theme.placeholder}
          selectionColor={theme.primary}
          onChangeText={handleChangeText}
          keyboardType={
            title.includes("Email")
              ? "email-address"
              : title.includes("Quantity")
                ? "numeric"
                : title.includes("Link") || title.includes("URL")
                  ? "url"
                  : "default"
          }
          secureTextEntry={title.includes("Password") && !showPassword}
        />

        {title.includes("Password") && (
          <TouchableOpacity activeOpacity={0.7} onPress={() => setShowPassword(!showPassword)}>
            {showPassword ? <Feather name="eye" size={22} color={theme.primary} /> : <Feather name="eye-off" size={22} color={theme.placeholder} />}
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};

export default StyledFormField;
