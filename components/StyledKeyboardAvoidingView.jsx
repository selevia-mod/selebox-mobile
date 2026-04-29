import { KeyboardAvoidingView, Platform } from "react-native";

function StyledKeyboardAvoidingView({ children, style, ...props }) {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      enabled={Platform.OS === "ios"}
      className="flex-1 w-full self-stretch"
      style={style}
      {...props}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

export default StyledKeyboardAvoidingView;
