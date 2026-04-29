import { NetInfoStateType, useNetInfo } from "@react-native-community/netinfo";

export default function useIsOffline() {
  const netInfo = useNetInfo();

  return (
    netInfo.type === NetInfoStateType.none ||
    netInfo.isConnected === false ||
    netInfo.isInternetReachable === false
  );
}
