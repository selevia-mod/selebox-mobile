import { useCallback, useEffect, useRef, useState } from "react";

export const useModalMessage = () => {
  const [message, setMessage] = useState("");
  const [messageOpen, setMessageOpen] = useState(false);
  const onCloseCallback = useRef(null);
  const timerRef = useRef(null);

  const showMessage = useCallback((msg, delay = 300, onClose) => {
    setMessage(msg);

    // store callback if provided
    onCloseCallback.current = onClose || null;

    // clear any pending timeout before scheduling a new one
    if (timerRef.current) clearTimeout(timerRef.current);

    // show modal after delay
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setMessageOpen(true);
    }, delay);
  }, []);

  const closeMessage = useCallback(() => {
    // clear any pending timeout so it doesn't re-open after dismiss
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    setMessageOpen(false);

    // run callback (if any) after modal closes
    if (typeof onCloseCallback.current === "function") {
      onCloseCallback.current();
      onCloseCallback.current = null; // reset
    }
  }, []);

  // cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return {
    message,
    messageOpen,
    showMessage,
    closeMessage,
  };
};
