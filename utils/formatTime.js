export const formatTime = (isoString) => {
  const date = new Date(isoString);
  const now = new Date();

  const isSameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();

  const dayDiff = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

  const isSameWeek = dayDiff < 7 && date.getDay() <= now.getDay();
  const isSameYear = date.getFullYear() === now.getFullYear();

  if (isSameDay) {
    // HH:MM AM/PM
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  if (isSameWeek) {
    // Weekday name (Mon, Tue, ...)
    return date.toLocaleDateString("en-US", { weekday: "short" });
  }

  if (isSameYear) {
    // Month Day (Apr 9)
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }

  // Month Day, Year (Apr 9, 2024)
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

export const formatTimeAgo = (timestamp) => {
  if (!timestamp) return "";
  const now = new Date();
  const then = new Date(timestamp);
  const diff = Math.floor((now - then) / 1000);

  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800) return "Yesterday";
  return `${Math.floor(diff / 86400)}d ago`;
};
