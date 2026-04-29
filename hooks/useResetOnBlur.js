import { useCallback, useRef } from "react";
import { useFocusEffect } from "expo-router";

/**
 * Resets loading/refreshing states when the screen loses focus.
 * Prevents stuck spinners when navigating away during async operations.
 *
 * @param {...Function} setters - State setter functions to call with `false` on blur
 */
export default function useResetOnBlur(...setters) {
  const settersRef = useRef(setters);
  settersRef.current = setters;

  useFocusEffect(
    useCallback(() => {
      return () => {
        settersRef.current.forEach((setter) => setter(false));
      };
    }, []),
  );
}
