// Per-message timing: inbound receipt -> durable save -> processing -> Meta acceptance (separate from) delivery.
// Meta acceptance (the API returned a message id) is NOT delivery; delivery arrives later as a status webhook.

export class Timings {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.records = new Map(); // inbound wamid -> record
    this.byOutbound = new Map(); // outbound wamid -> inbound wamid
    this.order = [];
  }
  start(wamid) {
    const rec = { wamid, receivedAt: this.now(), idleBeforeMs: null, outbound: [] };
    const prev = this.order.length ? this.records.get(this.order[this.order.length - 1]) : null;
    rec.idleBeforeMs = prev ? rec.receivedAt - prev.receivedAt : null;
    this.records.set(wamid, rec);
    this.order.push(wamid);
    return rec;
  }
  mark(wamid, stage) {
    const rec = this.records.get(wamid);
    if (rec && rec[stage] === undefined) rec[stage] = this.now();
  }
  outboundAccepted(wamid, outId, requestedAt, acceptedAt) {
    const rec = this.records.get(wamid);
    if (!rec) return;
    rec.outbound.push({ id: outId, requestedAt, acceptedAt, deliveredAt: null, readAt: null, failedAt: null });
    this.byOutbound.set(outId, wamid);
  }
  status(outId, status, at = this.now()) {
    const wamid = this.byOutbound.get(outId);
    const rec = wamid && this.records.get(wamid);
    const o = rec && rec.outbound.find((x) => x.id === outId);
    if (!o) return;
    if (status === "delivered") o.deliveredAt = at;
    else if (status === "read") o.readAt = at;
    else if (status === "failed") o.failedAt = at;
  }
  /** Millisecond breakdown for one inbound message. Fields are null when the stage has not happened. */
  report(wamid) {
    const r = this.records.get(wamid);
    if (!r) return null;
    const first = r.outbound[0];
    const d = (a, b) => (a != null && b != null ? b - a : null);
    return {
      wamid,
      ack_ms: d(r.receivedAt, r.persistedAt), // receipt -> saved (webhook can now return 200)
      queue_wait_ms: d(r.persistedAt, r.processStartAt), // saved -> processing started
      handler_ms: d(r.processStartAt, first?.requestedAt), // processing -> first Meta request
      meta_accept_ms: d(first?.requestedAt, first?.acceptedAt), // Meta API round trip
      receipt_to_meta_accept_ms: d(r.receivedAt, first?.acceptedAt),
      accept_to_delivered_ms: d(first?.acceptedAt, first?.deliveredAt), // null until a delivered status arrives
      first_after_idle: r.idleBeforeMs == null ? null : r.idleBeforeMs,
    };
  }
  /** Compare the first reply after an idle gap with replies that follow closely. */
  coldVsWarm(idleThresholdMs = 15 * 60 * 1000) {
    const cold = [];
    const warm = [];
    for (const id of this.order) {
      const rep = this.report(id);
      if (!rep || rep.receipt_to_meta_accept_ms == null) continue;
      (rep.first_after_idle == null || rep.first_after_idle >= idleThresholdMs ? cold : warm).push(rep.receipt_to_meta_accept_ms);
    }
    const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    return { cold_count: cold.length, cold_avg_ms: avg(cold), warm_count: warm.length, warm_avg_ms: avg(warm) };
  }
}
