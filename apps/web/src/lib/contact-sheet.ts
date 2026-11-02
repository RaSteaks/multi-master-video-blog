import type { WebsitePreview } from "./external-projects";

/** One frame of the home contact strip. */
export type ContactFrame = {
  key: string;
  title: string;
  href: string;
  external: boolean;
  cover: string | null;
  addedOn: string | null;
  // A laboratory site with no cover may show itself live instead.
  preview?: WebsitePreview;
  // The destination opens on this same picture, so it can fly there.
  morphsCover?: boolean;
};

export type ContactWork = Omit<ContactFrame, "addedOn"> & { addedAt: string | null };

function addedTime(work: ContactWork) {
  const time = work.addedAt ? Date.parse(work.addedAt) : Number.NaN;
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** MM-DD as the CMS stored it: its dates are wall-clock time, so a time zone could only move the day. */
function addedOn(addedAt: string | null) {
  return addedAt?.match(/^\d{4}-(\d{2}-\d{2})/)?.[1] ?? null;
}

/** Oldest first, so the strip reads left to right and a new work joins at the right. */
export function contactFrames(works: ContactWork[]): ContactFrame[] {
  const oldestFirst = [...works].sort((left, right) => {
    const difference = addedTime(left) - addedTime(right);
    return Number.isNaN(difference) || difference === 0 ? left.key.localeCompare(right.key) : difference;
  });
  return oldestFirst.map(({ addedAt, ...work }) => ({ ...work, addedOn: addedOn(addedAt) }));
}
