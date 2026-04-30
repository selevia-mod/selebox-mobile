// Global playback control bus.
//
// Why this exists:
//   The home feed and profile screens autoplay videos in the background. When
//   a modal that needs the system's foreground focus opens — most visibly the
//   Share Profile action sheet — the autoplaying expo-video player competes
//   with the share sheet (UIActivityViewController on iOS) for who gets to
//   present, and on some devices the share sheet is force-closed before the
//   user can interact with it. Emitting a "pause-all" signal when those
//   modals open releases playback ownership, so the share sheet has a clear
//   path to present and stays up until the user dismisses it.
//
// Events:
//   - "pause-all"   → broadcast by anything that wants every active video
//                     player on the screen to release playback. PostVideo /
//                     PostClip subscribe and call their internal safePause.
//   - "resume-hint" → broadcast after the blocking modal has closed; lets
//                     the most recently visible card opt back into autoplay
//                     if the user hasn't manually paused since.
//
// Usage (emit):
//   import playbackEvents from "../lib/playback-events";
//   playbackEvents.emit("pause-all");
//
// Usage (subscribe):
//   useEffect(() => {
//     const handler = () => safePause?.();
//     playbackEvents.on("pause-all", handler);
//     return () => playbackEvents.off("pause-all", handler);
//   }, [safePause]);

import { EventEmitter } from "events";

const playbackEvents = new EventEmitter();
// Several video cards can mount on the same screen (feed list, profile videos
// tab, etc). Default cap of 10 listeners is too low — bump it generously.
playbackEvents.setMaxListeners(50);

export default playbackEvents;
