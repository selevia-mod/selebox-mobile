import { Text, View } from "react-native";
import useAppTheme from "../hooks/useAppTheme";
import { getRoleNames } from "../lib/user-roles";
import RoleVerifiedBadge from "./RoleVerifiedBadge";

// Facebook / Meta-style verified chip on the profile screen: single
// seal badge tinted to the role's color, followed by the role name.
//
// Single-badge rule: when a user qualifies for multiple roles, only
// the highest-priority one renders. Priority matches the cascade used
// everywhere else (UserRoleBadgeIcons, backfill script, web seal):
//
//   moderator > pioneer > creator > writer > auditor
const ROLE_PRIORITY = ["Moderator", "Pioneer", "Creator", "Writer", "Auditor"];

const pickHighestPriority = (roles) => {
  for (const candidate of ROLE_PRIORITY) {
    if (roles.includes(candidate)) return candidate;
  }
  return null;
};

export default function UserRoleChips({
  user,
  iconSize = 18,
  containerClassName = "flex-row flex-wrap items-center gap-2",
  chipClassName = "flex-row items-center",
  textClassName = "text-[12px] font-semibold",
  textColor,
}) {
  const { theme } = useAppTheme();
  const resolvedTextColor = textColor ?? theme.text;
  const role = pickHighestPriority(getRoleNames(user));
  if (!role) return null;

  return (
    <View className={containerClassName}>
      <View className={chipClassName}>
        <RoleVerifiedBadge role={role} size={iconSize} />
        <Text className={textClassName} style={{ color: resolvedTextColor, marginLeft: 6, letterSpacing: 0.1 }}>
          {role}
        </Text>
      </View>
    </View>
  );
}
