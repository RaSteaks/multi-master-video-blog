type Variant = "accent" | "teal" | "blue" | "gray";

/**
 * Liquid-blob background using three compositor-friendly CSS layers. Avoiding
 * a full-screen SVG displacement filter keeps regular page rendering lighter.
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
      {/* Blob layer — filtered for organic liquid edges */}
      <div className="liquid-blobs">
        <div className="blob blob-1" />
        <div className="blob blob-2" />
        <div className="blob blob-3" />
      </div>

      {/* Grain texture overlay */}
      <div className="liquid-grain" />
    </div>
  );
}
