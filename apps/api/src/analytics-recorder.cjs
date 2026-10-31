const crypto = require("node:crypto");

/** Single API writer: bounded queue, persistent deduplication and cursor-based counters. */
function createAnalyticsRecorder({ request, now = Date.now, maxPending = 32, maxEvents = 1_000_000 }) {
  const tails = new Map();
  let pending = 0, capacityAt = 0, count = 0, capacityCheck;
  const rows = async (collection, params) => (await request(`/items/${collection}?${new URLSearchParams(params)}`)).data || [];
  const write = (collection, body, id) => request(`/items/${collection}${id ? `/${id}` : ""}`, {
    method: id ? "PATCH" : "POST", body
  });
  const busy = () => Object.assign(new Error("Analytics capacity reached. Existing history has been retained."), { statusCode: 503 });

  async function reserveCapacity() {
    if (now() >= capacityAt) {
      capacityCheck ||= rows("analytics_events", { "aggregate[count]": "id" }).then(data => {
        count = Number(data[0]?.count?.id || 0); capacityAt = now() + 60_000;
      }).finally(() => { capacityCheck = null; });
      await capacityCheck;
    }
    if (count >= maxEvents) throw busy();
    count++; // Conservatively reserve ambiguous/failed writes until the next recount.
  }

  async function summary(event, item) {
    const key = `${event.itemType}:${event.itemId}`;
    const existing = (await rows("analytics_items", { "filter[item_key][_eq]": key, limit: "1" }))[0];
    if (existing?.last_event_id != null) return existing;
    // Preserve historical totals during upgrade; start the cursor before today's new insert.
    const latest = await rows("analytics_events", { "filter[item_key][_eq]": key, fields: "id", sort: "-id", limit: "1" });
    // Reconcile a legacy failed refresh once, without decreasing previously retained totals.
    const historical = latest.length ? await rows("analytics_events", { "filter[item_key][_eq]": key,
      "filter[id][_lte]": String(latest[0].id), "aggregate[count]": "id",
      "aggregate[countDistinct]": "visitor_hash", "groupBy[]": "event_type" }) : [];
    const views = historical.find(row => row.event_type === "view"), plays = historical.find(row => row.event_type === "play");
    const data = { item_type: event.itemType, item_key: key, title: item.title, slug: item.slug,
      post_id: event.itemType === "post" ? item.id : null,
      video_project_id: event.itemType === "video" ? item.id : null,
      view_count: Math.max(Number(existing?.view_count || 0), Number(views?.count?.id || 0)),
      visitor_count: Math.max(Number(existing?.visitor_count || 0), Number(views?.countDistinct?.visitor_hash || 0)),
      play_count: Math.max(Number(existing?.play_count || 0), Number(plays?.count?.id || 0)),
      player_count: Math.max(Number(existing?.player_count || 0), Number(plays?.countDistinct?.visitor_hash || 0)),
      last_event_id: latest[0]?.id || 0 };
    return (await write("analytics_items", data, existing?.id)).data;
  }

  async function flush(state) {
    // Bound recovery work. A later request continues a backlog after CMS downtime.
    for (let batch = 0; batch < 4; batch++) {
      const events = await rows("analytics_events", { "filter[item_key][_eq]": state.item_key,
        "filter[id][_gt]": String(state.last_event_id), fields: "id,event_type,first_visitor,created_at", sort: "id", limit: "100" });
      if (!events.length) return;
      const next = { view_count: Number(state.view_count || 0), visitor_count: Number(state.visitor_count || 0),
        play_count: Number(state.play_count || 0), player_count: Number(state.player_count || 0) };
      for (const event of events) {
        const play = event.event_type === "play";
        next[play ? "play_count" : "view_count"]++;
        if (event.first_visitor === true || event.first_visitor === 1) next[play ? "player_count" : "visitor_count"]++;
      }
      Object.assign(next, { last_event_id: events.at(-1).id, last_event_at: events.at(-1).created_at,
        updated_at: new Date(now()).toISOString() });
      // One PATCH advances counters and cursor together; an uncertain response is reread next time.
      await write("analytics_items", next, state.id);
      Object.assign(state, next);
      if (events.length < 100) return;
    }
  }

  async function record(event, item) {
    if (pending >= maxPending) throw busy();
    pending++;
    const key = `${event.itemType}:${event.itemId}`;
    const previous = tails.get(key) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const state = await summary(event, item);
      const dedupeKey = crypto.createHash("sha256").update(`${key}:${event.eventType}:${event.masterId || ""}:${event.visitorHash}:${Math.floor(now() / 1_800_000)}`).digest("hex");
      const duplicate = (await rows("analytics_events", { "filter[dedupe_key][_eq]": dedupeKey, fields: "id", limit: "1" }))[0];
      if (duplicate) { await flush(state); return { id: duplicate.id, duplicate: true }; }
      const seen = await rows("analytics_events", { "filter[item_key][_eq]": key,
        "filter[event_type][_eq]": event.eventType, "filter[visitor_hash][_eq]": event.visitorHash,
        fields: "id", sort: "id", limit: "1" });
      await reserveCapacity();
      const created = await write("analytics_events", {
        item_key: key, item_type: event.itemType, event_type: event.eventType,
        post_id: event.itemType === "post" ? item.id : null, video_project_id: event.itemType === "video" ? item.id : null,
        video_master_id: event.masterId || null, visitor_hash: event.visitorHash,
        dedupe_key: dedupeKey, first_visitor: seen.length === 0,
        path: event.path, referrer: event.referrer, user_agent: event.userAgent, created_at: new Date(now()).toISOString()
      });
      await flush(state);
      return { id: created.data.id, duplicate: false };
    }).finally(() => { pending--; if (tails.get(key) === work) tails.delete(key); });
    tails.set(key, work);
    return work;
  }
  return { record };
}

module.exports = { createAnalyticsRecorder };
