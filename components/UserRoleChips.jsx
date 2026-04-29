import { Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import { getRoleBadgeBorderColor, getRoleBadgeForegroundColor, getRoleBadgeSurfaceColor, getRoleNames } from "../lib/user-roles";
import RoleBadgeIcon from "./RoleBadgeIcon";

export default function UserRoleChips({
  user,
  iconSize = 16,
  containerClassName = "flex-row flex-wrap gap-1",
  chipClassName = "flex-row items-center rounded-full px-2 py-[3px]",
  textClassName = "text-[11px] font-semibold",
  iconStyle = { marginRight: 4 },
}) {
  const { theme } = useAppTheme();

  return (
    <View className={containerClassName}>
      {getRoleNames(user).map((role) => {
        const foregroundColor = getRoleBadgeForegroundColor(role, theme.isDark);
        const badgeBackgroundColor = getRoleBadgeSurfaceColor(role, theme.isDark, "chip");
        const badgeBorderColor = getRoleBadgeBorderColor(role, theme.isDark, "chip");

        return (
          <View
            key={role}
            className={chipClassName}
            style={{
              backgroundColor: badgeBackgroundColor,
              borderWidth: badgeBorderColor === "transparent" ? 0 : 1,
              borderColor: badgeBorderColor,
            }}
          >
            <RoleBadgeIcon role={role} size={iconSize} color={foregroundColor} style={iconStyle} />
            <Text className={textClassName} style={{ color: foregroundColor }}>
              {role}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
