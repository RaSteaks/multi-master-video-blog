import { afterEach, describe, expect, it, vi } from "vitest";
import { authorTaskHref, dismissAuthorTask, type AuthorTask } from "./author-tasks";

const task = (id: string, kind: AuthorTask["kind"]): AuthorTask => ({ id, kind, label: "任务", state: "failed", progress: null });

describe("author task links", () => {
  it("opens a failed video at its upload session", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(authorTaskHref(task(`video:${id}`, "video"))).toBe(`/upload?session=${id}`);
  });

  it("has no destination for film jobs", () => {
    expect(authorTaskHref(task("film:1", "film"))).toBeNull();
  });
});

describe("dismissing author tasks", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubStorage(initial?: string) {
    const values = new Map(initial === undefined ? [] : [["author-tasks-dismissed-v1", initial]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    });
    return () => JSON.parse(values.get("author-tasks-dismissed-v1") || "[]") as string[];
  }

  it("keeps a bounded list without duplicates", () => {
    const stored = stubStorage(JSON.stringify(Array.from({ length: 32 }, (_, index) => `video:${index}`)));
    dismissAuthorTask("video:31");
    expect(stored()).toHaveLength(32);
    dismissAuthorTask("video:new");
    expect(stored()).toHaveLength(32);
    expect(stored().at(-1)).toBe("video:new");
  });

  it("recovers from a corrupt list", () => {
    const stored = stubStorage("{");
    dismissAuthorTask("video:a");
    expect(stored()).toEqual(["video:a"]);
  });

  it("does not throw when storage is unavailable", () => {
    vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
    expect(() => dismissAuthorTask("video:a")).not.toThrow();
  });
});
