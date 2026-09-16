/** Serialize preview writes and suppress callbacks from superseded requests. */
export function createFilmPreviewScheduler() {
  let revision = 0;
  let pending: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule<T>(options: {
      render: () => Promise<T>;
      onStart: () => void;
      onSuccess: (result: T) => void;
      onError: () => void;
    }, delay = 520) {
      const request = ++revision;
      clearTimeout(timer);
      timer = setTimeout(() => {
        // The server writes a shared file. Wait for an in-flight render before
        // sending its replacement, even when restoring saved adjustments.
        pending = pending.catch(() => {}).then(async () => {
          if (request !== revision) return;
          options.onStart();
          try {
            const result = await options.render();
            if (request === revision) options.onSuccess(result);
          } catch {
            if (request === revision) options.onError();
          }
        });
      }, delay);
      return () => {
        if (request !== revision) return;
        ++revision;
        clearTimeout(timer);
      };
    },
  };
}
