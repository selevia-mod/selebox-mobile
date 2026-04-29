import { useMemo } from "react";
import { useSelector } from "react-redux";
import { DEFAULT_THEME_MODE, getThemeColors, THEME_MODES } from "../theme/colors";

export const selectThemeMode = (state) => state?.app?.themeMode || DEFAULT_THEME_MODE;

const useAppTheme = () => {
  const themeMode = useSelector(selectThemeMode);

  return useMemo(
    () => ({
      themeMode,
      isDarkMode: themeMode === THEME_MODES.dark,
      theme: getThemeColors(themeMode),
    }),
    [themeMode],
  );
};

export default useAppTheme;
