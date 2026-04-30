export default function TimeAgo(utcTime) {
  const now = new Date();
  const timeDifference = now - new Date(utcTime);

  const seconds = Math.floor(timeDifference / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  const formatTime = (value, unit) => `${value} ${unit}${value === 1 ? "" : "s"} ago`;

  if (seconds < 60) {
    return formatTime(seconds, "second");
  } else if (minutes < 60) {
    return formatTime(minutes, "minute");
  } else if (hours < 24) {
    return formatTime(hours, "hour");
  } else if (days < 30) {
    return formatTime(days, "day");
  } else if (months < 12) {
    return formatTime(months, "month");
  } else {
    return formatTime(years, "year");
  }
}
