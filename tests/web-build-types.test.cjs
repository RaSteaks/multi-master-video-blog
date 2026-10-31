const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const web = path.resolve(__dirname, "../apps/web");
const tsc = require.resolve("typescript/bin/tsc");

async function tsconfigPath(nodeEnv, override = "") {
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", `
    const config = await import(process.argv[1]);
    console.log(JSON.stringify(config.default.typescript.tsconfigPath));
  `, pathToFileURL(path.join(web, "next.config.mjs")).href], {
    env: { ...process.env, NODE_ENV: nodeEnv, NEXT_TSCONFIG_PATH: override }
  });
  return JSON.parse(stdout);
}

for (const [nodeEnv, override, expected] of [
  ["production", "", "tsconfig.build.json"],
  ["development", "", "tsconfig.json"],
  ["production", "fixture/tsconfig.json", "fixture/tsconfig.json"]
]) {
  test(`Web TypeScript config: ${nodeEnv}, ${override || "default"}`, async () => {
    assert.equal(await tsconfigPath(nodeEnv, override), expected);
  });
}

test("production ignores stale dev validators while checking source and production routes", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blog-web-build-types-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await Promise.all(["src", ".next/types", ".next/dev/types"].map(name =>
    fs.mkdir(path.join(dir, name), { recursive: true })
  ));
  const source = path.join(dir, "src/page.ts");
  const productionValidator = path.join(dir, ".next/types/validator.ts");
  const validSource = 'export const title: string = "Fixture";\n';
  await Promise.all([
    fs.copyFile(path.join(web, "tsconfig.json"), path.join(dir, "tsconfig.json")),
    fs.copyFile(path.join(web, "tsconfig.build.json"), path.join(dir, "tsconfig.build.json")),
    fs.writeFile(source, validSource),
    fs.writeFile(productionValidator, "export {};\n"),
    // Model a validator left by next dev before the albums layout was deleted.
    fs.writeFile(path.join(dir, ".next/dev/types/validator.ts"),
      'export type RemovedLayout = typeof import("../../../src/app/albums/layout.js");\n')
  ]);
  const check = config => exec(process.execPath, [tsc, "--project", path.join(dir, config),
    "--incremental", "false", "--pretty", "false"], { cwd: dir });
  const productionConfig = await tsconfigPath("production");

  await check(productionConfig);
  await assert.rejects(check("tsconfig.json"), error => {
    assert.equal(error.code, 2);
    assert.match(error.stdout, /validator\.ts.*error TS2307/);
    return true;
  });

  await fs.writeFile(source, "export const title: string = 42;\n");
  await assert.rejects(check(productionConfig), error => {
    assert.equal(error.code, 2);
    assert.match(error.stdout, /page\.ts.*error TS2322/);
    return true;
  });

  await fs.writeFile(source, validSource);
  await fs.writeFile(productionValidator, 'export const layout: never = "invalid layout";\n');
  await assert.rejects(check(productionConfig), error => {
    assert.equal(error.code, 2);
    assert.match(error.stdout, /validator\.ts.*error TS2322/);
    return true;
  });
});
