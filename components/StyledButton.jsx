import { Text, TouchableOpacity } from "react-native";
import LoaderKit from "react-native-loader-kit";
import useAppTheme from "../hooks/useAppTheme";

const StyledButton = ({
  title,
  handlePress,
  isLoading,
  icon,
  bgColorBtn,
  textColorBtn,
  buttonColor,
  labelColor,
  loaderColor,
  className = "",
  style,
  disabled = false,
  ...props
}) => {
  const { theme } = useAppTheme();
  const darkTextToken = ["text", "black"].join("-");
  const usesDarkText = textColorBtn === darkTextToken;
  const isDisabled = isLoading || disabled;
  const resolvedLabelColor = labelColor ?? (textColorBtn ? undefined : theme.primaryContrast);
  const resolvedLoaderColor = loaderColor ?? labelColor ?? (usesDarkText ? theme.text : theme.primaryContrast);

  return (
    <TouchableOpacity
      activeOpacity={isDisabled ? 1 : 0.8}
      onPress={handlePress}
      className={`flex-row items-center justify-center space-x-2 rounded-xl px-5 py-4 ${isDisabled ? "opacity-50" : ""} ${bgColorBtn || ""} ${className}`}
      style={[{ backgroundColor: buttonColor ?? (bgColorBtn ? undefined : theme.primary) }, style]}
      disabled={isDisabled}
      {...props}
    >
      {icon}
      <Text className={`text-center text-sm font-bold ${textColorBtn || ""}`} style={{ color: resolvedLabelColor }}>
        {title}
      </Text>
      {isLoading && <LoaderKit style={{ width: 18, height: 18 }} name={"BallSpinFadeLoader"} color={resolvedLoaderColor} />}
    </TouchableOpacity>
  );
};

export default StyledButton;
