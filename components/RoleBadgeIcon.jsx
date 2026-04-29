import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import useAppTheme from "../hooks/useAppTheme";
import { getRoleBadgeForegroundColor, ROLE_BADGE_META } from "../lib/user-roles";
import CreatorBadgeIcon, { getCreatorBadgeDimensions } from "./CreatorBadgeIcon";
import PioneerBadgeIcon from "./PioneerBadgeIcon";
import WriterBadgeIcon, { getWriterBadgeDimensions } from "./WriterBadgeIcon";

export default function RoleBadgeIcon({ role, size = 12, color, style }) {
  const { isDarkMode } = useAppTheme();
  const meta = ROLE_BADGE_META[role] ?? ROLE_BADGE_META.User;
  const iconColor = color ?? getRoleBadgeForegroundColor(role, isDarkMode);
  const iconName = meta?.badgeIconName ?? meta?.iconName;
  const iconFamily = meta?.badgeIconFamily ?? meta?.iconFamily;
  const customIcon = meta?.badgeCustomIcon ?? meta?.customIcon;

  if (customIcon === "creator") {
    return <CreatorBadgeIcon {...getCreatorBadgeDimensions(size)} color={iconColor} style={style} />;
  }

  if (customIcon === "pioneer") {
    return <PioneerBadgeIcon width={(size * 835) / 705} height={size} color={iconColor} style={style} />;
  }

  if (customIcon === "writer") {
    return <WriterBadgeIcon {...getWriterBadgeDimensions(size)} color={iconColor} style={style} />;
  }

  if (!iconName) return null;

  if (iconFamily === "FontAwesome5") {
    return <FontAwesome5 name={iconName} size={size} color={iconColor} solid style={style} />;
  }

  return <MaterialCommunityIcons name={iconName} size={size} color={iconColor} style={style} />;
}
