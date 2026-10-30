"use client";

import { useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { fetchAssetPreview, isAssetPreviewUrl } from "@/lib/asset-preview";
import { useAuthorSession } from "@/lib/author-session";

/** Draft images use in-memory blob URLs; credentials never enter img URLs or storage. */
export function AuthenticatedAssetImage({ token, src, srcSet, loading, ...props }:
  ComponentPropsWithoutRef<"img"> & { token?: string }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const author = useAuthorSession();
  // Undefined means public; an empty explicit token uses the current session.
  const protectedRequest = token !== undefined && isAssetPreviewUrl(src);
  // Revisiting the same token/URL after another request must not reuse a revoked blob.
  const requestKey = useMemo(() => ({}), [src, token, author.author ? author.csrf : null]);
  const [visibleRequest, setVisibleRequest] = useState<object | null>(null);
  const ready = visibleRequest === requestKey;
  const shouldLoad = loading !== "lazy" || ready;
  const [preview, setPreview] = useState<{ key: object; url: string } | null>(null);
  useEffect(() => {
    if (!protectedRequest || ready) return;
    if (loading !== "lazy" || typeof IntersectionObserver === "undefined" || !imageRef.current) {
      setVisibleRequest(requestKey);
      return;
    }
    // Native img lazy loading only sees the final blob URL; defer the authenticated fetch itself.
    let canceled = false;
    const observer = new IntersectionObserver(entries => {
      if (!canceled && entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        setVisibleRequest(requestKey);
      }
    });
    observer.observe(imageRef.current);
    return () => { canceled = true; observer.disconnect(); };
  }, [loading, protectedRequest, ready, requestKey]);

  useEffect(() => {
    if (!protectedRequest || !shouldLoad || !src || token === undefined) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    fetchAssetPreview(src, token, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setPreview({ key: requestKey, url: objectUrl });
    }).catch(() => {
      // Preserve the caller's img onError/HDR fallback without retrying anonymously.
      if (!controller.signal.aborted) setPreview({ key: requestKey, url: "data:," });
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [protectedRequest, requestKey, shouldLoad, src, token]);

  const current = preview?.key === requestKey ? preview.url : undefined;
  // A protected srcset would cause unauthenticated browser requests; public srcsets stay intact.
  return <img {...props} ref={imageRef} loading={loading} src={protectedRequest ? current : src}
    srcSet={protectedRequest ? undefined : srcSet} />;
}
