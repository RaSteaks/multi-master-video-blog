export type ProjectLayout = "grid" | "catalogue" | "mosaic" | "alternating" | "masonry" | "groups" | "dual";
export const PROJECT_LAYOUTS: ReadonlyArray<{ value: ProjectLayout; label: string; description: string }>;
export function isProjectLayout(value: unknown): value is ProjectLayout;
export function readProjectLayout(value: unknown): ProjectLayout;
