"use client";

import dynamic from "next/dynamic";
import type { SiteBackgroundImage } from "@/lib/directus";

const AppearanceControl = dynamic(
  () =>
    import("./AppearanceControl").then((module) => module.AppearanceControl),
  { ssr: false },
);

export function BackgroundControl({
  images,
  defaultBlur = 8,
  siteAccentColor,
}: {
  images: SiteBackgroundImage[];
  defaultBlur?: number;
  siteAccentColor?: string;
}) {
  return (
    <AppearanceControl
      images={images}
      defaultBlur={defaultBlur}
      siteAccentColor={siteAccentColor}
    />
  );
}
