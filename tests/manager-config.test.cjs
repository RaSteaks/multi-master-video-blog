const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createConfigTransfer } = require("../scripts/manager-config.cjs");

test("restore stages all files before changing any destination", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-transfer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), target = path.join(root, "target");
  for (const dir of [source, target]) await fs.mkdir(path.join(dir, "docker-system"), { recursive: true });
  const paths = [".env", "deployment/docker/runtime.env", "docker-system/cms.env"];
  for (const name of paths) {
    const file = path.join(source, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "key=" + name + "\r\n");
  }
  const transfer = dir => createConfigTransfer(dir, path.join(dir, "docker-system"));
  const password = "example backup password";
  const archive = await transfer(source).exportConfig(password);
  await fs.writeFile(path.join(target, ".env"), "existing");
  await assert.rejects(transfer(target).importConfig(password, archive), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(target, ".env"), "utf8"), "existing");
  await fs.mkdir(path.join(target, "deployment/docker"), { recursive: true });
  await transfer(target).importConfig(password, archive);
  for (const name of paths) assert.deepEqual(await fs.readFile(path.join(source, name)), await fs.readFile(path.join(target, name)));
});
