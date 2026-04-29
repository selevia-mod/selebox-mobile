export const waitForAppwriteWebSocketReady = async (projectId, endpoint, timeout = 5000) => {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${endpoint.replace(/^http/, "ws")}/realtime?project=${projectId}`);

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket timeout"));
    }, timeout);

    socket.onopen = () => {
      clearTimeout(timer);
      socket.close(); // we just wanted to check readiness
      resolve(true);
    };

    socket.onerror = (err) => {
      clearTimeout(timer);
      reject(err);
    };
  });
};
