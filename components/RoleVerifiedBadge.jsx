import { useMemo } from "react";
import Svg, { Circle, Path } from "react-native-svg";
import { ROLE_BADGE_META } from "../lib/user-roles";

// Facebook / Meta-style verified badge: scalloped seal silhouette,
// lighter inner circle, centered white checkmark. Drawn as an SVG so
// per-role colors theme cleanly without shipping a separate raster
// asset for every role variant.
//
// Color resolution: each role pulls outer/inner shades from
// ROLE_VERIFIED_PALETTE below. Falls back to a neutral slate when a
// role isn't enumerated (so future roles render gracefully). The check
// is white in every variant — same contrast guarantee Meta uses on
// their verified badge.

const ROLE_VERIFIED_PALETTE = {
  Creator: { outer: "#D4A017", inner: "#F5C84B" },     // gold
  Writer: { outer: "#1d4ed8", inner: "#60a5fa" },      // blue
  Pioneer: { outer: "#7c3aed", inner: "#a78bfa" },     // system purple (violet-600 → violet-400)
  Moderator: { outer: "#9f1239", inner: "#e11d48" },   // maroon
  Auditor: { outer: "#0369a1", inner: "#38bdf8" },     // sky
  User: { outer: "#475569", inner: "#94a3b8" },        // neutral slate
};

const SCALLOP_BUMPS = 12;

// One-time module-scope path. Identical for every render — only fill
// colors change. 12 bumps, peak radius 48, valley radius 39, center
// (50,50). Each bump is a quadratic Bezier with the peak as the
// control point, producing a smooth scalloped silhouette.
const SCALLOPED_OUTLINE_D = (() => {
  const cx = 50;
  const cy = 50;
  const rOuter = 48;
  const rInner = 39;
  const segments = [];
  for (let i = 0; i < SCALLOP_BUMPS; i++) {
    const aStart = (i / SCALLOP_BUMPS) * Math.PI * 2 - Math.PI / 2;
    const aEnd = ((i + 1) / SCALLOP_BUMPS) * Math.PI * 2 - Math.PI / 2;
    const aPeak = ((i + 0.5) / SCALLOP_BUMPS) * Math.PI * 2 - Math.PI / 2;

    const sx = (cx + rInner * Math.cos(aStart)).toFixed(2);
    const sy = (cy + rInner * Math.sin(aStart)).toFixed(2);
    const ex = (cx + rInner * Math.cos(aEnd)).toFixed(2);
    const ey = (cy + rInner * Math.sin(aEnd)).toFixed(2);
    const px = (cx + rOuter * Math.cos(aPeak)).toFixed(2);
    const py = (cy + rOuter * Math.sin(aPeak)).toFixed(2);

    if (i === 0) segments.push(`M${sx},${sy}`);
    segments.push(`Q${px},${py} ${ex},${ey}`);
  }
  segments.push("Z");
  return segments.join(" ");
})();

const RoleVerifiedBadge = ({ role = "User", size = 18, style }) => {
  const palette = useMemo(() => ROLE_VERIFIED_PALETTE[role] ?? ROLE_VERIFIED_PALETTE.User, [role]);

  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" style={style}>
      {/* Scalloped seal silhouette */}
      <Path d={SCALLOPED_OUTLINE_D} fill={palette.outer} />
      {/* Lighter inner circle */}
      <Circle cx="50" cy="50" r="30" fill={palette.inner} />
      {/* White checkmark — same proportions as Meta's */}
      <Path
        d="M35.5 51.5 L45.5 61.5 L65 41"
        stroke="#FFFFFF"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
};

// Export the palette so the chip pill background can derive its color
// from the same source if you want a tinted-pill + verified-icon combo
// later. Currently UserRoleChips uses ROLE_BADGE_META.pillBg directly.
export { ROLE_VERIFIED_PALETTE };

// Sanity import keeps tree-shaking from dropping the role meta even
// if no other consumer imports it transitively from this file.
void ROLE_BADGE_META;

export default RoleVerifiedBadge;
