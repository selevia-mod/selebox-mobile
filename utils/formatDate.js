export const formatDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const isValidDateParts = (year, month, day) => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
};

export const parseDateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  if (typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
    if (match) {
      const year = Number(match[1]);
      const firstPart = Number(match[2]);
      const secondPart = Number(match[3]);

      if (isValidDateParts(year, firstPart, secondPart)) {
        return new Date(year, firstPart - 1, secondPart);
      }

      // Backward compatibility for dates previously saved as YYYY-DD-MM.
      if (isValidDateParts(year, secondPart, firstPart)) {
        return new Date(year, secondPart - 1, firstPart);
      }

      return null;
    }
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
