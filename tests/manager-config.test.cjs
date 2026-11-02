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

test("exports customized deployment settings and additional native env files", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manager-settings-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const name of ["source", "dest"]) {
    for (const folder of ["native", "cms", "deployment/docker", "deployment/nginx"]) {
      await fs.mkdir(path.join(dir, name, folder), { recursive: true });
    }
  }
  const slots = ["native/manager.env", "cms/.env", "deployment/docker/.env.production.local", "deployment/nginx/blog-routes.conf"];
  for (const slot of slots) await fs.writeFile(path.join(dir, "source", slot), slot);
  await fs.writeFile(path.join(dir, "source/native/private.key"), "excluded");
  const transfer = server => createConfigTransfer(path.join(dir, server), path.join(dir, server, "native"));
  const archive = await transfer("source").exportConfig("backup fixture password");
  const restored = await transfer("dest").importConfig("backup fixture password", archive);
  assert.equal(restored.length, slots.length);
  for (const slot of slots) assert.equal(await fs.readFile(path.join(dir, "dest", slot), "utf8"), slot);
});
