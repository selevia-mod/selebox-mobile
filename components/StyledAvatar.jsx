import { TouchableOpacity } from "react-native";
import FastImage from "react-native-fast-image";
import { useGlobalContext } from "../context/global-provider";
import useAppTheme from "../hooks/useAppTheme";

function StyledAvatar({ onPress = null, ...props }) {
  const { theme } = useAppTheme();
  const { avatar } = useGlobalContext();

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      className="items-center justify-center rounded-lg border p-[1px]"
      style={{ borderColor: theme.borderStrong }}
      onPress={onPress}
      disabled={onPress === null}
      {...props}
    >
      <FastImage
        source={{ uri: avatar, priority: FastImage.priority.normal }}
        className="h-full w-full rounded-md"
        resizeMode={FastImage.resizeMode.cover}
      />
    </TouchableOpacity>
  );
}

export default StyledAvatar;
