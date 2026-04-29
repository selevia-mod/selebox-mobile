import { View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import { getBadgeRoleNames, getRoleBadgeBorderColor, getRoleBadgeForegroundColor, getRoleBadgeSurfaceColor } from "../lib/user-roles";
import RoleBadgeIcon from "./RoleBadgeIcon";

const UserRoleBadgeIcons = ({ user, size = 12, containerClassName = "ml-1 flex-row items-center", iconSpacing = 4, maxVisible = null }) => {
  const { isDarkMode } = useAppTheme();
  const roles = getBadgeRoleNames(user);
  const visibleRoles = maxVisible ? roles.slice(0, maxVisible) : roles;

  if (!visibleRoles.length) return null;

  return (
    <View className={containerClassName}>
      {visibleRoles.map((role, index) => {
        const badgeBackgroundColor = getRoleBadgeSurfaceColor(role, isDarkMode, "icon");
        const badgeBorderColor = getRoleBadgeBorderColor(role, isDarkMode, "icon");
        const foregroundColor = getRoleBadgeForegroundColor(role, isDarkMode);
        return (
          <View key={`${role}-${index}`} style={index > 0 ? { marginLeft: iconSpacing } : null}>
            <View
              className="items-center justify-center rounded-full"
              style={
                isDarkMode
                  ? null
                  : {
                      paddingHorizontal: 4,
                      paddingVertical: 3,
                      backgroundColor: badgeBackgroundColor,
                      borderWidth: badgeBorderColor === "transparent" ? 0 : 1,
                      borderColor: badgeBorderColor,
                    }
              }
            >
              <RoleBadgeIcon role={role} size={size} color={foregroundColor} />
            </View>
          </View>
        );
      })}
    </View>
  );
};

export default UserRoleBadgeIcons;
