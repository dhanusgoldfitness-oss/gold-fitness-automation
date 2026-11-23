// Thin Meta WhatsApp Cloud API client. The token stays server-side and is redacted from every error.

export class MetaError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind; // rate_limit | uncertain | rejected | auth | invalid
    Object.assign(this, extra);
  }
}

const RATE_LIMIT_CODES = new Set([130429, 131056, 80007]);

export class WhatsAppClient {
  constructor({ token, phoneNumberId, apiVersion = "v21.0", fetchImpl = globalThis.fetch, timeoutMs = 10000, now = Date.now }) {
    this.token = token;
    this.phoneNumberId = phoneNumberId;
    this.apiVersion = apiVersion;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  redact(text) {
    let s = String(text ?? "");
    if (this.token) s = s.split(this.token).join("[redacted]");
    return s;
  }

  async post(payload) {
    const requestedAt = this.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(`https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
        signal: ctrl.signal,
      });
    } catch (err) {
      // No response: Meta may or may not have accepted it. Callers must not resend blindly.
      throw new MetaError("uncertain", "no response from Meta (network error or timeout)", { requestedAt });
    } finally {
      clearTimeout(timer);
    }
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON body */
    }
    const id = body?.messages?.[0]?.id;
    if (res.ok && id) return { id, requestedAt, acceptedAt: this.now() };

    const code = body?.error?.code;
    const message = this.redact(body?.error?.message || `HTTP ${res.status}`);
    if (res.status === 429 || RATE_LIMIT_CODES.has(code)) {
      const ra = Number(res.headers?.get?.("retry-after"));
      throw new MetaError("rate_limit", message, { code, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null, requestedAt });
    }
    if (res.status === 401 || code === 190) throw new MetaError("auth", message, { code, requestedAt });
    if (res.status >= 500) throw new MetaError("uncertain", message, { code, requestedAt });
    throw new MetaError("rejected", message, { code, requestedAt });
  }

  sendTemplate(to, name, language, params = []) {
    const components = params.length ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: String(p) })) }] : [];
    return this.post({ to, type: "template", template: { name, language: { code: language }, components } });
  }

  sendText(to, body) {
    return this.post({ to, type: "text", text: { body, preview_url: true } });
  }

  sendImage(to, { link, caption }) {
    return this.post({ to, type: "image", image: caption ? { link, caption } : { link } });
  }

  sendList(to, { body, button, rows, footer }) {
    if (body.length > 1024) throw new MetaError("invalid", "list body over 1024 characters");
    if (button.length > 20) throw new MetaError("invalid", "list button label over 20 characters");
    for (const r of rows) if (r.title.length > 24) throw new MetaError("invalid", `row title over 24 characters: ${r.title}`);
    const interactive = { type: "list", body: { text: body }, action: { button, sections: [{ title: "Options", rows: rows.map((r) => ({ id: r.id, title: r.title })) }] } };
    if (footer) interactive.footer = { text: footer };
    return this.post({ to, type: "interactive", interactive });
  }

  sendButtons(to, { body, buttons }) {
    if (buttons.length > 3) throw new MetaError("invalid", "more than 3 reply buttons");
    for (const b of buttons) if (b.title.length > 20) throw new MetaError("invalid", `button title over 20 characters: ${b.title}`);
    return this.post({
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
      },
    });
  }

  /** Live approval status of one template/language from Meta (needs WA_BUSINESS_ACCOUNT_ID and a token allowed to read templates). */
  async templateStatus(wabaId, name, language) {
    const url = `https://graph.facebook.com/${this.apiVersion}/${wabaId}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,category,language&limit=20`;
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}` } });
    let body = {};
    try { body = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw new MetaError("rejected", this.redact(body?.error?.message || `HTTP ${res.status}`), { code: body?.error?.code });
    const hit = (body.data || []).find((t) => t.name === name && t.language === language);
    return hit ? { status: hit.status, category: hit.category } : { status: "MISSING" };
  }
}
