const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const lockfile = require("proper-lockfile");

// One bounded journal is shared by the dashboard and CLI. It contains operation
// outcomes, never request bodies, credentials or arbitrary shell commands.
function createOperationJournal(root) {
  const filename = path.join(root, "logs", "service-operation.json");
  const lockPath = path.join(root, "logs", "service-operation");
  const history = new Map();
  let current = null;
  const snapshot = item => item ? JSON.parse(JSON.stringify(item)) : null;
  async function save() {
    const temporary = filename + "." + process.pid + ".tmp";
    await fs.writeFile(temporary, JSON.stringify(current), { mode: 0o600 });
    await fs.rename(temporary, filename);
  }
  return {
    async begin(label) {
      current = { id: crypto.randomUUID(), label, state: "running", startedAt: new Date().toISOString(), finishedAt: null, steps: [] };
      history.set(current.id, current);
      while (history.size > 12) history.delete(history.keys().next().value);
      await save();
      return snapshot(current);
    },
    async step(serviceId, phase, task) {
      if (!current || current.state !== "running") return task();
      const step = { serviceId, phase, state: "running", startedAt: new Date().toISOString() };
      current.steps.push(step);
      await save();
      try {
        const result = await task();
        step.state = "succeeded";
        step.message = result?.message || "Completed.";
        return result;
      } catch (error) {
        step.state = "failed";
        step.message = String(error.message).slice(0, 4000);
        throw error;
      } finally {
        step.finishedAt = new Date().toISOString();
        await save();
      }
    },
    async finish(error, result) {
      if (!current) return;
      current.state = error ? "failed" : "succeeded";
      current.finishedAt = new Date().toISOString();
      current.message = String(error?.message || result?.message || "Operation completed.").slice(0, 8000);
      current.results = (error?.results || result?.results || []).slice(0, 16).map(item => ({
        serviceId: item.serviceId, action: item.action, ok: Boolean(item.ok),
        message: String(item.message || "").slice(0, 4000)
      }));
      await save();
    },
    async read(id) {
      let item;
      try { item = JSON.parse(await fs.readFile(filename, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (id && item?.id !== id) item = history.get(id);
      const output = snapshot(item);
      if (output?.state === "running" && !await lockfile.check(lockPath, { realpath: false, stale: 120000 })) {
        // A crashed controller cannot leave an eternal spinner or trigger an
        // automatic retry of a command whose effects may already have happened.
        output.state = "interrupted";
        output.message = "The controller stopped before recording a result. Refresh service status before retrying.";
      }
      return output;
    }
  };
}

module.exports = { createOperationJournal };
