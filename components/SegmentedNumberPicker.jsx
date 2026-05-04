// SegmentedNumberPicker — a horizontal row of small numeric pill buttons.
//
// Used by the book-editor (lock_from_chapter, 5-10) and the chapter-editor
// (unlock_cost_coins / unlock_cost_stars, 1-10 with an optional Default
// segment that maps to null). Tap a pill to select that value; the
// selected pill flips to the brand color. Keeps interaction within the
// horizontal scroll surface so the picker doesn't break narrow screens.
//
// Why a custom segmented control instead of RN's Picker:
//   - Picker on iOS is a wheel and on Android is a dropdown — different
//     mental models per OS for a control we want to look identical and
//     fit on one line. The segmented row is fast to tap, has obvious
//     affordance, and matches the BookTag / RoleVerifiedBadge style
//     already used elsewhere in the editor.
//
// Props:
//   - values:        number[] (or [{value, label}, …]) of options to show.
//                    A null in the array renders the "Default" segment.
//   - selected:      currently selected value (number, null, or string
//                    "default"). null === "default" === "use the
//                    inherited app_config value" semantics.
//   - onChange:      (newValue) => void. Emits the raw numeric value, or
//                    null when the Default segment is tapped.
//   - disabled:      whole row is non-interactive when true.
//
// Visual contract is intentionally tight: 38pt min-height segments,
// pill border-radius, small horizontal padding, hairline border on the
// unselected ones for visual rhythm.

import React, { useMemo } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";

const SegmentedNumberPicker = ({ values = [], selected, onChange, disabled = false }) => {
  const { theme } = useAppTheme();

  // Normalize to { value, label } so we can render a Default sentinel.
  const items = useMemo(
    () =>
      values.map((v) => {
        if (v === null || v === undefined) return { value: null, label: "Default" };
        if (typeof v === "object") return { value: v.value, label: v.label ?? String(v.value) };
        return { value: v, label: String(v) };
      }),
    [values],
  );

  // Treat null and "default" as equivalent for the selected check.
  const isSelected = (val) => {
    if (val === null && (selected === null || selected === undefined || selected === "default")) return true;
    return val === selected;
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ flexDirection: "row", paddingVertical: 4 }}
    >
      {items.map((item) => {
        const active = isSelected(item.value);
        const isDefault = item.value === null;
        return (
          <TouchableOpacity
            key={isDefault ? "__default__" : item.value}
            disabled={disabled}
            onPress={() => onChange?.(item.value)}
            activeOpacity={0.7}
            style={{
              minWidth: isDefault ? 76 : 44,
              minHeight: 38,
              paddingHorizontal: 12,
              borderRadius: 999,
              marginRight: 8,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: active ? theme.primary : theme.surfaceMuted,
              borderWidth: active ? 0 : 1,
              borderColor: theme.borderSubtle ?? theme.surfaceStrong,
              opacity: disabled ? 0.4 : 1,
            }}
          >
            <Text
              style={{
                color: active ? theme.primaryContrast : theme.text,
                fontWeight: active ? "700" : "500",
                fontSize: 14,
                letterSpacing: 0.2,
              }}
            >
              {item.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
};

export default SegmentedNumberPicker;
