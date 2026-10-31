import type { ReactNode } from "react";

/** The inside of a `.content-card`; the caller owns the link or button that carries the card. */
export function MediaCard({ media, meta, title, description, morphTitle }: {
  media: ReactNode;
  meta: string;
  title: string;
  description?: string | null;
  morphTitle?: boolean;
}) {
  return (
    <>
      <div className="content-card-media">{media}</div>
      <div className="content-card-copy">
        <p className="meta-line">{meta}</p>
        <h2 data-vt={morphTitle ? "title" : undefined}>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
    </>
  );
}
