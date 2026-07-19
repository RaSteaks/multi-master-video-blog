"use client";

type Variant = "accent" | "teal" | "blue" | "gray";

/**
 * Liquid-blob background using compositor-friendly CSS motion and a static
 * SVG turbulence filter. Keeping the turbulence static avoids continuous
 * main-thread SVG filter updates while the blobs still drift naturally.
 *
 * Variants:
 * - `accent` — homepage: selected global accent
 * - `teal`   — upload: fixed neutral grading-room palette
 * - `blue`   — blog: deep navy + indigo + cyan
 * - `gray`   — videos: 18% neutral gray monochrome
 */
export function LiquidBackground({ variant = "accent" }: { variant?: Variant }) {
  return (
    <div className={`liquid-bg liquid-bg--${variant}`} aria-hidden="true">
      {/* Static SVG filter definition; motion comes from the blob wrappers. */}
      <svg xmlns="http://www.w3.org/2000/svg" style={{ position: "absolute", width: 0, height: 0 }}>
        <defs>
          <filter id="liquid-filter" colorInterpolationFilters="sRGB">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.010 0.013"
              numOctaves="3"
              seed="7"
              result="noise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale="150"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>

      {/* Blob layer — filtered for organic liquid edges */}
      <div className="liquid-blobs">
        <div className="blob blob-1" />
        <div className="blob blob-2" />
        <div className="blob blob-3" />
        <div className="blob blob-4" />
        <div className="blob blob-5" />
      </div>

      {/* Grain texture overlay */}
      <div className="liquid-grain" />
    </div>
  );
}
