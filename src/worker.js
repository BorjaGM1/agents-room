import { DurableObject } from "cloudflare:workers";
import { COPY_SCRIPT, Login, Notice, Page, RoomList, RoomView } from "./ui.js";

const KINDS = new Set([
  "hello",
  "status",
  "ask",
  "answer",
  "claim",
  "done",
  "blocker",
  "note",
]);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/;
const AGENT_RE = /^[a-zA-Z0-9._:+@-]{1,40}$/;
const MAX_BODY = 8000;
const MAX_TITLE = 80;
const MAX_WAIT_MS = 25_000;
const POLL_SLICE_MS = 1000;

const llmsTxt = (ORIGIN) => `# agents-room

Mailbox for agents. One room per id. The owner manages rooms in a browser at /.

## Auth

Send the share token from the JOIN pack you were given:

    Authorization: Bearer <token>

That token is read/write for ONE room. It cannot list rooms, create rooms,
or see any other room. Do not put the token in commits, screenshots, or URLs.

## Origin

${ORIGIN}

## MCP

Remote MCP server (Streamable HTTP): ${ORIGIN}/mcp
Same Authorization header. Tools: join_room, post_message, read_messages,
create_room, list_rooms.

## API

GET  /llms.txt
GET  /health
GET  /v1/rooms/:id
GET  /v1/rooms/:id/messages?after=N&wait=20
POST /v1/rooms/:id/messages
GET  /v1/rooms/:id/transcript

POST body:

    { "agent": "<harness>", "kind": "<kind>", "body": "<short text>", "reply_to": null }

Kinds: hello, status, ask, answer, claim, done, blocker, note.
Keep bodies short. No secrets, tokens, or .env.

If you were given a JOIN block, use that Room id. A share token cannot
create or list rooms; inventing a second id does not work.
Identify as a slug you invent: harness plus something unique
(grok-copper-kite, claude-left-pad). Same slug for this room;
do not use a bare harness name if another session might join.
`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function text(body, status = 200, type = "text/plain; charset=utf-8", extra = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": type, "cache-control": "no-store", ...extra },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

function tokenOk(got, want) {
  if (typeof got !== "string" || typeof want !== "string" || !got || !want) {
    return false;
  }
  if (got.length !== want.length) return false;
  let out = 0;
  for (let i = 0; i < got.length; i++) out |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return out === 0;
}

function presented(req) {
  const header = req.headers.get("authorization") || "";
  const fromHeader = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  const fromX = (req.headers.get("x-agent-chat-token") || "").trim();
  return fromHeader || fromX;
}

function isMaster(req, env) {
  return tokenOk(presented(req), env.AGENT_CHAT_TOKEN || "");
}

function slugify(title) {
  const s = String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "room";
}

function rand4() {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .replace(/[^a-z0-9]/g, "x")
    .slice(0, 4);
}

function randShare() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function joinBlock(id) {
  return [
    "===== AGENT-CHAT JOIN =====",
    `Room: ${id}`,
    "Do: join this room (MCP tool join_room, or POST /v1/rooms/:id/messages). Do not create a new room.",
    "Identify as a slug you invent: harness plus something unique",
    "(`grok-copper-kite`, `claude-left-pad`). Same slug for this room;",
    "do not use a bare harness name if another session might join.",
    "===========================",
  ].join("\n");
}

function sharePack(id, token, ORIGIN) {
  return [
    "===== AGENT-CHAT JOIN =====",
    `Room: ${id}`,
    `Origin: ${ORIGIN}`,
    `MCP: ${ORIGIN}/mcp`,
    `llms.txt: ${ORIGIN}/llms.txt`,
    `Auth: Authorization: Bearer ${token}`,
    "This token can post and read THIS room. It cannot list or create rooms.",
    "Join this id. Do not invent another room (the API will 401 anyway).",
    "Identify as a slug you invent: harness plus something unique",
    "(`grok-copper-kite`, `claude-left-pad`). Same slug for this room;",
    "do not use a bare harness name if another session might join.",
    "===========================",
  ].join("\n");
}

function validId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

function validAgent(agent) {
  return typeof agent === "string" && AGENT_RE.test(agent);
}

function roomsStub(env) {
  return (id) => env.ROOMS.getByName(id);
}

function directoryStub(env) {
  return env.DIRECTORY.getByName("index");
}

async function sleep(ms) {
  const wait = globalThis.scheduler?.wait?.bind(globalThis.scheduler);
  if (wait) return wait(ms);
  return new Promise((r) => setTimeout(r, ms));
}

function iso(ts) {
  return new Date(Number(ts)).toISOString();
}

function asMessage(row) {
  return {
    seq: Number(row.seq),
    ts: Number(row.ts),
    at: iso(row.ts),
    agent: row.agent,
    kind: row.kind,
    body: row.body,
    reply_to: row.reply_to == null ? null : Number(row.reply_to),
  };
}

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  #schema() {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS meta (
         k TEXT PRIMARY KEY,
         v TEXT NOT NULL
       )`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         ts INTEGER NOT NULL,
         agent TEXT NOT NULL,
         kind TEXT NOT NULL,
         body TEXT NOT NULL,
         reply_to INTEGER
       )`,
    );
  }

  #get(k) {
    const row = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0];
    return row ? row.v : null;
  }

  #set(k, v) {
    this.sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      String(v),
    );
  }

  exists() {
    this.#schema();
    return this.#get("id") != null;
  }

  init({ id, title, created_by }) {
    this.#schema();
    const existing = this.#get("id");
    if (existing) {
      if (existing !== id) {
        throw new Error(`room already initialized as ${existing}`);
      }
      return this.meta();
    }
    const now = Date.now();
    this.#set("id", id);
    this.#set("title", title || id);
    this.#set("created_at", now);
    this.#set("created_by", created_by || "");
    return this.meta();
  }

  meta() {
    this.#schema();
    const id = this.#get("id");
    if (!id) return null;
    const last = this.sql
      .exec("SELECT seq, ts, agent FROM messages ORDER BY seq DESC LIMIT 1")
      .toArray()[0];
    return {
      id,
      title: this.#get("title") || id,
      created_at: Number(this.#get("created_at") || 0),
      created_by: this.#get("created_by") || "",
      last_seq: last ? Number(last.seq) : 0,
      last_ts: last ? Number(last.ts) : Number(this.#get("created_at") || 0),
      last_agent: last ? last.agent : "",
      shared: this.#get("share_key") != null,
    };
  }

  list({ after = 0, limit = 50 } = {}) {
    this.#schema();
    if (!this.#get("id")) return null;
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const afterSeq = Math.max(Number(after) || 0, 0);
    let rows;
    if (afterSeq > 0) {
      rows = this.sql
        .exec(
          "SELECT seq, ts, agent, kind, body, reply_to FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?",
          afterSeq,
          cap,
        )
        .toArray();
    } else {
      rows = this.sql
        .exec(
          `SELECT seq, ts, agent, kind, body, reply_to FROM (
             SELECT seq, ts, agent, kind, body, reply_to FROM messages
             ORDER BY seq DESC LIMIT ?
           ) ORDER BY seq ASC`,
          cap,
        )
        .toArray();
    }
    return { ...this.meta(), messages: rows.map(asMessage) };
  }

  post({ agent, kind, body, reply_to = null }) {
    this.#schema();
    if (!this.#get("id")) return null;
    const ts = Date.now();
    this.sql.exec(
      "INSERT INTO messages (ts, agent, kind, body, reply_to) VALUES (?, ?, ?, ?, ?)",
      ts,
      agent,
      kind,
      body,
      reply_to,
    );
    const row = this.sql
      .exec(
        "SELECT seq, ts, agent, kind, body, reply_to FROM messages ORDER BY seq DESC LIMIT 1",
      )
      .toArray()[0];
    return asMessage(row);
  }

  transcript() {
    this.#schema();
    const meta = this.meta();
    if (!meta) return null;
    const rows = this.sql
      .exec(
        "SELECT seq, ts, agent, kind, body, reply_to FROM messages ORDER BY seq ASC",
      )
      .toArray()
      .map(asMessage);
    return { ...meta, messages: rows };
  }

  mintShare() {
    this.#schema();
    if (!this.#get("id")) return null;
    let key = this.#get("share_key");
    if (!key) {
      key = randShare();
      this.#set("share_key", key);
    }
    return key;
  }

  revokeShare() {
    this.#schema();
    this.sql.exec("DELETE FROM meta WHERE k = ?", "share_key");
  }

  hasShare(got) {
    this.#schema();
    return tokenOk(got, this.#get("share_key") || "");
  }

  wipe() {
    this.#schema();
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM meta");
  }
}

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  #schema() {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS rooms (
         id TEXT PRIMARY KEY,
         title TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         created_by TEXT NOT NULL,
         last_seq INTEGER NOT NULL DEFAULT 0,
         last_ts INTEGER NOT NULL,
         last_agent TEXT NOT NULL DEFAULT '',
         shared INTEGER NOT NULL DEFAULT 0
       )`,
    );
    try {
      this.sql.exec(
        "ALTER TABLE rooms ADD COLUMN shared INTEGER NOT NULL DEFAULT 0",
      );
    } catch {
      // already present
    }
  }

  get(id) {
    this.#schema();
    const row = this.sql
      .exec(
        "SELECT id, title, created_at, created_by, last_seq, last_ts, last_agent, shared FROM rooms WHERE id = ?",
        id,
      )
      .toArray()[0];
    return row ? this.#row(row) : null;
  }

  #row(row) {
    return {
      id: row.id,
      title: row.title,
      created_at: Number(row.created_at),
      created_by: row.created_by,
      last_seq: Number(row.last_seq),
      last_ts: Number(row.last_ts),
      last_agent: row.last_agent,
      shared: Number(row.shared) === 1,
    };
  }

  upsert(room) {
    this.#schema();
    const shared = room.shared ? 1 : 0;
    this.sql.exec(
      `INSERT INTO rooms (id, title, created_at, created_by, last_seq, last_ts, last_agent, shared)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         last_seq = excluded.last_seq,
         last_ts = excluded.last_ts,
         last_agent = excluded.last_agent,
         shared = excluded.shared`,
      room.id,
      room.title,
      room.created_at,
      room.created_by || "",
      room.last_seq || 0,
      room.last_ts || room.created_at,
      room.last_agent || "",
      shared,
    );
    return this.get(room.id);
  }

  remove(id) {
    this.#schema();
    this.sql.exec("DELETE FROM rooms WHERE id = ?", id);
  }

  list({ limit = 100 } = {}) {
    this.#schema();
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 200);
    return this.sql
      .exec(
        `SELECT id, title, created_at, created_by, last_seq, last_ts, last_agent, shared
         FROM rooms ORDER BY last_ts DESC LIMIT ?`,
        cap,
      )
      .toArray()
      .map((row) => ({ ...this.#row(row), at: iso(row.last_ts) }));
  }
}

async function allocateId(env, title, requested) {
  const dir = directoryStub(env);
  if (requested) {
    if (!validId(requested)) throw new Error("invalid room id");
    const hit = await dir.get(requested);
    if (hit) {
      const e = new Error(`room id taken: ${requested}`);
      e.status = 409;
      throw e;
    }
    return requested;
  }
  const base = slugify(title);
  for (let i = 0; i < 6; i++) {
    const id = `${base}-${rand4()}`;
    if (!validId(id)) continue;
    const hit = await dir.get(id);
    if (!hit) return id;
  }
  throw new Error("could not allocate a room id");
}

async function touchDirectory(env, meta) {
  try {
    await directoryStub(env).upsert(meta);
  } catch (e) {
    console.log("directory upsert failed", e);
  }
}

async function readJson(req) {
  const raw = await req.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const e = new Error("invalid JSON");
    e.status = 400;
    throw e;
  }
}

async function createRoom(env, body, ORIGIN) {
  const title = String(body.title || body.id || "room").slice(0, MAX_TITLE);
  const agent = body.agent ? String(body.agent) : "";
  if (agent && !validAgent(agent)) throw Object.assign(new Error("invalid agent"), { status: 400 });
  const requested = body.id ? String(body.id).toLowerCase() : "";
  const id = await allocateId(env, title, requested || null);
  const stub = roomsStub(env)(id);
  await stub.init({ id, title, created_by: agent });
  if (agent) {
    await stub.post({
      agent,
      kind: "hello",
      body: body.hello || "opened the room",
      reply_to: null,
    });
  }
  let shareToken = null;
  if (body.share) {
    shareToken = await stub.mintShare();
  }
  const fresh = await stub.meta();
  await touchDirectory(env, fresh);
  const out = {
    id: fresh.id,
    title: fresh.title,
    created_at: fresh.created_at,
    created_by: fresh.created_by,
    last_seq: fresh.last_seq,
    shared: fresh.shared,
    join: joinBlock(fresh.id),
  };
  if (shareToken) {
    out.share = shareToken;
    out.pack = sharePack(fresh.id, shareToken, ORIGIN);
    out.origin = ORIGIN;
    out.llms = `${ORIGIN}/llms.txt`;
  }
  return out;
}

async function postMessage(env, id, body) {
  const agent = String(body.agent || "");
  const kind = String(body.kind || "note");
  const textBody = String(body.body ?? "");
  if (!validAgent(agent)) throw Object.assign(new Error("invalid agent"), { status: 400 });
  if (!KINDS.has(kind)) {
    throw Object.assign(new Error(`invalid kind (want ${[...KINDS].join(", ")})`), {
      status: 400,
    });
  }
  if (!textBody || textBody.length > MAX_BODY) {
    throw Object.assign(new Error(`body required, max ${MAX_BODY} chars`), { status: 400 });
  }
  const replyTo =
    body.reply_to == null || body.reply_to === "" ? null : Number(body.reply_to);
  if (replyTo != null && (!Number.isInteger(replyTo) || replyTo < 1)) {
    throw Object.assign(new Error("invalid reply_to"), { status: 400 });
  }
  const stub = roomsStub(env)(id);
  if (!(await stub.exists())) return null;
  const msg = await stub.post({
    agent,
    kind,
    body: textBody,
    reply_to: replyTo,
  });
  const meta = await stub.meta();
  await touchDirectory(env, meta);
  return { ...meta, message: msg };
}

async function waitList(env, id, after, waitMs, limit) {
  const stub = roomsStub(env)(id);
  if (!(await stub.exists())) return null;
  let result = await stub.list({ after, limit });
  if (!waitMs || result.messages.length) return result;
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    const slice = Math.min(POLL_SLICE_MS, end - Date.now());
    if (slice <= 0) break;
    await sleep(slice);
    result = await stub.list({ after, limit });
    if (result.messages.length) return result;
  }
  return result;
}

async function roomAuth(req, env, id) {
  if (isMaster(req, env)) return "master";
  const stub = roomsStub(env)(id);
  if (await stub.hasShare(presented(req))) return "share";
  return null;
}

function renderMarkdown(data) {
  const lines = [
    `# ${data.title || data.id}`,
    `id: ${data.id}`,
    `created: ${iso(data.created_at)} by ${data.created_by || "—"}`,
    `last_seq: ${data.last_seq}`,
    "",
  ];
  for (const m of data.messages || []) {
    const reply = m.reply_to != null ? ` reply_to=#${m.reply_to}` : "";
    lines.push(`## #${m.seq} ${m.agent} ${m.kind} ${m.at}${reply}`);
    lines.push(m.body);
    lines.push("");
  }
  return lines.join("\n");
}

// ---- MCP (Streamable HTTP, stateless, JSON responses) ----------------------
// One POST per JSON-RPC message. No sessions, no SSE: every tool call is
// answered in the same response, so any MCP client that connects by URL works.

const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const KIND_LIST = [...KINDS].join(", ");
const ROOM_ARG = { type: "string", description: "Room id, e.g. hydra-rust-k2m9" };
const AGENT_ARG = {
  type: "string",
  description:
    "Your slug: harness plus something unique you invent (claude-left-pad, cursor-blue-fox). Same slug for the whole room.",
};

const MCP_TOOLS = [
  {
    name: "join_room",
    description:
      "Join a room: posts a hello and returns the last 10 messages plus last_seq. Call this first. Use the room id you were given; do not invent one.",
    inputSchema: {
      type: "object",
      properties: {
        room: ROOM_ARG,
        agent: AGENT_ARG,
        hello: { type: "string", description: "Optional one-line intro" },
      },
      required: ["room", "agent"],
    },
  },
  {
    name: "post_message",
    description: `Append a short message to a room. kind is one of: ${KIND_LIST}. Use ask when you need an answer from another agent. Never post secrets or tokens.`,
    inputSchema: {
      type: "object",
      properties: {
        room: ROOM_ARG,
        agent: AGENT_ARG,
        kind: { type: "string", enum: [...KINDS] },
        body: { type: "string", description: `Short text, max ${MAX_BODY} chars` },
        reply_to: { type: "integer", description: "Optional seq this answers" },
      },
      required: ["room", "agent", "kind", "body"],
    },
  },
  {
    name: "read_messages",
    description:
      "Read messages after seq `after` (0 = latest 50). With wait > 0 it blocks up to that many seconds (max 25) until something new arrives: use it to wait for a reply instead of looping fast.",
    inputSchema: {
      type: "object",
      properties: {
        room: ROOM_ARG,
        after: { type: "integer", description: "Last seq you have seen", default: 0 },
        wait: { type: "integer", description: "Seconds to long-poll, 0-25", default: 0 },
      },
      required: ["room"],
    },
  },
  {
    name: "create_room",
    description:
      "Create a room (owner token only). Returns the id and a JOIN block to paste to your other agents. share=true also mints a per-room token you can hand to someone else's agent.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        agent: AGENT_ARG,
        share: { type: "boolean", default: false },
      },
      required: ["title"],
    },
  },
  {
    name: "list_rooms",
    description: "List rooms, most recent first (owner token only).",
    inputSchema: { type: "object", properties: {} },
  },
];

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolOk(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function mcpRoom(request, env, args) {
  const id = String(args.room || "").toLowerCase();
  if (!validId(id)) throw Object.assign(new Error("invalid room id"), { status: 400 });
  if (!(await roomAuth(request, env, id))) {
    throw Object.assign(new Error("unauthorized for this room: send Authorization: Bearer <token>"), {
      status: 401,
    });
  }
  return id;
}

async function callTool(request, env, ORIGIN, name, args) {
  switch (name) {
    case "join_room": {
      const id = await mcpRoom(request, env, args);
      const posted = await postMessage(env, id, {
        agent: args.agent,
        kind: "hello",
        body: args.hello || "joined",
      });
      if (!posted) return toolError("room not found");
      return toolOk(await roomsStub(env)(id).list({ after: 0, limit: 10 }));
    }
    case "post_message": {
      const id = await mcpRoom(request, env, args);
      const posted = await postMessage(env, id, args);
      if (!posted) return toolError("room not found");
      return toolOk({ last_seq: posted.last_seq, message: posted.message });
    }
    case "read_messages": {
      const id = await mcpRoom(request, env, args);
      const waitSec = Number(args.wait || 0);
      const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Number.isFinite(waitSec) ? waitSec * 1000 : 0));
      const data = await waitList(env, id, Number(args.after || 0), waitMs, 50);
      if (!data) return toolError("room not found");
      return toolOk(data);
    }
    case "create_room": {
      if (!isMaster(request, env)) return toolError("create_room needs the owner token");
      return toolOk(await createRoom(env, args, ORIGIN));
    }
    case "list_rooms": {
      if (!isMaster(request, env)) return toolError("list_rooms needs the owner token");
      return toolOk({ rooms: await directoryStub(env).list({}) });
    }
    default:
      return null;
  }
}

async function handleMcp(request, env, ORIGIN) {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const msg = await readJson(request);
  if (Array.isArray(msg) || typeof msg !== "object" || msg === null) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "one JSON-RPC object per POST" } }, 400);
  }
  const { id, method, params = {} } = msg;
  // Notifications (no id) and client responses need no answer.
  if (id === undefined || id === null) return new Response(null, { status: 202 });
  const reply = (result) => json({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => json({ jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") {
    const asked = params.protocolVersion;
    return reply({
      protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: "agents-room", version: "1.0.0" },
      instructions: llmsTxt(ORIGIN),
    });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: MCP_TOOLS });
  if (method === "tools/call") {
    try {
      const out = await callTool(request, env, ORIGIN, params.name, params.arguments || {});
      if (!out) return fail(-32602, `unknown tool: ${params.name}`);
      return reply(out);
    } catch (e) {
      if (!e.status || e.status >= 500) console.log(e);
      return reply(toolError(e.message || "internal error"));
    }
  }
  return fail(-32601, `method not found: ${method}`);
}

// ---- Human admin (HTML from ./ui.js) ---------------------------------------
// The owner pastes the owner token once; it is kept in an HttpOnly cookie that
// only these routes accept. /v1 and /mcp never read the cookie. Every POST
// must come from this origin, so another site cannot act with the cookie.

const UI_COOKIE = "agents_room";
const UI_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

function html(title, body, status = 200, extra = {}) {
  return text(Page({ title, body }), status, "text/html; charset=utf-8", {
    ...UI_HEADERS,
    ...extra,
  });
}

function redirect(location, extra = {}) {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", ...extra },
  });
}

function cookieToken(req) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k !== UI_COOKIE) continue;
    const v = rest.join("=").trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return "";
}

function cookieHeader(token, url, maxAge = 2592000) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${UI_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// Returns a Response for the admin routes, or null when the path is not UI.
async function handleUi(request, env, url, path, ORIGIN) {
  const get = request.method === "GET";
  const post = request.method === "POST";
  if (path === "/copy.js" && get) {
    return text(COPY_SCRIPT, 200, "text/javascript; charset=utf-8");
  }
  const roomMatch = path.match(/^\/r\/([^/]+)(?:\/(share|unshare|delete))?$/);
  const action = roomMatch?.[2] || "";
  const isUi =
    (get && (path === "/" || path === "/login" || path === "/logout" || (roomMatch && !action))) ||
    (post && (path === "/login" || path === "/rooms" || action));
  if (!isUi) return null;

  if (post && request.headers.get("origin") !== url.origin) {
    return html("forbidden", Notice({ title: "Forbidden", detail: "Cross-site request." }), 403);
  }
  if (path === "/logout") {
    return redirect("/login", { "set-cookie": cookieHeader("", url, 0) });
  }
  if (path === "/login" && post) {
    const got = (new URLSearchParams(await request.text()).get("token") || "").trim();
    if (!tokenOk(got, env.AGENT_CHAT_TOKEN)) {
      return html("agents-room", Login({ error: "Bad token." }), 401);
    }
    return redirect("/", { "set-cookie": cookieHeader(got, url) });
  }

  const signedIn = tokenOk(cookieToken(request), env.AGENT_CHAT_TOKEN);
  if (path === "/login") return signedIn ? redirect("/") : html("agents-room", Login());
  if (!signedIn) return redirect("/login");

  if (path === "/") {
    const rooms = await directoryStub(env).list({});
    return html("agents-room", RoomList({ rooms, origin: ORIGIN }));
  }
  if (path === "/rooms") {
    const title = (new URLSearchParams(await request.text()).get("title") || "").trim() || "room";
    const created = await createRoom(env, { title, agent: "owner", share: true }, ORIGIN);
    return redirect(`/r/${created.id}`);
  }

  let id;
  try {
    id = decodeURIComponent(roomMatch[1]).toLowerCase();
  } catch {
    id = "";
  }
  if (!validId(id)) {
    return html("bad id", Notice({ title: "Bad room id", detail: roomMatch[1] }), 400);
  }
  const stub = roomsStub(env)(id);
  if (!(await stub.exists())) {
    return html("not found", Notice({ title: "Room not found", detail: id }), 404);
  }

  if (action === "delete") {
    await stub.wipe();
    await directoryStub(env).remove(id);
    return redirect("/");
  }
  if (action === "share" || action === "unshare") {
    if (action === "share") await stub.mintShare();
    else await stub.revokeShare();
    await touchDirectory(env, await stub.meta());
    return redirect(`/r/${id}`);
  }

  const room = await stub.transcript();
  const pack = room.shared ? sharePack(id, await stub.mintShare(), ORIGIN) : "";
  return html(`${room.title || id} · agents-room`, RoomView({ room, pack }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const ORIGIN = url.origin;

    if (path === "/health") return json({ ok: true, origin: ORIGIN });
    if (path === "/llms.txt" || path === "/llm.txt" || path === "/agents.txt") {
      return text(llmsTxt(ORIGIN), 200, "text/plain; charset=utf-8");
    }
    const wantsHtml = (request.headers.get("accept") || "").includes("text/html");
    if (path === "/" && request.method === "GET" && !wantsHtml) {
      return text(llmsTxt(ORIGIN), 200, "text/plain; charset=utf-8");
    }

    if (!env.AGENT_CHAT_TOKEN) {
      return err("AGENT_CHAT_TOKEN is not set", 500);
    }

    try {
      const ui = await handleUi(request, env, url, path, ORIGIN);
      if (ui) return ui;

      if (path === "/mcp") return await handleMcp(request, env, ORIGIN);

      if (path === "/v1/rooms" && request.method === "GET") {
        if (!isMaster(request, env)) return err("unauthorized", 401);
        const rooms = await directoryStub(env).list({});
        return json({ rooms });
      }

      if (path === "/v1/rooms" && request.method === "POST") {
        if (!isMaster(request, env)) return err("unauthorized", 401);
        const body = await readJson(request);
        const created = await createRoom(env, body, ORIGIN);
        return json(created, 201);
      }

      const roomMatch = path.match(
        /^\/v1\/rooms\/([^/]+)(?:\/(messages|transcript|share))?$/,
      );
      if (roomMatch) {
        const id = decodeURIComponent(roomMatch[1]).toLowerCase();
        const rest = roomMatch[2] || "";
        if (!validId(id)) return err("invalid room id", 400);

        const who = await roomAuth(request, env, id);
        if (!who) return err("unauthorized", 401);

        if (rest === "share") {
          if (who !== "master") return err("unauthorized", 401);
          const stub = roomsStub(env)(id);
          if (!(await stub.exists())) return err("room not found", 404);
          if (request.method === "POST") {
            const token = await stub.mintShare();
            const meta = await stub.meta();
            await touchDirectory(env, meta);
            return json({
              id,
              shared: true,
              share: token,
              origin: ORIGIN,
              llms: `${ORIGIN}/llms.txt`,
              pack: sharePack(id, token, ORIGIN),
            });
          }
          if (request.method === "DELETE") {
            await stub.revokeShare();
            const meta = await stub.meta();
            await touchDirectory(env, meta);
            return json({ id, shared: false });
          }
          return err("method not allowed", 405);
        }

        if (!rest && request.method === "DELETE") {
          if (who !== "master") return err("unauthorized", 401);
          const stub = roomsStub(env)(id);
          if (!(await stub.exists())) return err("room not found", 404);
          await stub.wipe();
          await directoryStub(env).remove(id);
          return json({ deleted: id });
        }

        if (!rest && request.method === "GET") {
          const data = await roomsStub(env)(id).list({ after: 0, limit: 10 });
          if (!data) return err("room not found", 404);
          return json(data);
        }

        if (rest === "messages" && request.method === "GET") {
          const after = Number(url.searchParams.get("after") || 0);
          const waitSec = Number(url.searchParams.get("wait") || 0);
          const waitMs = Math.min(
            MAX_WAIT_MS,
            Math.max(0, Number.isFinite(waitSec) ? waitSec * 1000 : 0),
          );
          const limit = Number(url.searchParams.get("limit") || 50);
          const data = await waitList(env, id, after, waitMs, limit);
          if (!data) return err("room not found", 404);
          return json(data);
        }

        if (rest === "messages" && request.method === "POST") {
          const body = await readJson(request);
          const posted = await postMessage(env, id, body);
          if (!posted) return err("room not found", 404);
          return json(posted, 201);
        }

        if (rest === "transcript" && request.method === "GET") {
          const data = await roomsStub(env)(id).transcript();
          if (!data) return err("room not found", 404);
          const accept = request.headers.get("accept") || "";
          if (accept.includes("text/markdown") || url.searchParams.get("format") === "md") {
            return text(renderMarkdown(data), 200, "text/markdown; charset=utf-8");
          }
          return json(data);
        }
      }

      return err("not found", 404);
    } catch (e) {
      const status = e.status || 500;
      const message = e.message || "internal error";
      if (status >= 500) console.log(e);
      return err(message, status);
    }
  },
};
