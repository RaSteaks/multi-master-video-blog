export type HomeWidgetLayout = {
  // Desktop position inside .orbital-stage. Percent values are relative to the stage.
  x: string;
  y: string;
  // Desktop size. Omit a value to let the component keep its natural size.
  w?: string;
  h?: string;
  // Optional size clamps for long text, translated content, or responsive bounds.
  minW?: string;
  maxW?: string;
  minH?: string;
  maxH?: string;
  // Optional visual offset after left/top placement. Use dx="-50%" to center on x.
  dx?: string;
  dy?: string;
  // Optional per-widget visual tuning. Shared colors/shadows still live in globals.css.
  padding?: string;
  fontSize?: string;
  radius?: string;
  gap?: string;
  // Higher values render above lower values when free-positioned widgets overlap.
  zIndex?: number;
};

// Homepage free-positioning config.
// Desktop uses these coordinates and dimensions through CSS variables.
// Tablet/mobile ignore absolute coordinates and fall back to the flow layout in globals.css.
export const homeLayout = {
  stage: {
    // Desktop positioning canvas height. Increase this if lower widgets need more room.
    minHeight: "clamp(640px, 78dvh, 760px)",
  },
  widgets: {
    // Main profile card. dx/dy center the card around the configured x/y point.
    profileHub: {
      x: "50%",
      y: "50%",
      w: "430px",
      maxW: "min(430px, 100%)",
      dx: "-50%",
      dy: "-50%",
      padding: "34px 30px",
      radius: "32px",
      zIndex: 2,
    },
    // Collection card shown to the left of the profile card on desktop.
    collection: {
      x: "1%",
      y: "35%",
      w: "280px",
      padding: "18px",
      radius: "24px",
      zIndex: 1,
    },
  },
} satisfies {
  stage: { minHeight: string };
  widgets: Record<string, HomeWidgetLayout>;
};
