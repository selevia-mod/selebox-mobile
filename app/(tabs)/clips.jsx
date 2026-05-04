// Retired May 2026. Clips feature removed; this route file is kept
// because expo-router still has a `<Tabs.Screen name="clips">` entry
// in app/(tabs)/_layout.jsx — the slot now hosts a "Reels coming
// soon" teaser tab. Tapping the Reels tab intercepts the tabPress
// with e.preventDefault() so this screen never mounts in normal use.
//
// If anything deep-links to /clips somehow, it gets a blank screen
// (return null) instead of trying to render the dead clips feed.
const ClipsScreen = () => null;
export default ClipsScreen;
