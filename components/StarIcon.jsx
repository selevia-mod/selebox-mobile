import Svg, { Path } from "react-native-svg";

export default function StarIcon({ size = 40, color = "#FFD54A", ...props }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityRole="image" accessible {...props}>
      <Path fill={color} d="M50 8 L58 40 L90 50 L58 60 L50 92 L42 60 L10 50 L42 40 Z" />

      <Path fill={color} d="M78 15 L81 23 L89 27 L81 31 L78 39 L75 31 L67 27 L75 23 Z" opacity={0.95} />

      <Path fill={color} d="M20 20 L22 25 L27 27 L22 29 L20 34 L18 29 L13 27 L18 25 Z" opacity={0.8} />

      <Path fill={color} d="M22 70 L25 77 L33 81 L25 85 L22 92 L19 85 L11 81 L19 77 Z" opacity={0.9} />
    </Svg>
  );
}
