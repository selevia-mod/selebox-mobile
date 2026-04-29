import { SafeAreaView } from "react-native-safe-area-context";
import useAppTheme from "../hooks/useAppTheme";

function StyledSafeAreaView({ children, style, ...props }) {
  const { theme } = useAppTheme();

  return (
    <SafeAreaView className="flex-1 w-full items-center justify-center" style={[{ backgroundColor: theme.background }, style]} {...props}>
      {children}
    </SafeAreaView>
  );
}

export default StyledSafeAreaView;
