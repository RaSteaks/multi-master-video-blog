const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");

function chunks(png) {
  const found = new Map();
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    found.set(png.toString("latin1", offset + 4, offset + 8), png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return found;
}

test("the loading line's HDR ramp is the generated BT.2100 HLG black-to-white signal", () => {
  const css = fs.readFileSync(path.join(root, "apps/web/src/app/globals.css"), "utf8");
  const dataUrl = css.match(/--hlg-ramp: url\("([^"]+)"\)/)?.[1];
  assert.ok(dataUrl, "globals.css defines --hlg-ramp");
  const generated = execFileSync(process.execPath, [path.join(root, "scripts/generate-hlg-ramp.cjs")], { encoding: "utf8" }).trim();
  assert.equal(dataUrl, generated, "Regenerate --hlg-ramp with scripts/generate-hlg-ramp.cjs.");

  const png = chunks(Buffer.from(dataUrl.split(",")[1], "base64"));
  assert.deepEqual([...png.get("cICP")], [9, 18, 0, 1]);
  const row = zlib.inflateSync(png.get("IDAT"));
  assert.equal(row[0], 0, "Unfiltered row");
  assert.equal(row.readUInt16BE(1), 0, "Left end is signal black");
  assert.equal(row.readUInt16BE(row.length - 2), 0xffff, "Right end is peak signal");
});
