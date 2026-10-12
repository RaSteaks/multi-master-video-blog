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
    return manager.withOperation(action, () => manager.handleStackAction(action));
  }
  const service = manager.serviceMap.get(id);
  if (!service) throw new Error("Unknown service: " + id);
  if (action === "status") {
    return manager.getServiceStatus(service, await manager.getDatabaseStatus());
  }
  if (action === "health" && service.kind === "process") {
    await manager.waitForProcessHealth(service);
    return { message: service.name + " is healthy." };
  }
  return manager.withOperation(id + ":" + action, () => manager.handleAction(id, action));
}

main().then((result) => {
  console.log(JSON.stringify(result, null, 2));
}).catch((error) => {
  console.error(manager.cleanPowerShellError(error));
  process.exitCode = 1;
});
