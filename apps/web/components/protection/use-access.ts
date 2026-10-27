"use client";

import { useEffect, useSyncExternalStore } from "react";
import { ACCESS_TTL_MS, accessStore, type Access } from "./access-client";

const noAccess = (): Access | null => null;

/**
 * The visitor's access (GET /api/access); null until read, or when it cannot be. Read on mount, and
 * again while the page stays open and visible once the last read is ACCESS_TTL_MS old, so a mode
 * that changes under an open page (the question box's paused state) is seen.
 */
export function useAccess(): Access | null {
  const access = useSyncExternalStore(accessStore.subscribe, accessStore.getSnapshot, noAccess);
  useEffect(() => {
    void accessStore.load();
    const refresh = () => {
      if (document.visibilityState === "visible") void accessStore.load();
    };
    const timer = setInterval(refresh, ACCESS_TTL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return access;
}
