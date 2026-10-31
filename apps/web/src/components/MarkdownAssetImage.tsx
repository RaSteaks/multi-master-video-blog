"use client";

import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import styles from "./MarkdownAssetImage.module.css";

type ImageState = "static" | "loading" | "loaded" | "error";

/** Progressively enhances the server-rendered image without changing its intrinsic size. */
export function MarkdownAssetImage({ src, srcSet, sizes, width, height, style, className, ...props }:
  ComponentPropsWithoutRef<"img">) {
  const imageRef = useRef<HTMLImageElement>(null);
  // Visible HTML is the fallback when JavaScript is disabled or hydration is delayed.
  const [state, setState] = useState<ImageState>("static");
  const intrinsicWidth = Number(width);
  const intrinsicHeight = Number(height);
  // Preserve known geometry through errors; unknown external dimensions stay natural.
  const aspectRatio = Number.isFinite(intrinsicWidth) && intrinsicWidth > 0
    && Number.isFinite(intrinsicHeight) && intrinsicHeight > 0
    ? `${intrinsicWidth} / ${intrinsicHeight}` : undefined;

  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    let active = true;
    let generation = 0;
    const wasPending = !image.complete;

    const fail = () => {
      generation += 1;
      // Keep the native broken-image/alt fallback visible, including fixed-size images.
      if (active) setState("error");
    };
    const reveal = async () => {
      const currentGeneration = ++generation;
      try {
        await image.decode?.();
      } catch {
        // Some browsers reject decode() for an otherwise successfully loaded image.
        // naturalWidth below distinguishes that case from an actual loading failure.
      }
      if (active && currentGeneration === generation) {
        setState(image.naturalWidth > 0 ? (wasPending ? "loaded" : "static") : "error");
      }
    };

    image.addEventListener("load", reveal);
    image.addEventListener("error", fail);
    // A cached image may finish before hydration attaches load handlers. Never hide
    // or replay a reveal for a picture that the reader can already see.
    // A failed cached request is also complete; retain its reserved error geometry.
    setState(wasPending ? "loading" : image.naturalWidth > 0 ? "static" : "error");

    return () => {
      active = false;
      generation += 1;
      image.removeEventListener("load", reveal);
      image.removeEventListener("error", fail);
    };
  }, [src, srcSet, sizes]);

  return (
    <span className={styles.frame} data-image-state={state}
      data-error-sized={state === "error" && aspectRatio ? "true" : undefined}
      style={state === "error" && aspectRatio ? { width: intrinsicWidth, aspectRatio } : undefined}>
      <img {...props} ref={imageRef} src={src} srcSet={srcSet} sizes={sizes}
        width={width} height={height} style={{ aspectRatio, ...style }}
        className={[styles.image, className].filter(Boolean).join(" ")} />
    </span>
  );
}
