// Before-and-after photos: manifest (every Cloudinary page, cached) + durable, paced, resumable send queue.

export function deliveryUrl(cloudName, publicId, version) {
  // JPEG on purpose: WhatsApp accepts only JPEG/PNG, and f_auto can return WebP/AVIF.
  return `https://res.cloudinary.com/${cloudName}/image/upload/f_jpg,q_auto,w_1600/v${version}/${publicId}.jpg`;
}

/** Keep "<name>-before" / "<name>-after" files together (before first). Files with no pair marker keep their order. */
export function groupPairs(assets) {
  const out = [];
  const used = new Set();
  const pairOf = (id) => {
    const m = /^(.*?)[-_ ]?(before|after)$/i.exec(id.replace(/_[a-z0-9]{6}$/i, ""));
    return m ? { stem: m[1].toLowerCase(), side: m[2].toLowerCase() } : null;
  };
  assets.forEach((a, i) => {
    if (used.has(i)) return;
    const p = pairOf(a.public_id);
    if (!p) {
      out.push(a);
      used.add(i);
      return;
    }
    const mates = assets
      .map((b, j) => ({ b, j, p: pairOf(b.public_id) }))
      .filter((x) => x.p && x.p.stem === p.stem && !used.has(x.j))
      .sort((x, y) => (x.p.side === "before" ? -1 : 1) - (y.p.side === "before" ? -1 : 1));
    for (const x of mates) {
      out.push(x.b);
      used.add(x.j);
    }
  });
  return out;
}

export class ManifestCache {
  constructor({ cloudName, apiKey, apiSecret, folder, approved = null, fetchImpl = globalThis.fetch, ttlMs = 6 * 3600 * 1000, now = Date.now }) {
    Object.assign(this, { cloudName, apiKey, apiSecret, folder, approved, fetchImpl, ttlMs, now });
    this.cache = null;
  }

  async listFolder() {
    const auth = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString("base64");
    const resources = [];
    let cursor;
    let pages = 0;
    do {
      const res = await this.fetchImpl(`https://api.cloudinary.com/v1_1/${this.cloudName}/resources/search`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expression: `asset_folder="${this.folder}"`, max_results: 500, sort_by: [{ public_id: "asc" }], ...(cursor ? { next_cursor: cursor } : {}) }),
      });
      if (!res.ok) throw new Error(`Cloudinary listing failed: HTTP ${res.status}`);
      const body = await res.json();
      resources.push(...(body.resources || []));
      cursor = body.next_cursor;
      pages++;
    } while (cursor && pages < 50);
    return resources.filter((r) => r.resource_type === "image" && (!r.type || r.type === "upload"));
  }

  build(listing, source) {
    let list;
    if (this.approved && this.approved.length) {
      const byId = new Map(listing.map((r) => [r.public_id, r]));
      list = [];
      for (const a of this.approved) {
        const live = byId.get(a.public_id);
        if (live) list.push({ public_id: a.public_id, version: live.version ?? a.version });
        else if (source === "static_fallback") list.push({ public_id: a.public_id, version: a.version });
      }
    } else {
      list = listing.map((r) => ({ public_id: r.public_id, version: r.version }));
      list = groupPairs(list);
    }
    return list.map((a) => ({ public_id: a.public_id, url: deliveryUrl(this.cloudName, a.public_id, a.version) }));
  }

  async get() {
    if (this.cache && this.now() - this.cache.fetchedAt < this.ttlMs) return this.cache;
    try {
      const listing = await this.listFolder();
      this.cache = { assets: this.build(listing, "cloudinary"), source: "cloudinary", fetchedAt: this.now(), error: null };
    } catch (err) {
      const message = String(err.message || err).replace(this.apiSecret || "\u0000", "[redacted]");
      if (this.cache) {
        this.cache = { ...this.cache, error: message }; // keep serving the last good manifest
      } else if (this.approved && this.approved.length) {
        this.cache = { assets: this.build([], "static_fallback"), source: "static_fallback", fetchedAt: this.now(), error: message };
      } else {
        return { assets: [], source: "none", fetchedAt: this.now(), error: message };
      }
    }
    return this.cache;
  }
}

/**
 * Sends every pending asset of a job, in order, one at a time.
 * - Progress is saved per asset, so a retry resumes instead of restarting.
 * - rate_limit: back off and retry the same asset (not accepted, so safe). Gives up after maxRateRetries and parks the job.
 * - uncertain (timeout / 5xx): NEVER resent automatically; recorded for staff.
 * - rejected: recorded and skipped; the rest still send.
 */
export async function runPhotoJob({ job, store, client, to, sleep, paceMs = 1500, maxRateRetries = 4, baseBackoffMs = 5000, now = Date.now }) {
  // An asset still marked "sending" means a previous run died mid-request: Meta may have accepted it.
  // Never resend those blindly; record them for staff instead.
  for (const a of job.assets) {
    if (a.status === "sending") {
      a.status = "uncertain";
      a.error = "interrupted while sending; acceptance unknown";
      await store.logMediaError({ chat: job.chat, jobKey: job.key, public_id: a.public_id, kind: "uncertain", message: a.error, at: now() });
    }
  }
  job.status = "running";
  await store.saveJob(job);
  let paused = false;
  for (let i = 0; i < job.assets.length; i++) {
    const a = job.assets[i];
    if (a.status !== "pending") continue;
    let tries = 0;
    for (;;) {
      try {
        a.status = "sending";
        await store.saveJob(job);
        const r = await client.sendImage(to, { link: a.url });
        a.status = "accepted";
        a.wamid = r.id;
        a.acceptedAt = r.acceptedAt;
        break;
      } catch (err) {
        if (err.kind === "rate_limit" && tries < maxRateRetries) {
          tries++;
          a.status = "pending"; // not accepted, so retrying the same image is safe
          await sleep(err.retryAfterMs ?? baseBackoffMs * 2 ** (tries - 1));
          continue;
        }
        if (err.kind === "rate_limit") {
          paused = true;
          a.status = "pending";
          a.error = "rate limited";
          break;
        }
        a.status = err.kind === "uncertain" ? "uncertain" : "failed";
        a.error = String(err.message || err);
        await store.logMediaError({ chat: job.chat, jobKey: job.key, public_id: a.public_id, kind: err.kind || "error", message: a.error, at: now() });
        break;
      }
    }
    await store.saveJob(job);
    if (paused) break;
    if (i < job.assets.length - 1) await sleep(paceMs);
  }
  const counts = { accepted: 0, failed: 0, uncertain: 0, pending: 0 };
  for (const a of job.assets) counts[a.status] = (counts[a.status] || 0) + 1;
  job.status = paused ? "paused_rate_limit" : counts.pending === 0 ? "done" : "pending";
  await store.saveJob(job);
  return { ...counts, total: job.assets.length, paused };
}
