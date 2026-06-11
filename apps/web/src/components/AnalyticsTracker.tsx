"use client";

import { useEffect } from "react";

type AnalyticsItemType = "post" | "video";
type AnalyticsEventType = "view" | "play";

type AnalyticsEvent = {
  eventType: AnalyticsEventType;
  itemType: AnalyticsItemType;
  itemId: number;
  masterId?: number | null;
  path?: string;
  referrer?: string;
  dedupeKey?: string;
  dedupeMs?: number;
};

const VISITOR_ID_KEY = "multi-master-video-blog.visitor-id";
const DEDUPE_PREFIX = "multi-master-video-blog.analytics.";

export function AnalyticsTracker({
  itemType,
  itemId,
}: {
  itemType: AnalyticsItemType;
  itemId: number;
}) {
  useEffect(() => {
    trackAnalyticsEvent({
      eventType: "view",
      itemType,
      itemId,
      dedupeKey: `view:${itemType}:${itemId}:${window.location.pathname}`,
      dedupeMs: 2000,
    });
  }, [itemId, itemType]);

  return null;
}

export function trackAnalyticsEvent(event: AnalyticsEvent) {
  if (typeof window === "undefined") return;

  const dedupeKey =
    event.dedupeKey ||
    `${event.eventType}:${event.itemType}:${event.itemId}:${event.masterId || ""}`;
  if (isRecentDuplicate(dedupeKey, event.dedupeMs ?? 2000)) {
    return;
  }

  const payload = {
    eventType: event.eventType,
    itemType: event.itemType,
    itemId: event.itemId,
    masterId: event.masterId ?? null,
    visitorId: getVisitorId(),
    path: event.path || window.location.pathname,
    referrer: event.referrer || document.referrer || "",
  };
  const body = JSON.stringify(payload);

  if (navigator.sendBeacon) {
    const sent = navigator.sendBeacon(
      "/api/analytics/events",
      new Blob([body], { type: "application/json" }),
    );
    if (sent) return;
  }

  void fetch("/api/analytics/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

function getVisitorId() {
  try {
    const existing = window.localStorage.getItem(VISITOR_ID_KEY);
    if (existing) return existing;

    const next =
      window.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(VISITOR_ID_KEY, next);
    return next;
  } catch {
    return "";
  }
}

function isRecentDuplicate(key: string, dedupeMs: number) {
  try {
    const storageKey = `${DEDUPE_PREFIX}${key}`;
    const now = Date.now();
    const previous = Number(window.sessionStorage.getItem(storageKey) || 0);
    if (previous && now - previous < dedupeMs) {
      return true;
    }

    window.sessionStorage.setItem(storageKey, String(now));
    return false;
  } catch {
    return false;
  }
}
