const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const root = path.resolve(__dirname, "../apps/web/src");
const cache = new Map();

// Render the real private component without adding a test-only export to the app.
function load(filename) {
  if (cache.has(filename)) return cache.get(filename);
  let source = fs.readFileSync(filename, "utf8");
  if (filename.endsWith("FilmScanImport.tsx")) source += "\nexport { FilmReview };\n";
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022
  } });
  const module = { exports: {} };
  vm.runInNewContext(outputText, { module, exports: module.exports, require: id => {
    if (id.startsWith("@/")) return load(path.join(root, id.slice(2) + ".ts"));
    return require(id);
  }, setTimeout, clearTimeout }, { filename });
  cache.set(filename, module.exports);
  return module.exports;
}
const { FilmReview } = load(path.join(root, "components/FilmScanImport.tsx"));
function render(status, busy = false, error = "") {
  return renderToStaticMarkup(React.createElement(FilmReview, {
    job: { id: 1, albumId: 1, status, filmStock: "Fixture", process: "c41", scanner: "hasselblad-x5",
      frameFormat: "135-full", progress: 0, frames: [], warnings: [], rollAdjustments: {}, error: "像素限制" },
    token: "", busy, error, publish: false, previewRevision: 0,
    onRefresh: async () => {}, onNew() {}
  }));
}

test("resource-blocked UI preserves originals and offers an accessible refresh action", () => {
  const html = render("resource_blocked");
  assert.match(html, /服务器资源受限，原档已保留/);
  assert.match(html, /role="status"/);
  assert.match(html, /刷新状态/);
  assert.doesNotMatch(html, /服务器原档已清理|重新选择原片/);
  const pending = render("resource_blocked", true);
  assert.match(pending, /disabled="" aria-busy="true"/);
  assert.match(pending, /正在刷新/);
  assert.match(render("resource_blocked", false, "刷新任务状态失败"), /role="alert">刷新任务状态失败/);
});

test("ordinary failed jobs retain their existing failure and re-upload guidance", () => {
  const html = render("failed");
  assert.match(html, /服务器原档已清理/);
  assert.match(html, /重新选择原片/);
  assert.doesNotMatch(html, /原档已保留|刷新状态/);
});
