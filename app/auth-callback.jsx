// app/auth-callback.jsx
// Deep link target for Supabase OAuth redirect (talesofsiren://auth-callback).
//
// The intent filter in app.json registers `host=auth-callback` so Android
// launches the app when this URL fires. WebBrowser.openAuthSessionAsync
// captures the redirect within its session and returns control to
// signInWithGoogle BEFORE this route renders, so this page is rarely
// reached. But if the OS deep link wins the race (cold start, app not in
// foreground, etc.), we redirect synchronously to home so users never see
// a blank or "not found" screen.
import { Redirect } from "expo-router";

export default function AuthCallback() {
  return <Redirect href="/(tabs)/home" />;
}
