/** Bound expensive work across requests; queued callers own no processing slot yet. */
function createTaskLimiter({ concurrency = 1, maxPending = 4, waitMs = 60000 } = {}) {
  let active = 0;
  const pending = [];
  const busy = () => Object.assign(new Error("Video processing is busy. Please retry later."), { statusCode: 503 });

  function grant(resolve) {
    active++;
    let released = false;
    resolve(() => {
      // Cleanup paths may overlap; a slot must only be returned once.
      if (released) return;
      released = true;
      active--;
      const next = pending.shift();
      if (next) {
        clearTimeout(next.timer);
        grant(next.resolve);
      }
    });
  }

  return {
    acquire() {
      return new Promise((resolve, reject) => {
        if (active < concurrency) return grant(resolve);
        if (pending.length >= maxPending) return reject(busy());
        const entry = { resolve, timer: null };
        entry.timer = setTimeout(() => {
          pending.splice(pending.indexOf(entry), 1);
          reject(busy());
        }, waitMs);
        pending.push(entry);
      });
    }
  };
}

module.exports = { createTaskLimiter };
