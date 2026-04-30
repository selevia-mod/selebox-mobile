// Tiny accent dot used in front of section headers across forms (Upload Video,
// Create / Edit Book, etc.) to carry the app's violet primary accent into
// otherwise-typographic UI. 6 px circle + 8 px right margin keeps it visually
// quiet — it's a marker, not decoration.

import { View } from "react-native";

const SectionDot = ({ color, size = 6, marginRight = 8 }) => (
  <View
    style={{
      width: size,
      height: size,
      borderRadius: 999,
      backgroundColor: color,
      marginRight,
    }}
  />
);

export default SectionDot;
