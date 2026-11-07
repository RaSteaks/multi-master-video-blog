import { describe, expect, it } from "vitest";
import { createAssetPreviewLoader } from "./asset-preview";

function fixture() {
  const calls: Array<{ url: string; options: RequestInit; resolve: (response: Response) => void }> = [];
  let nonce = "session-a";
  const load = createAssetPreviewLoader({
    request: (url, options = {}) => new Promise<Response>((resolve, reject) => {
      calls.push({ url: String(url), options, resolve });
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }),
    headersFor: (token): Record<string, string> => token.trim() ? { Authorization: `Bearer ${token.trim()}` } : { "X-Author-CSRF": nonce },
    observeResponse: () => {},
  });
  return { calls, load, rotateSession: () => { nonce = "session-b"; } };
}

describe("private image request sharing", () => {
  it("shares simultaneous downloads but rechecks authorization on later visits", async () => {
    const f = fixture();
    const first = f.load("/api/assets/a?key=album-thumb", "author", new AbortController().signal);
    const second = f.load("/api/assets/a?key=album-thumb", " author ", new AbortController().signal);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].options).toMatchObject({ cache: "no-store", redirect: "error", headers: { Authorization: "Bearer author" } });
    f.calls[0].resolve(new Response("image"));
    const blobs = await Promise.all([first, second]);
    expect(blobs[0]).toBe(blobs[1]);
    expect(await blobs[0].text()).toBe("image");
    const later = f.load("/api/assets/a?key=album-thumb", "author", new AbortController().signal);
    expect(f.calls).toHaveLength(2);
    f.calls[1].resolve(new Response("replacement"));
    expect(await (await later).text()).toBe("replacement");
  });

  it("isolates tokens, session rotations and image presets", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const requests = [f.load("/api/assets/a", "first", signal), f.load("/api/assets/a", "second", signal),
      f.load("/api/assets/a", "", signal), f.load("/api/assets/a?key=album-thumb", "first", signal)];
    f.rotateSession();
    requests.push(f.load("/api/assets/a", "", signal));
    expect(f.calls).toHaveLength(5);
    f.calls.forEach(call => call.resolve(new Response("image")));
    await Promise.all(requests);
  });

  it("aborts only after the last consumer leaves and permits a fresh retry", async () => {
    const f = fixture();
    const one = new AbortController(), two = new AbortController();
    const first = f.load("/api/assets/a", "author", one.signal);
    const second = f.load("/api/assets/a", "author", two.signal);
    one.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(f.calls[0].options.signal?.aborted).toBe(false);
    two.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(f.calls[0].options.signal?.aborted).toBe(true);
    const retry = f.load("/api/assets/a", "author", new AbortController().signal);
    expect(f.calls).toHaveLength(2);
    f.calls[1].resolve(new Response("retry"));
    expect(await (await retry).text()).toBe("retry");
  });

  it("one canceled consumer does not prevent another from receiving the image", async () => {
    const f = fixture();
    const one = new AbortController();
    const first = f.load("/api/assets/a", "author", one.signal);
    const second = f.load("/api/assets/a", "author", new AbortController().signal);
    one.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    f.calls[0].resolve(new Response("image"));
    expect(await (await second).text()).toBe("image");
  });

  it("does not cache failures or send credentials to an invalid destination", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await expect(f.load("https://other.invalid/api/assets/a", "author", signal)).rejects.toThrow("Invalid asset preview request");
    expect(f.calls).toHaveLength(0);
    const failed = f.load("/api/assets/a", "author", signal);
    f.calls[0].resolve(new Response("denied", { status: 401 }));
    await expect(failed).rejects.toThrow("Asset preview unavailable");
    const retry = f.load("/api/assets/a", "author", signal);
    expect(f.calls).toHaveLength(2);
    f.calls[1].resolve(new Response("allowed"));
    expect(await (await retry).text()).toBe("allowed");
    const aborted = new AbortController();
    aborted.abort();
    await expect(f.load("/api/assets/a", "author", aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.calls).toHaveLength(2);
  });
});
