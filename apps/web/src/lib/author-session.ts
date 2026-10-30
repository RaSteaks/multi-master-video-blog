"use client";

import { useEffect, useSyncExternalStore } from "react";

type AuthorSession = { author: true; expiresAt: number; csrf: string; article: boolean } | { author: false };
const guest: AuthorSession = { author: false };
let session: AuthorSession = guest;
const listeners = new Set<() => void>();
let initialized = false;
let device = false;
let channel: BroadcastChannel | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let revision = 0;
let pending: { revision: number; promise: Promise<AuthorSession> } | undefined;

export class AuthorSessionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function hasAuthorHint() {
  return document.cookie.split(";").some(cookie => cookie.trim() === "author_hint=1");
}

function publish(next: AuthorSession) {
  session = next;
  device = document.cookie.split(";").some(cookie => cookie.trim() === "author_device=1");
  clearTimeout(expiryTimer);
  if (next.author) expiryTimer = setTimeout(() => invalidateAuthorSession(), Math.max(0, next.expiresAt - Date.now()));
  listeners.forEach(listener => listener());
}

export function invalidateAuthorSession() {
  revision++;
  document.cookie = `author_hint=; Path=/; SameSite=Strict; Max-Age=0${location.protocol === "https:" ? "; Secure" : ""}`;
  publish(guest);
  channel?.postMessage("changed");
}

// Validate the response at the HTTP boundary; only typed session data enters the store.
function readSession(value: unknown): AuthorSession {
  if (typeof value !== "object" || value === null || !("author" in value)) throw new Error("登录状态响应无效，请重试。");
  if (value.author === false) return guest;
  if (value.author === true && "expiresAt" in value && typeof value.expiresAt === "number"
    && Number.isFinite(value.expiresAt) && "csrf" in value && typeof value.csrf === "string"
    && /^[a-f0-9]{64}$/.test(value.csrf)) return { author: true, expiresAt: value.expiresAt, csrf: value.csrf, article: "article" in value && value.article === true };
  throw new Error("登录状态响应无效，请重试。");
}

async function request(method: string, token?: string, forgetDevice = false) {
  const response = await fetch(`/api/author/session${forgetDevice ? "?forget=1" : ""}`, {
    method, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15_000),
    headers: { ...(token !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method === "DELETE" && session.author ? { "X-Author-CSRF": session.csrf } : {}) },
    body: token !== undefined ? JSON.stringify({ token }) : undefined,
  });
  if (!response.ok) {
    if (method !== "POST" && response.status === 401) invalidateAuthorSession();
    const messages: Record<number, string> = {
      401: method === "POST" ? "令牌不正确，请检查后重试。" : "登录已过期，请重新登录。",
      403: "登录状态已更新，请刷新后重试。",
      429: "尝试次数过多，请稍后再试。",
      503: "作者登录尚未配置或服务暂不可用，请检查 Manager。",
    };
    throw new AuthorSessionError(response.status, messages[response.status] || "登录服务暂不可用，请稍后重试。");
  }
  const data: unknown = await response.json();
  return readSession(method === "POST" && typeof data === "object" && data !== null ? { ...data, author: true } : data);
}

export async function refreshStatus() {
  if (pending?.revision === revision) return pending.promise;
  const currentRevision = revision;
  const promise = request("GET").then(next => {
    // A response started before sign-in/out must not restore the old identity.
    if (currentRevision === revision) publish(next);
    return session;
  }).finally(() => { if (pending?.promise === promise) pending = undefined; });
  pending = { revision: currentRevision, promise };
  return promise;
}

export async function signIn(token: string) {
  revision++;
  const next = await request("POST", token);
  publish(next);
  channel?.postMessage("changed");
}

export async function signOut(forgetDevice = false) {
  revision++;
  try { await request("DELETE", undefined, forgetDevice); }
  catch (error) {
    if (!(error instanceof AuthorSessionError) || error.status !== 401) {
      if (error instanceof AuthorSessionError && error.status === 403) await refreshStatus();
      throw error;
    }
  }
  invalidateAuthorSession();
}

function initialize() {
  if (initialized) return;
  initialized = true;
  function check() {
    if (document.visibilityState === "hidden") return;
    // Device visibility must not wait for a slow/offline session endpoint.
    publish(session);
    if (!hasAuthorHint()) { revision++; publish(guest); return; }
    // Temporary network errors do not revoke a still-valid server session.
    void refreshStatus().catch(() => {});
  }
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("author-session");
    channel.onmessage = () => { revision++; check(); };
  }
  document.addEventListener("visibilitychange", check);
  window.addEventListener("pageshow", check);
  check();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAuthorSession() {
  useEffect(initialize, []);
  return useSyncExternalStore(subscribe, () => session, () => guest);
}

export function canAuthorize(token: string, scope: "upload" | "article" = "upload") {
  return Boolean(token.trim()) || (session.author && session.expiresAt > Date.now() && (scope === "upload" || session.article));
}

/** Explicit manual credentials take precedence, including when they are wrong. */
export function authorHeaders(token: string, scope: "upload" | "article" = "upload"): Record<string, string> {
  if (token.trim()) return { Authorization: `Bearer ${token.trim()}` };
  if (session.author && canAuthorize("", scope)) return { "X-Author-CSRF": session.csrf };
  if (session.author && session.expiresAt <= Date.now()) invalidateAuthorSession();
  throw new AuthorSessionError(401, "登录已过期，请重新登录或输入令牌。");
}

export function observeAuthorResponse(status: number, token: string) {
  if (token.trim()) return;
  if (status === 401) invalidateAuthorSession();
  // Refresh a rotated nonce for the next explicit attempt; never replay a write.
  if (status === 403) void refreshStatus().catch(() => {});
}

/** A non-secret display preference; every mutation still requires server authorization. */
export function useAuthorDevice() {
  useEffect(initialize, []);
  return useSyncExternalStore(subscribe, () => device, () => false);
}

export function requestAuthorSignIn(onSuccess: () => void) {
  window.dispatchEvent(new CustomEvent("author-sign-in", { detail: onSuccess }));
}
