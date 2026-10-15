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
    // Minimum height of the desktop canvas holding the profile and collection
    // cards. The action dock sits below it in normal flow, and the canvas grows
    // if the profile card needs more room, so widgets cannot overlap the dock.
    minHeight: "clamp(520px, 66dvh, 640px)",
  },
  widgets: {
    // Main profile card. On desktop it is centred in the canvas and sized by its
    // content, so x/y/dx/dy are only used by layouts that free-position it.
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
