import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFilmPreviewScheduler } from "./film-preview";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function request(render: () => Promise<string>) {
  return { render: vi.fn(render), onStart: vi.fn(), onSuccess: vi.fn(), onError: vi.fn() };
}

it("restores saved values after an in-flight draft without publishing the stale result", async () => {
  const scheduler = createFilmPreviewScheduler();
  const draft = deferred();
  const old = request(() => draft.promise);
  const cancel = scheduler.schedule(old);
  await vi.advanceTimersByTimeAsync(520);
  cancel();
  const saved = request(async () => "saved");
  scheduler.schedule(saved);
  await vi.advanceTimersByTimeAsync(520);
  expect(saved.render).not.toHaveBeenCalled();
  draft.resolve("draft");
  await vi.advanceTimersByTimeAsync(0);
  expect(old.onSuccess).not.toHaveBeenCalled();
  expect(saved.onSuccess).toHaveBeenCalledWith("saved");
});

it("coalesces slider changes and skips superseded queued renders", async () => {
  const scheduler = createFilmPreviewScheduler();
  const first = deferred();
  const a = request(() => first.promise);
  scheduler.schedule(a);
  await vi.advanceTimersByTimeAsync(520);
  const b = request(async () => "b");
  scheduler.schedule(b);
  await vi.advanceTimersByTimeAsync(520);
  const c = request(async () => "c");
  scheduler.schedule(c);
  await vi.advanceTimersByTimeAsync(520);
  first.resolve("a");
  await vi.advanceTimersByTimeAsync(0);
  expect(b.render).not.toHaveBeenCalled();
  expect(a.onSuccess).not.toHaveBeenCalled();
  expect(c.onSuccess).toHaveBeenCalledWith("c");
});

it("suppresses errors from canceled renders and still runs the replacement", async () => {
  const scheduler = createFilmPreviewScheduler();
  const oldResult = deferred();
  const old = request(() => oldResult.promise);
  const cancel = scheduler.schedule(old);
  await vi.advanceTimersByTimeAsync(520);
  cancel();
  const next = request(async () => "next");
  scheduler.schedule(next);
  await vi.advanceTimersByTimeAsync(520);
  oldResult.reject(new Error("old request failed"));
  await vi.advanceTimersByTimeAsync(0);
  expect(old.onError).not.toHaveBeenCalled();
  expect(next.onSuccess).toHaveBeenCalledWith("next");
});

it("cancels a waiting preview on cleanup", async () => {
  const scheduler = createFilmPreviewScheduler();
  const pending = request(async () => "unused");
  scheduler.schedule(pending)();
  await vi.advanceTimersByTimeAsync(520);
  expect(pending.render).not.toHaveBeenCalled();
});

it("reports current errors and permits a later retry", async () => {
  const scheduler = createFilmPreviewScheduler();
  const failed = request(async () => { throw new Error("failure"); });
  scheduler.schedule(failed);
  await vi.advanceTimersByTimeAsync(520);
  expect(failed.onError).toHaveBeenCalledOnce();
  const retry = request(async () => "recovered");
  scheduler.schedule(retry);
  await vi.advanceTimersByTimeAsync(520);
  expect(retry.onSuccess).toHaveBeenCalledWith("recovered");
});
