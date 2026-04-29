import { FontAwesome5 } from "@expo/vector-icons";
import { useEffect } from "react";
import { Text, TouchableOpacity } from "react-native";
import { useGlobalContext } from "../context/global-provider";

function StyledCoinIndicator({ ...props }) {
  const { balance, refetchBalance, user } = useGlobalContext();

  useEffect(() => {
    const doRefetch = async () => await refetchBalance(user?.$id);
    doRefetch();
  }, []);

  return (
    <TouchableOpacity activeOpacity={0.7} className="flex-row items-center space-x-2" {...props}>
      <FontAwesome5 name="coins" size={16} color="#fbbf24" />
      <Text className="font-pmedium text-base text-[#fbbf24]">{balance}</Text>
    </TouchableOpacity>
  );
}
export default StyledCoinIndicator;
