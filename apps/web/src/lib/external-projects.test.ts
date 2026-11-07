import { describe, expect, it } from "vitest";
import { groupWebsiteProjects, isWebsiteUrl, readProjectList, readSavedLayout, readWebsiteProject } from "./external-projects";
import { readProjectLayout } from "../../../../shared/project-layouts.cjs";

const row = { id: 1, title: "黑洞", url: "https://example.com/", preview_enabled: 1, published: 0, open_mode: "iframe" };
describe("website response boundary", () => {
  it("normalizes nullable CMS fields and SQLite boolean values", () => {
    expect(readWebsiteProject(row)).toEqual({ ...row, description: "", group_name: "", cover_image: null, preview_url: null, sort_order: 0, preview_enabled: true, published: false });
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
    expect(() => readWebsiteProject({ ...row, group_name: ["invalid"] })).toThrow();
    expect(() => readWebsiteProject({ ...row, group_name: "x".repeat(61) })).toThrow();
  });
  it("groups by normalized author labels and first occurrence, including ungrouped rows", () => {
    const projects = [" 光与颜色 ", "", "影像", "光与颜色", "其他作品"].map((group_name, index) => readWebsiteProject({ ...row, id: index + 1, group_name }));
    expect(groupWebsiteProjects(projects).map(group => [group.name, group.projects.map(project => project.id)]))
      .toEqual([["光与颜色", [1, 4]], ["其他作品", [2, 5]], ["影像", [3]]]);
    expect(groupWebsiteProjects([])).toEqual([]);
  });
  it("defaults only missing CMS choices and requires confirmation of a layout save", () => {
    expect(readProjectLayout(null)).toBe("grid");
    expect(readSavedLayout({ layout: "catalogue" })).toBe("catalogue");
    for (const layout of ["", "unknown", 1, {}, null]) {
      expect(() => readSavedLayout({ layout })).toThrow();
    }
    expect(() => readProjectLayout("unknown")).toThrow();
  });
});
