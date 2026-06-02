"use client";

type Variant = "teal" | "blue" | "gray";

/**
 * Animated liquid-blob background using CSS transforms + SVG turbulence filter.
 *
 * Variants:
 * - `teal`   — homepage:  teal-green + purple + amber
 * - `blue`   — blog:       deep navy + indigo + cyan
 * - `gray`   — videos:     18% neutral gray monochrome
 */
export function LiquidBackground({ variant = "teal" }: { variant?: Variant }) {
  return (
    <div className={`liquid-bg liquid-bg--${variant}`} aria-hidden="true">
      {/* SVG filter definitions — stronger displacement for more visible liquid edges */}
      <svg xmlns="http://www.w3.org/2000/svg" style={{ position: "absolute", width: 0, height: 0 }}>
        <defs>
          <filter id="liquid-filter" colorInterpolationFilters="sRGB">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.010 0.013"
              numOctaves="6"
              seed="7"
              result="noise"
            >
              <animate
                attributeName="baseFrequency"
                values="0.010 0.013; 0.014 0.018; 0.010 0.013"
                dur="22s"
                repeatCount="indefinite"
              />
            </feTurbulence>
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale="260"
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
