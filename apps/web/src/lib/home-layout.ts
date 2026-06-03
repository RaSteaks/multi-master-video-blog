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

export type HomeMobilePortraitLayout = {
  // Page padding for mobile portrait. svh tracks the visible viewport height better on phones.
  paddingX: string;
  paddingY: string;
  // Minimum page height for short and tall phones.
  minHeight: string;
  // Vertical distance between the main mobile sections.
  stackGap: string;
  // Empty row before the first mobile section. Increase this to move the whole mobile page down.
  topSpacer: string;
  // Distance inside the action button grid.
  actionGap: string;
  // Mobile-only card and button sizing.
  cardRadius: string;
  actionHeight: string;
  maxWidth: string;
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
    // Link to the local upload page.
    uploadBlog: {
      x: "20%",
      y: "80%",
      w: "150px",
      h: "44px",
      padding: "10px 18px",
      radius: "999px",
      fontSize: "0.84rem",
    },
    // Centered external profile link. dx keeps the widget centered on x.
    github: {
      x: "49%",
      y: "80%",
      w: "132px",
      h: "44px",
      dx: "-50%",
      padding: "10px 18px",
      radius: "999px",
      fontSize: "0.84rem",
      gap: "8px",
    },
    // Link to the Directus post editor.
    writePost: {
      x: "66%",
      y: "80%",
      w: "132px",
      h: "44px",
      padding: "10px 18px",
      radius: "999px",
      fontSize: "0.84rem",
    },
  },
  mobilePortrait: {
    paddingX: "clamp(12px, 4vw, 18px)",
    paddingY: "clamp(18px, 4svh, 34px)",
    minHeight: "100svh",
    stackGap: "clamp(12px, 2.4svh, 22px)",
    topSpacer: "clamp(44px, 7svh, 72px)",
    actionGap: "clamp(10px, 2.2vw, 14px)",
    cardRadius: "20px",
    actionHeight: "44px",
    maxWidth: "430px",
  },
} satisfies {
  stage: {
    minHeight: string;
  };
  widgets: Record<string, HomeWidgetLayout>;
  mobilePortrait: HomeMobilePortraitLayout;
};
