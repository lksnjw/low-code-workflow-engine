import { useCallback, useEffect, useRef, useState } from "react";
import { appConfig } from "../config/app";

export function useWebSocket(channel = "system-health") {
  const socketRef = useRef(null);
  const [readyState, setReadyState] = useState(WebSocket.CLOSED);
  const [lastJsonMessage, setLastJsonMessage] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem("workflow.authToken");
    if (!token) return undefined;

    const base = appConfig.wsBaseUrl.replace(/\/$/, "");
    const socket = new WebSocket(`${base}/${encodeURIComponent(channel)}?token=${encodeURIComponent(token)}`);
    socketRef.current = socket;
    socket.onopen = () => setReadyState(socket.readyState);
    socket.onclose = () => setReadyState(socket.readyState);
    socket.onerror = () => setReadyState(socket.readyState);
    socket.onmessage = (event) => {
      try {
        setLastJsonMessage(JSON.parse(event.data));
      } catch {
        setLastJsonMessage(event.data);
      }
    };
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [channel]);

  const sendJsonMessage = useCallback((value) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(value));
      return true;
    }
    return false;
  }, []);

  return { readyState, sendJsonMessage, lastJsonMessage };
}

export default useWebSocket;
