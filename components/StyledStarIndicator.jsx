import { useEffect } from "react";
import { Text, TouchableOpacity } from "react-native";
import { useGlobalContext } from "../context/global-provider";
import StarIcon from "./StarIcon";

function StyledStarIndicator({ ...props }) {
  const { starsData, refetchStars } = useGlobalContext();

  useEffect(() => {
    const doRefetch = async () => await refetchStars();
    doRefetch();
  }, []);

  return (
    <TouchableOpacity activeOpacity={0.7} className="flex-row items-center space-x-2" {...props}>
      <StarIcon size={25} color="#fbbf24" />
      <Text className="font-pmedium text-base text-[#fbbf24]">{starsData?.stars}</Text>
    </TouchableOpacity>
  );
}
export default StyledStarIndicator;
