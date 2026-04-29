/**
 * Global Default Font Override (iOS + Android)
 *
 * Monkey-patches Text.render and TextInput.render to:
 * 1. Inject fontFamily: "Inter-Regular" as the lowest-priority base style,
 *    ensuring a consistent default font across both platforms.
 * 2. Resolve fontWeight values (from Tailwind's font-bold, font-semibold, etc.)
 *    to the correct font file name for both Inter and Poppins families.
 *
 * This is necessary because React Native (especially Android) requires
 * the exact font file name — setting fontWeight alone with a base
 * fontFamily does not automatically resolve to the correct variant.
 *
 * How it works:
 * - Places Inter-Regular as the base default style (first in array, so any
 *   explicit fontFamily from NativeWind or inline styles overrides it).
 * - After merging, flattens the style to check the resolved fontFamily.
 * - If the resolved fontFamily belongs to a known font family (Inter or Poppins),
 *   maps fontWeight to the correct font file and strips fontWeight to avoid
 *   Android conflicts.
 * - Unknown fonts (system, Stream Chat, etc.) are left untouched.
 *
 * NOTE: This relies on React 18's forwardRef returning { render: fn }.
 * If upgrading to React 19 (where forwardRef is deprecated), this approach
 * must be revisited.
 */
import { StyleSheet, Text, TextInput } from "react-native";

const INTER_WEIGHT_MAP = {
  100: "Inter-Thin",
  ultralight: "Inter-Thin",
  200: "Inter-ExtraLight",
  300: "Inter-Light",
  light: "Inter-Light",
  400: "Inter-Regular",
  normal: "Inter-Regular",
  500: "Inter-Medium",
  medium: "Inter-Medium",
  600: "Inter-SemiBold",
  semibold: "Inter-SemiBold",
  700: "Inter-Bold",
  bold: "Inter-Bold",
  800: "Inter-ExtraBold",
  heavy: "Inter-ExtraBold",
  900: "Inter-Black",
  black: "Inter-Black",
};

const POPPINS_WEIGHT_MAP = {
  100: "Poppins-Thin",
  ultralight: "Poppins-Thin",
  200: "Poppins-ExtraLight",
  300: "Poppins-Light",
  light: "Poppins-Light",
  400: "Poppins-Regular",
  normal: "Poppins-Regular",
  500: "Poppins-Medium",
  medium: "Poppins-Medium",
  600: "Poppins-SemiBold",
  semibold: "Poppins-SemiBold",
  700: "Poppins-Bold",
  bold: "Poppins-Bold",
  800: "Poppins-ExtraBold",
  heavy: "Poppins-ExtraBold",
  900: "Poppins-Black",
  black: "Poppins-Black",
};

// Map each font file name to its weight map for quick lookup
const FONT_FAMILY_TO_WEIGHT_MAP = {};
for (const font of Object.values(INTER_WEIGHT_MAP)) {
  FONT_FAMILY_TO_WEIGHT_MAP[font] = INTER_WEIGHT_MAP;
}
for (const font of Object.values(POPPINS_WEIGHT_MAP)) {
  FONT_FAMILY_TO_WEIGHT_MAP[font] = POPPINS_WEIGHT_MAP;
}

const DEFAULT_FONT_STYLE = { fontFamily: "Inter-Regular" };

function resolveStyle(propsStyle) {
  const merged = [DEFAULT_FONT_STYLE, propsStyle];
  const flat = StyleSheet.flatten(merged) || {};
  const { fontFamily, fontWeight, ...rest } = flat;

  // Resolve weight → font file for known families (Inter & Poppins)
  const weightMap = fontFamily && FONT_FAMILY_TO_WEIGHT_MAP[fontFamily];
  if (weightMap && fontWeight) {
    const resolved = weightMap[fontWeight] || fontFamily;
    return { ...rest, fontFamily: resolved };
  }

  // Unknown font or no fontWeight — return merged as-is
  return merged;
}

const oldTextRender = Text.render;
Text.render = function (props, ref) {
  return oldTextRender({ ...props, style: resolveStyle(props.style) }, ref);
};
Text.render.displayName = oldTextRender.displayName || "Text";

const oldTextInputRender = TextInput.render;
TextInput.render = function (props, ref) {
  return oldTextInputRender({ ...props, style: resolveStyle(props.style) }, ref);
};
TextInput.render.displayName = oldTextInputRender.displayName || "TextInput";
