import { Image, Text, View } from "react-native";
import images from "../assets/images";
import useAppTheme from "../hooks/useAppTheme";

const EmptyState = ({ title, imageStyle, titleStyle }) => {
  const { theme } = useAppTheme();

  return (
    <View className="w-full items-center justify-center">
      <Image source={images.empty} resizeMode="contain" className="h-[200px] w-full" style={imageStyle} />
      <Text className="text-center font-psemibold text-lg uppercase tracking-widest" style={[{ color: theme.text }, titleStyle]}>
        {title}...
      </Text>
    </View>
  );
};

export default EmptyState;
