import { createSlice } from "@reduxjs/toolkit";
import reduxStorage from "../storage";
import { DEFAULT_THEME_MODE, THEME_MODES } from "../../theme/colors";

export const appPersistConfig = {
  key: "app",
  storage: reduxStorage,
  whitelist: ["globalSettings", "themeMode"],
};

const initialState = {
  globalSettings: null,
  themeMode: DEFAULT_THEME_MODE,
};

const appSlice = createSlice({
  name: "app",
  initialState,
  reducers: {
    setGlobalSettingsReducer: (state, action) => {
      state.globalSettings = action.payload;
    },
    setThemeModeReducer: (state, action) => {
      if (action.payload === THEME_MODES.light || action.payload === false) {
        state.themeMode = THEME_MODES.light;
        return;
      }

      if (action.payload === THEME_MODES.dark || action.payload === true) {
        state.themeMode = THEME_MODES.dark;
        return;
      }

      state.themeMode = DEFAULT_THEME_MODE;
    },
    toggleThemeModeReducer: (state) => {
      state.themeMode = state.themeMode === THEME_MODES.dark ? THEME_MODES.light : THEME_MODES.dark;
    },
    clearApp: () => {
      return initialState;
    },
  },
});

export const { setGlobalSettingsReducer, setThemeModeReducer, toggleThemeModeReducer, clearApp } = appSlice.actions;

export const appReducer = appSlice.reducer;
