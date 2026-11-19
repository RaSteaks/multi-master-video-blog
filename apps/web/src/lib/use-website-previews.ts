import { useCallback, useEffect, useState } from "react";
import { WEBSITE_PREVIEW_LIMIT, WEBSITE_PREVIEW_MOBILE_QUERY } from "./external-projects";

const BACKGROUND_RETENTION_MS = 30_000;
const SCROLL_SETTLE_MS = 250;

export function useWebsitePreviews<Key>() {
  const [live, setLive] = useState<Key[]>([]);

  // A change to the list or viewport in the background must not extend the deadline.
  useEffect(() => {
    let expiry: ReturnType<typeof setTimeout>;
    function visibilityChanged() {
      clearTimeout(expiry);
      if (document.hidden) {
        expiry = setTimeout(() => {
          if (document.hidden) setLive(current => current.length ? [] : current);
        }, BACKGROUND_RETENTION_MS);
      }
    }
    visibilityChanged();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      clearTimeout(expiry);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);

  const observeBudget = useCallback((select: (limit: number) => Key[], blocked = false) => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const mobile = matchMedia(WEBSITE_PREVIEW_MOBILE_QUERY);
    let settle: ReturnType<typeof setTimeout>;

    function apply() {
      const limit = mobile.matches ? 1 : WEBSITE_PREVIEW_LIMIT;
      if (blocked || reduced.matches) {
        setLive(current => current.length ? [] : current);
      } else if (document.hidden) {
        // A narrower viewport may trim retained frames, but cannot start new ones.
        setLive(current => current.length > limit ? current.slice(0, limit) : current);
      } else {
        const next = select(limit);
        setLive(current => current.length === next.length && current.every((key, i) => key === next[i]) ? current : next);
      }
    }
    function update() {
      clearTimeout(settle);
      if (blocked || reduced.matches || document.hidden) apply();
      else settle = setTimeout(apply, SCROLL_SETTLE_MS);
    }
    function resize() { clearTimeout(settle); apply(); }

    document.addEventListener("visibilitychange", update);
    reduced.addEventListener("change", update);
    mobile.addEventListener("change", resize);
    return {
      update, apply,
      disconnect() {
        clearTimeout(settle);
        document.removeEventListener("visibilitychange", update);
        reduced.removeEventListener("change", update);
        mobile.removeEventListener("change", resize);
      },
    };
  }, []);

  return [live, observeBudget] as const;
}
