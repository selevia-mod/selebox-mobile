import { useEffect } from "react";
import { Image, TouchableOpacity } from "react-native";
import { useGlobalContext } from "../context/global-provider";

// Topbar entry point to the Goals and Store hub. Visible across all
// main tabs (Home, Clips, Videos, Books). Tapping opens /store.
//
// Icon-only — the balance number that used to sit alongside the icon
// was removed; the user-balance reading lives inside the Store screen
// itself (Coins balance / Stars balance cards). Keeping the topbar
// minimal lets the gift-box logo land cleanly without competing with
// numerals next to it.
//
// We still subscribe to balance via global-provider's useEffect so
// the wallet stays warm — when the user taps in, the Store cards
// render fresh balances without a loading flash.
function StyledCoinIndicator({ ...props }) {
  const { refetchBalance, user } = useGlobalContext();

  useEffect(() => {
    const doRefetch = async () => await refetchBalance(user?.$id);
    doRefetch();
  }, []);

  return (
    <TouchableOpacity activeOpacity={0.7} className="items-center justify-center" {...props}>
      <Image
        source={require("../assets/images/goals-store-logo.png")}
        style={{ width: 36, height: 36 }}
        resizeMode="contain"
      />
    </TouchableOpacity>
  );
}
export default StyledCoinIndicator;
