import { createSlice } from "@reduxjs/toolkit";
import reduxStorage from "../storage";

export const authPersistConfig = {
  key: "auth",
  storage: reduxStorage,
  whitelist: ["user"],
};

const initialState = {
  user: null,
  isLogged: false,
};

const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    setUserReducer: (state, action) => {
      state.user = action.payload;
    },
    removeUserReducer: (state) => {
      state.user = null;
    },
    setIsLoggedReducer: (state, action) => {
      state.isLogged = action.payload;
    },
    clearUserReducer: () => {
      return initialState;
    },
  },
});

export const { setUserReducer, removeUserReducer, setIsLoggedReducer, clearUserReducer } = authSlice.actions;

export const authReducer = authSlice.reducer;
