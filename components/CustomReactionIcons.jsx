// components/CustomReactionIcons.jsx
//
// Sample custom reaction icons rendered with react-native-svg (already
// in the project — used for other graphics). Each component:
//   • Accepts `size` and `color` props.
//   • Uses a 24×24 viewBox so paths can be hand-tuned at a familiar
//     coordinate scale, then scaled to any size at render time.
//   • Tints the face/shape via the `color` prop while keeping
//     features (eyes, mouth, tear) at fixed colors that read at any
//     tint.
//
// To wire into PostReaction.jsx, change the REACTION_ICONS map shape
// from { Lib, name, color } to a discriminated union like:
//
//   const REACTION_ICONS = {
//     heart: { kind: "custom", Component: HeartIcon, color: "#ef4444" },
//     laugh: { kind: "custom", Component: HahaIcon, color: "#facc15" },
//     sad:   { kind: "custom", Component: SadIcon,  color: "#facc15" },
//     ...
//   };
//
// And update the renderer in PostReactionIcon to branch on
// `kind === "custom"` and render `<config.Component size color />`.
// Total bundle cost for these three: ~2 KB of inline JSX.

import Svg, { Circle, Path } from "react-native-svg";

// ─────────────────────────────────────────────────────────────────────
// Heart — a clean solid heart shape. Path lifted from Material Icons'
// "favorite" glyph (industry-standard heart geometry, looks right at
// every size from 14pt to 32pt). Fully tintable via `color`.
// ─────────────────────────────────────────────────────────────────────
export const HeartIcon = ({ size = 18, color = "#ef4444" }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path
      d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
      fill={color}
    />
  </Svg>
);

// ─────────────────────────────────────────────────────────────────────
// Haha — yellow circle face with squinting closed-eye arches and a
// big open laughing mouth. Mirrors the visual shorthand for FB's
// "Haha" reaction without the 3D shading of Apple Color Emoji.
// ─────────────────────────────────────────────────────────────────────
export const HahaIcon = ({ size = 18, color = "#facc15" }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    {/* Face circle */}
    <Circle cx={12} cy={12} r={10} fill={color} />
    {/* Left eye — squinting upward arch (^) */}
    <Path
      d="M5.5 10.5 Q 8 8 10.5 10.5"
      stroke="#1f2937"
      strokeWidth={1.6}
      fill="none"
      strokeLinecap="round"
    />
    {/* Right eye — same shape, mirrored */}
    <Path
      d="M13.5 10.5 Q 16 8 18.5 10.5"
      stroke="#1f2937"
      strokeWidth={1.6}
      fill="none"
      strokeLinecap="round"
    />
    {/* Open laughing mouth — wide arc below the eyes */}
    <Path
      d="M6.5 13.5 Q 12 19.5 17.5 13.5 Z"
      fill="#1f2937"
    />
    {/* Inner mouth highlight (tongue / inside) — small lighter shape */}
    <Path
      d="M9 16 Q 12 18 15 16 Q 12 17.5 9 16 Z"
      fill="#dc2626"
    />
  </Svg>
);

// ─────────────────────────────────────────────────────────────────────
// Sad — yellow face with two dot eyes, a frown curve, and a single
// blue tear on the cheek. Tear stays blue regardless of face tint
// because that's the visual shorthand for "sad."
// ─────────────────────────────────────────────────────────────────────
export const SadIcon = ({ size = 18, color = "#facc15" }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    {/* Face circle */}
    <Circle cx={12} cy={12} r={10} fill={color} />
    {/* Left eye — solid dot */}
    <Circle cx={8.5} cy={10} r={1.2} fill="#1f2937" />
    {/* Right eye */}
    <Circle cx={15.5} cy={10} r={1.2} fill="#1f2937" />
    {/* Frown — downward curve below eyes */}
    <Path
      d="M8 17 Q 12 13.5 16 17"
      stroke="#1f2937"
      strokeWidth={1.6}
      fill="none"
      strokeLinecap="round"
    />
    {/* Tear drop — blue, falling from left eye */}
    <Path
      d="M7.5 12 Q 6 14.5 7.5 16 Q 9 14.5 7.5 12 Z"
      fill="#3b82f6"
    />
  </Svg>
);

// Convenience default export so the consumer can `import * as` and
// pull what they need.
export default { HeartIcon, HahaIcon, SadIcon };
