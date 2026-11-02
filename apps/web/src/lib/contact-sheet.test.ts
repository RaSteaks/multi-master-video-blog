import { describe, expect, it } from "vitest";
import { contactFrames, type ContactWork } from "./contact-sheet";

const work = (key: string, addedAt: string | null): ContactWork =>
  ({ key, title: key, href: `/${key}`, external: false, cover: null, addedAt });

describe("contactFrames", () => {
  it("gives each frame its added date as MM-DD", () => {
    const frames = contactFrames([work("a", "2026-11-02T02:29:01"), work("b", "2026-01-09T23:59:59Z")]);
    expect(frames.map(frame => frame.addedOn)).toEqual(["01-09", "11-02"]);
  });

  it("leaves undated works without a date", () => {
    expect(contactFrames([work("a", null), work("b", "not a date")]).map(frame => frame.addedOn)).toEqual([null, null]);
  });

  it("runs from the oldest work to the newest across collections", () => {
    const frames = contactFrames([
      work("post-1", "2026-04-01T00:00:00Z"),
      work("video-1", "2026-01-01T00:00:00Z"),
      work("album-1", "2026-03-01T00:00:00Z"),
      work("project-1", "2026-02-01T00:00:00Z"),
    ]);
    expect(frames.map(frame => frame.key)).toEqual(["video-1", "project-1", "album-1", "post-1"]);
  });

  it("adds a new work at the end", () => {
    const frames = contactFrames([work("c", "2026-03-01"), work("a", "2026-01-01"), work("b", "2026-02-01")]);
    expect(frames.at(-1)).toMatchObject({ key: "c" });
  });

  it("keeps undated or unreadable works, before every dated one", () => {
    const frames = contactFrames([work("a", null), work("b", "not a date"), work("c", "2020-01-01")]);
    expect(frames.map(frame => frame.key)).toEqual(["a", "b", "c"]);
  });
});
