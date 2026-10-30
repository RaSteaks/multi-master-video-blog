import { AuthorSessionError, authorHeaders, observeAuthorResponse } from "./author-session";

export type UploadFile = {
  field: string; name: string; size: number; type: string; fingerprint: string; offset: number;
};
export type VideoUploadSession<T = unknown> = {
  id: string;
  state: "receiving" | "queued" | "processing" | "completed" | "failed" | "interrupted" | "canceled";
  phase: string;
  expiresAt: number;
  chunkBytes: number;
  fields: Record<string, string>;
  files: UploadFile[];
  result: T | null;
  error: string | null;
};
export type UploadProgress = {
  confirmed: number; total: number; bytesPerSecond: number; fileName: string;
  activity: "verifying" | "uploading" | "retrying";
};
export class VideoUploadError extends Error {
  constructor(message: string, public status = 0, public retryAfter = 0) { super(message); }
}
const base = "/api/uploads/video-sessions";
export const VIDEO_UPLOAD_STORAGE_KEY = "video-upload-session-v1";

// The ID alone is not authorization. Never persist tokens or video bytes in browser storage.
export function rememberVideoUpload(id: string | null) {
  try {
    if (id) localStorage.setItem(VIDEO_UPLOAD_STORAGE_KEY, id);
    else localStorage.removeItem(VIDEO_UPLOAD_STORAGE_KEY);
    return true;
  } catch { return false; }
}
export function rememberedVideoUpload() {
  try {
    const value = localStorage.getItem(VIDEO_UPLOAD_STORAGE_KEY);
    return value && /^[a-f0-9-]{36}$/i.test(value) ? value : null;
  } catch { return null; }
}

export async function uploadRequest<T>(id: string, token: string, signal: AbortSignal,
  method = "GET", suffix = "", body?: unknown): Promise<T> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(`${base}/${id}${suffix}`, {
      method, headers: { ...authorHeaders(token), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AuthorSessionError) throw new VideoUploadError(error.message, error.status);
    throw new VideoUploadError(error instanceof Error ? error.message : "Network error");
  }
  const payload = await response.json().catch(() => null);
  observeAuthorResponse(response.status, token);
  if (!response.ok) throw new VideoUploadError(payload?.error || `HTTP ${response.status}`, response.status,
    Math.min(60_000, Math.max(0, Number(response.headers.get("retry-after")) || 0) * 1000));
  if (!payload) throw new VideoUploadError("Invalid upload response", 502);
  return payload as T;
}

async function sha256(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function fingerprint(file: File) {
  // Quick selection identity; confirmed prefix checks below also verify every resumed byte.
  return sha256(new Blob([String(file.size), file.slice(0, 65536), file.slice(Math.max(0, file.size - 65536))]));
}

export async function uploadManifest(form: FormData, signal: AbortSignal) {
  const fields: Record<string, string> = {};
  const files: Omit<UploadFile, "offset">[] = [];
  const sources: File[] = [];
  for (const [field, value] of form.entries()) {
    signal.throwIfAborted();
    if (typeof value === "string") fields[field] = value;
    else {
      files.push({ field, name: value.name, size: value.size, type: value.type, fingerprint: await fingerprint(value) });
      sources.push(value);
    }
  }
  return { body: { fields, files }, sources };
}

export async function matchUploadFiles(files: UploadFile[], selected: File[], signal: AbortSignal) {
  const candidates = [...selected];
  const result: File[] = [];
  for (const file of files) {
    signal.throwIfAborted();
    let index = -1;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const name = candidate.webkitRelativePath || candidate.name;
      if (candidate.size === file.size && name === file.name && await fingerprint(candidate) === file.fingerprint) {
        index = i; break;
      }
    }
    if (index < 0) throw new VideoUploadError(`请选择原文件 / Select the original file: ${file.name}`, 400);
    result.push(candidates.splice(index, 1)[0]);
  }
  return result;
}

export function uploadDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
const retryable = (error: unknown) => error instanceof VideoUploadError &&
  [0, 408, 409, 429, 500, 502, 503, 504].includes(error.status);

function sendChunk(id: string, index: number, offset: number, chunk: Blob, checksum: string,
  token: string, signal: AbortSignal, onBytes: (bytes: number) => void) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const abort = () => { xhr.abort(); reject(signal.reason); };
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    xhr.open("PATCH", `${base}/${id}/files/${index}`);
    for (const [name, value] of Object.entries(authorHeaders(token))) xhr.setRequestHeader(name, value);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Upload-Offset", String(offset));
    xhr.setRequestHeader("Upload-Checksum", checksum);
    // Per-chunk deadline supports very slow links without an unlimited hung request.
    xhr.timeout = 300_000;
    xhr.upload.onprogress = event => onBytes(event.loaded);
    xhr.onload = () => {
      observeAuthorResponse(xhr.status, token);
      let payload;
      try { payload = JSON.parse(xhr.responseText); } catch { /* Report invalid responses as retryable. */ }
      if (xhr.status >= 200 && xhr.status < 300 && payload?.offset === offset + chunk.size) finish();
      else finish(new VideoUploadError(payload?.error || `HTTP ${xhr.status}`,
        xhr.status >= 200 && xhr.status < 300 ? 502 : xhr.status || 502,
        Math.min(60_000, Number(xhr.getResponseHeader("retry-after") || 0) * 1000)));
    };
    xhr.onerror = () => finish(new VideoUploadError("Network error"));
    xhr.ontimeout = () => finish(new VideoUploadError("Upload timed out", 408));
    xhr.onabort = () => finish(new DOMException("Upload paused", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(chunk);
  });
}

/** Sequential 1 MiB chunks bound memory and contention; retries always reconcile server receipts. */
export async function transferVideoUpload<T>(initial: VideoUploadSession<T>, sources: File[],
  token: string, signal: AbortSignal, onProgress: (progress: UploadProgress) => void) {
  const session = initial;
  const total = session.files.reduce((sum, file) => sum + file.size, 0);
  let confirmed = session.files.reduce((sum, file) => sum + file.offset, 0);
  for (let index = 0; index < session.files.length; index++) {
    const source = sources[index], file = session.files[index];
    if (!source) throw new VideoUploadError(`Missing original file: ${file.name}`, 400);
    let verified = 0, attempts = 0, reconcile = true;
    while (true) {
      signal.throwIfAborted();
      try {
        // Validate all confirmed prefix hashes on re-selection, including same-name changed files.
        if (reconcile) {
          const receipt = await uploadRequest<{ offset: number; chunks: string[]; chunkBytes: number }>(
            session.id, token, signal, "GET", `/files/${index}`);
          if (receipt.offset < verified) throw new VideoUploadError("Server upload offset moved backwards", 409);
          while (verified < receipt.offset) {
            signal.throwIfAborted();
            onProgress({ confirmed, total, bytesPerSecond: 0, fileName: file.name, activity: "verifying" });
            const end = Math.min(verified + receipt.chunkBytes, source.size);
            if (await sha256(source.slice(verified, end)) !== receipt.chunks[Math.floor(verified / receipt.chunkBytes)]) {
              throw new VideoUploadError(`文件内容已改变 / File contents changed: ${file.name}`, 422);
            }
            verified = end;
          }
          confirmed += receipt.offset - file.offset; file.offset = receipt.offset;
          reconcile = false;
        }
        if (file.offset === file.size) break;
        const chunk = source.slice(file.offset, Math.min(file.size, file.offset + session.chunkBytes));
        const checksum = await sha256(chunk), started = performance.now();
        await sendChunk(session.id, index, file.offset, chunk, checksum, token, signal, bytes => {
          onProgress({ confirmed, total, bytesPerSecond: bytes / Math.max(0.1, (performance.now() - started) / 1000),
            fileName: file.name, activity: "uploading" });
        });
        confirmed += chunk.size; file.offset += chunk.size; verified = file.offset; attempts = 0;
        onProgress({ confirmed, total, bytesPerSecond: chunk.size / Math.max(0.1, (performance.now() - started) / 1000),
          fileName: file.name, activity: "uploading" });
      } catch (error) {
        signal.throwIfAborted();
        if (!retryable(error) || attempts++ >= 5) throw error;
        reconcile = true;
        onProgress({ confirmed, total, bytesPerSecond: 0, fileName: file.name, activity: "retrying" });
        await uploadDelay(Math.max((error as VideoUploadError).retryAfter,
          Math.min(30_000, 1000 * 2 ** (attempts - 1)) + Math.random() * 400), signal);
      }
    }
  }
  // Completing a session is idempotent, including a lost 202 response.
  for (let attempt = 0; ; attempt++) {
    try { return await uploadRequest<VideoUploadSession<T>>(session.id, token, signal, "POST", "/complete"); }
    catch (error) {
      signal.throwIfAborted();
      if (!retryable(error) || attempt >= 5) throw error;
      await uploadDelay(Math.min(30_000, 1000 * 2 ** attempt), signal);
    }
  }
}
