import type { ComponentPropsWithoutRef } from "react";
import type { AssetDimensions } from "@/lib/directus";

/** Shared intrinsic sizing for article and About markdown. */
export function markdownImageComponent(dimensions: Map<string, AssetDimensions>) {
  return function MarkdownImage({ src, alt, node: _node, ...props }:
    ComponentPropsWithoutRef<"img"> & { node?: unknown }) {
    // Preset crops must not inherit the original file's aspect ratio.
    const match = typeof src === "string"
      ? src.match(/^\/api\/assets\/([a-zA-Z0-9-]+)$/) : null;
    const size = match ? dimensions.get(match[1]) : undefined;
    return <img {...props} src={src} alt={alt ?? ""}
      width={size?.width ?? props.width} height={size?.height ?? props.height}
      loading="lazy" decoding="async" />;
  };
}
