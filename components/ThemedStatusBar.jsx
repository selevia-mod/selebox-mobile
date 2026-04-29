import { StatusBar } from "expo-status-bar";
import useAppTheme from "../hooks/useAppTheme";

const ThemedStatusBar = ({ style, backgroundColor, ...props }) => {
  const { theme, isDarkMode } = useAppTheme();

  return <StatusBar style={style || (isDarkMode ? "light" : "dark")} backgroundColor={backgroundColor || theme.background} {...props} />;
};

export default ThemedStatusBar;
