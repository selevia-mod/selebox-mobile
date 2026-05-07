// app/books/[id].tsx
import { Redirect, useLocalSearchParams } from "expo-router";
import { Loader } from "../../components";

export default function BooksRedirect() {
  const { id } = useLocalSearchParams();

  // Special case: OAuth callback redirect lands here because the
  // talesofsiren scheme is registered with host=books. Bounce to home
  // synchronously via <Redirect> — no useEffect delay, no flash.
  if (id === "auth-callback") {
    return <Redirect href="/(tabs)/home" />;
  }

  return <Loader isLoading={true} isFullHeightWidth={true} />;
}
