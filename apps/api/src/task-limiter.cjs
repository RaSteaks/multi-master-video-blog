/** FIFO admission with bounded HTTP waiters and one persistent background worker. */
function createTaskLimiter({ concurrency = 1, maxPending = 4, waitMs = 60000 } = {}) {
  let active = 0;
  const pending = [];
  const busy = () => Object.assign(new Error("Media processing is busy. Please retry later."), { statusCode: 503 });

  function grant(resolve) {
    active++;
    let released = false;
    resolve(() => {
      if (released) return;
      released = true;
      active--;
      const next = pending.shift();
      if (next) { next.cleanup(); grant(next.resolve); }
    });
  }

  return {
    snapshot: () => ({ active, pending: pending.length, concurrency, maxPending }),
    acquire({ signal, background = false } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        if (active < concurrency) return grant(resolve);
        // The durable film queue has only one drainer; never expire that worker.
        if (background ? pending.some(entry => entry.background) : pending.filter(entry => !entry.background).length >= maxPending) {
          return reject(busy());
        }
        const remove = error => {
          const index = pending.indexOf(entry);
          if (index < 0) return;
          pending.splice(index, 1); entry.cleanup(); reject(error);
        };
        const abort = () => remove(signal.reason);
        const entry = { resolve, background, timer: null, cleanup() {
          clearTimeout(entry.timer); signal?.removeEventListener("abort", abort);
        } };
        if (!background) entry.timer = setTimeout(() => remove(busy()), waitMs);
        signal?.addEventListener("abort", abort, { once: true });
        pending.push(entry);
      });
    }
  };
}

module.exports = { createTaskLimiter };
