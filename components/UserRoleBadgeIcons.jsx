import { View } from "react-native";
import { getBadgeRoleNames } from "../lib/user-roles";
import RoleVerifiedBadge from "./RoleVerifiedBadge";

// Inline verified-badge marker for display names — Facebook-style.
//
// One badge per user. When a user qualifies for multiple roles
// (e.g., moderator + pioneer), we pick the single highest-priority
// badge per the product spec:
//
//   moderator > pioneer > creator > writer > auditor
//
// Matches the priority cascade in:
//   - scripts/backfill-roles.js → resolveRole()
//   - Selebox/js/app.js → renderRoleSeal()
//
// so the same user surfaces the same seal across mobile and web.
//
// The actual seal silhouette + per-role color comes from
// RoleVerifiedBadge (ROLE_VERIFIED_PALETTE). Single source of truth
// for the visual — palette changes ripple through every surface.
const ROLE_PRIORITY = ["Moderator", "Pioneer", "Creator", "Writer", "Auditor"];

const pickHighestPriority = (roles) => {
  for (const candidate of ROLE_PRIORITY) {
    if (roles.includes(candidate)) return candidate;
  }
  return null;
};

const UserRoleBadgeIcons = ({ user, size = 14, containerClassName = "ml-1 flex-row items-center" }) => {
  const roles = getBadgeRoleNames(user);
  const role = pickHighestPriority(roles);
  if (!role) return null;

  return (
    <View className={containerClassName}>
      <RoleVerifiedBadge role={role} size={size} />
    </View>
  );
};

export default UserRoleBadgeIcons;
