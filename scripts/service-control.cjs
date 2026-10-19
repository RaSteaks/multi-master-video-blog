const manager = require("./manager-dashboard.cjs");

async function main() {
  const [id, action = "status"] = process.argv.slice(2);
  if (id === "processes") {
    const ids = process.argv.slice(4);
    if (!["start", "stop"].includes(action) || !ids.length || ids.some(id => manager.serviceMap.get(id)?.kind !== "process")) {
      throw new Error("Expected processes start|stop followed by process service IDs.");
    }
    return manager.withOperation("processes:" + action, () => manager.runStackActions(ids, action));
  }
  if (id === "stack") {
    if (["status", "health"].includes(action)) {
      const status = await manager.allStatus();
      if (action === "health" && status.services.some(service => !service.healthy)) {
        throw new Error(status.services.filter(service => !service.healthy).map(service => service.name + ": " + (service.error || "not healthy")).join("; "));
      }
      return status;
    }
    return manager.withOperation(action, () => manager.handleStackAction(action));
  }
  const service = manager.serviceMap.get(id);
  if (!service) throw new Error("Unknown service: " + id);
  if (action === "status") {
    return manager.getServiceStatus(service, await manager.getDatabaseStatus());
  }
  if (action === "health") {
    if (service.kind === "process") await manager.waitForProcessHealth(service);
    else {
      // Windows service state alone does not prove that the configured DB works.
      const status = await manager.getServiceStatus(service, await manager.getDatabaseStatus());
      if (!status.healthy) throw new Error(service.name + ": " + (status.error || "not healthy"));
    }
    return { message: service.name + " is healthy." };
  }
  return manager.withOperation(id + ":" + action, () => manager.handleAction(id, action));
}

main().then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  // Keep partial stack outcomes visible to the same operators who use the UI.
  if (error.results?.length) console.error(JSON.stringify({ results: error.results }, null, 2));
  console.error(manager.cleanPowerShellError(error));
  process.exitCode = 1;
});
