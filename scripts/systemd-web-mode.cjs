const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// The Manager checkout and the active release can be different directories.
const MODE_FILE = "/var/lib/video-blog/manager/web-mode";

function readWebMode(filename = MODE_FILE) {
  let mode;
  try {
    mode = fs.readFileSync(filename, "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") return "production"; // Existing native releases run production.
    throw error;
  }
  if (mode !== "production" && mode !== "development") throw new Error("Invalid Web mode in " + filename);
  return mode;
}

async function writeWebMode(filename, mode) {
  const temporary = path.join(path.dirname(filename), ".web-mode-" + randomUUID());
  try {
    await fs.promises.writeFile(temporary, mode + "\n", { flag: "wx", mode: 0o644 });
    // The Manager and Web service can use different accounts and a restrictive umask.
    await fs.promises.chmod(temporary, 0o644);
    await fs.promises.rename(temporary, filename);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

module.exports = { MODE_FILE, readWebMode, writeWebMode };
