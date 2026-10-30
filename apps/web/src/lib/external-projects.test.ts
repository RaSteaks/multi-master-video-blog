import { describe, expect, it } from "vitest";
import { isWebsiteUrl, readProjectList, readWebsiteProject } from "./external-projects";

const row = { id: 1, title: "黑洞", url: "https://example.com/", preview_enabled: 1, published: 0, open_mode: "iframe" };
describe("website response boundary", () => {
  it("normalizes nullable CMS fields and SQLite boolean values", () => {
    expect(readWebsiteProject(row)).toEqual({ ...row, description: "", cover_image: null, preview_url: null, sort_order: 0, preview_enabled: true, published: false });
    expect(readProjectList({ projects: [row], hasMore: true }).hasMore).toBe(true);
  });
  it("rejects unsafe URLs and malformed CMS records", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,test", "/relative", "https://user:password@example.com/", "http://example.com/"]) {
      expect(isWebsiteUrl(url)).toBe(false);
      expect(() => readWebsiteProject({ ...row, url })).toThrow();
    }
    expect(() => readWebsiteProject({ ...row, preview_url: "javascript:alert(1)" })).toThrow();
    expect(() => readWebsiteProject({ ...row, published: "false" })).toThrow();
    expect(() => readProjectList({ projects: null, hasMore: false })).toThrow();
  });
});
