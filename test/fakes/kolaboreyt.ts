/**
 * Strict in-memory stand-in for Kolaboreyt's Platform API, following the uploaded
 * API docs: auth + API-Version headers, one mutation root per request, required
 * Idempotency-Key with replay (and 409 on reuse with a different body), column
 * value normalisation per type, subitems, comments, archiving.
 */
type Json = any;

const err = (code: string, message: string, status = 200, extra: Record<string, unknown> = {}) => ({
  status,
  body: { errors: [{ message, extensions: { code, ...extra } }] },
});

export class FakeKolaboreyt {
  requests: Array<{ headers: Record<string, string>; query: string; variables: Record<string, Json> }> = [];
  boards: Array<{ id: string; name: string; workspace_id: string; groups: Array<{ id: string; title: string }> }> = [];
  columns: Array<{ id: string; board_id: string; key: string; title: string; type: string; owner_kind: string }> = [];
  items = new Map<string, { board_id: string; name: string; parent: string | null; state: string }>();
  cells = new Map<string, string>(); // `${item}:${col}` -> stored value_json
  updates: Array<{ item: string; body: string }> = [];
  idem = new Map<string, { body: string; response: Json }>();
  failNext: number | null = null;
  down = false;
  /** Scopes the fake key holds; omit one to test MISSING_SCOPE handling. */
  scopes = new Set(["me:read", "boards:read", "boards:write", "columns:write", "items:read", "items:write"]);
  private n = 0;
  private id = (p: string) => `${p}_${++this.n}`;

  fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.down) throw new TypeError("fetch failed");
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const raw = String(init?.body);
    const { query, variables = {} } = JSON.parse(raw);
    this.requests.push({ headers, query, variables });
    const json = (status: number, body: Json, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

    if (this.failNext) {
      const status = this.failNext;
      this.failNext = null;
      return json(status, err("RATE_LIMIT_EXCEEDED", "slow down").body, { "retry-after": "0" });
    }
    if (!headers.authorization?.startsWith("Bearer ")) return json(401, err("UNAUTHORIZED", "bad key").body);
    if (headers["api-version"] !== "2026-07") return json(400, err("API_VERSION_REQUIRED", "version").body);

    const isMutation = query.trimStart().startsWith("mutation");
    if (isMutation) {
      const key = headers["idempotency-key"];
      if (!key) return json(400, err("IDEMPOTENCY_KEY_REQUIRED", "key required").body);
      const seen = this.idem.get(key);
      if (seen) {
        if (seen.body !== raw) return json(409, err("IDEMPOTENCY_KEY_REUSED", "different body").body);
        return json(200, seen.response, { "idempotency-replayed": "true" });
      }
      const out = this.run(query, variables);
      const response = out.status === 200 && !out.body.errors ? out.body : out.body;
      if (!out.body.errors) this.idem.set(key, { body: raw, response });
      return json(out.status, response);
    }
    const out = this.run(query, variables);
    return json(out.status, out.body);
  };

  private need(scope: string) {
    if (!this.scopes.has(scope)) throw Object.assign(new Error("missing scope"), { code: "MISSING_SCOPE", required_scope: scope });
  }

  private run(q: string, v: Record<string, Json>): { status: number; body: Json } {
    try {
      return { status: 200, body: { data: this.exec(q, v) } };
    } catch (e: any) {
      if (e.code) return err(e.code, e.message, 200, e.required_scope ? { required_scope: e.required_scope } : {});
      throw e;
    }
  }

  private col(id: string) {
    const c = this.columns.find((x) => x.id === id);
    if (!c) throw Object.assign(new Error("no column"), { code: "NOT_FOUND" });
    return c;
  }

  /** Normalise a cell value as the docs' "Column values" table describes, or reject it. */
  private normalise(type: string, input: Json): Json {
    const bad = () => {
      throw Object.assign(new Error(`bad value for ${type}`), { code: "INVALID_COLUMN_VALUE" });
    };
    switch (type) {
      case "text.line":
        return typeof input === "string" || typeof input === "number" ? String(input) : bad();
      case "text.prose":
        return input;
      case "metric.amount": {
        const n = typeof input === "number" ? input : typeof input === "string" && input.trim() !== "" ? Number(input) : NaN;
        return Number.isFinite(n) ? n : bad();
      }
      case "when.day":
        if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) return { date: input };
        if (input && typeof input === "object" && input.date) return { date: input.date };
        return bad();
      case "pick.stage": {
        const label = typeof input === "string" ? input : input?.label;
        return typeof label === "string" && label ? { label } : bad();
      }
      case "reach.phone":
        if (typeof input === "string" && input.trim()) return { number: input };
        if (input?.number) return { number: input.number, region: input.region };
        return bad();
      case "reach.url":
        if (typeof input === "string" && /^https?:\/\//.test(input)) return { href: input, label: input };
        if (input?.href || input?.url) return { href: input.href ?? input.url, label: input.href ?? input.url };
        return bad();
      default:
        return input;
    }
  }

  private exec(q: string, v: Record<string, Json>): Json {
    if (/\bme\s*\{/.test(q) && !q.includes("mutation")) {
      this.need("me:read");
      return { me: { id: "usr_1", name: "Test Owner", email: "owner@example.com" } };
    }
    if (q.includes("create_board")) {
      this.need("boards:write");
      const b = { id: this.id("brd"), name: v.name, workspace_id: v.ws, groups: [{ id: this.id("grp"), title: "Group Title" }] };
      this.boards.push(b);
      return { create_board: { id: b.id } };
    }
    if (q.includes("create_column")) {
      this.need("columns:write");
      const existing = this.columns.filter((c) => c.board_id === v.b).map((c) => c.key);
      let key = String(v.t).toLowerCase().replace(/[^a-z0-9]+/g, "_");
      for (let i = 2; existing.includes(key); i++) key = `${key.replace(/_\d+$/, "")}_${i}`;
      const c = { id: this.id("col"), board_id: v.b, key, title: v.t, type: v.type, owner_kind: v.layer ?? "item" };
      this.columns.push(c);
      return { create_column: { id: c.id, title: c.title, type: c.type, owner_kind: c.owner_kind } };
    }
    if (q.includes("create_item")) {
      this.need("items:write");
      const id = this.id("itm");
      this.items.set(id, { board_id: v.b, name: v.n, parent: null, state: "active" });
      return { create_item: { id } };
    }
    if (q.includes("create_subitem")) {
      this.need("items:write");
      const parent = this.items.get(v.p);
      if (!parent || parent.state === "archived") throw Object.assign(new Error("parent"), { code: "PARENT_NOT_FOUND" });
      if (parent.parent) throw Object.assign(new Error("nested"), { code: "UNSUPPORTED_PARENT" });
      const id = this.id("sub");
      this.items.set(id, { board_id: parent.board_id, name: v.n, parent: v.p, state: "active" });
      return { create_subitem: { id } };
    }
    if (q.includes("change_column_value")) {
      this.need("items:write");
      const item = this.items.get(v.i);
      if (!item) throw Object.assign(new Error("item"), { code: "NOT_FOUND" });
      const c = this.col(v.c);
      const layer = item.parent ? "subitem" : "item";
      if (c.owner_kind !== layer) throw Object.assign(new Error("layer"), { code: "COLUMN_ROW_LAYER_MISMATCH" });
      let parsed: Json;
      try {
        parsed = JSON.parse(v.v);
      } catch {
        throw Object.assign(new Error("json"), { code: "INVALID_JSON" });
      }
      const stored = this.normalise(c.type, parsed);
      this.cells.set(`${v.i}:${v.c}`, JSON.stringify(stored));
      return { change_column_value: { column_id: v.c, value_json: JSON.stringify(stored) } };
    }
    if (q.includes("add_item_update")) {
      this.need("items:write");
      if (!String(v.body ?? "").trim()) throw Object.assign(new Error("body"), { code: "INVALID_COMMENT_BODY" });
      this.updates.push({ item: v.i, body: v.body });
      return { add_item_update: { id: this.id("upd"), body: v.body } };
    }
    if (q.includes("archive_item")) {
      this.need("items:write");
      for (const [id, it] of this.items) if (id === v.i || it.parent === v.i) it.state = "archived";
      return { archive_item: { id: v.i, state: "archived" } };
    }
    const rowOut = (id: string) => {
      const it = this.items.get(id)!;
      return {
        id,
        name: it.name,
        parent_item_id: it.parent,
        state: it.state,
        column_values: [...this.cells].filter(([k]) => k.startsWith(`${id}:`)).map(([k, val]) => ({ column_id: k.split(":")[1], value_json: val })),
      };
    };
    if (q.includes("list_subitems")) {
      this.need("items:read");
      return { list_subitems: [...this.items].filter(([, it]) => it.parent === v.p && it.state !== "archived").map(([id]) => rowOut(id)) };
    }
    if (q.includes("items(ids")) {
      this.need("items:read");
      const ids: string[] = v.ids ?? (v.i ? [v.i] : []);
      return { items: ids.filter((id) => this.items.get(id)?.state === "active").map(rowOut) };
    }
    if (q.includes("boards(ids")) {
      this.need("boards:read");
      return {
        boards: this.boards
          .filter((b) => b.id === v.b)
          .map((b) => ({ groups: b.groups, columns: this.columns.filter((c) => c.board_id === b.id).map(({ id, key, title, type, owner_kind }) => ({ id, key, title, type, owner_kind })) })),
      };
    }
    if (q.includes("boards(")) {
      this.need("boards:read");
      return { boards: this.boards.map(({ id, name, workspace_id }) => ({ id, name, workspace_id })) };
    }
    throw new Error(`FakeKolaboreyt: unhandled document: ${q}`);
  }

  mutations() {
    return this.requests.filter((r) => r.query.trimStart().startsWith("mutation"));
  }
  cellsOf(itemId: string, title: string, layer = "item") {
    const col = this.columns.find((c) => c.title === title && c.owner_kind === layer)!;
    const raw = this.cells.get(`${itemId}:${col.id}`);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}
