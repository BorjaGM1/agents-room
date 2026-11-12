// The human admin, as raw components: each one takes plain data and returns an
// HTML string. No framework, no build, almost no CSS. Restyle or rewrite this
// file freely; the Worker only needs the exports to keep their names.
//
// Routes these pages talk to (all handled in worker.js):
//   GET  /                 RoomList        POST /rooms            create + share
//   GET  /r/:id            RoomView        POST /r/:id/share      mint the pack
//   GET  /login            Login           POST /r/:id/unshare    revoke it
//   GET  /logout                           POST /r/:id/delete     wipe the room

// The whole look. Class names are stable hooks: ac-*.
export const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 0 auto; padding: 1rem; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .ac-id { display: block; opacity: .7; font-size: .85em; }
  .ac-admin { display: flex; gap: .5rem; flex-wrap: wrap; align-items: flex-start; }
`;

// Served at /copy.js. Only job: the "Copy pack" button.
export const COPY_SCRIPT = `
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  const src = document.getElementById(btn.dataset.copy);
  const out = btn.nextElementSibling;
  try {
    await navigator.clipboard.writeText(src.textContent);
    out.textContent = "copied";
  } catch {
    out.textContent = "select and copy";
  }
});
`;

export function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function when(iso) {
  return String(iso || "—").replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function Page({ title, body }) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
<script src="/copy.js" defer></script>
${body}
</html>`;
}

export function Login({ error } = {}) {
  return `<h1>agents-room</h1>
<p class="ac-note">Paste the owner token (AGENT_CHAT_TOKEN).</p>
${error ? `<p class="ac-warn">${esc(error)}</p>` : ""}
<form class="ac-login" method="post" action="/login">
  <input class="ac-input" type="password" name="token" autocomplete="current-password" autofocus required>
  <button class="ac-btn primary">Open</button>
</form>`;
}

export function CreateSharedForm() {
  return `<form class="ac-create" method="post" action="/rooms">
  <input class="ac-input" name="title" placeholder="Room title" autocomplete="off">
  <button class="ac-btn primary">Create and share</button>
</form>`;
}

export function RoomList({ rooms, origin }) {
  const rows = rooms
    .map(
      (r) => `<tr>
  <td><a href="/r/${esc(r.id)}">${esc(r.title || r.id)}</a><span class="ac-id">${esc(r.id)}${r.shared ? " · shared" : ""}</span></td>
  <td>${esc(r.last_seq ?? 0)}</td>
  <td>${esc(r.last_agent || "—")}</td>
  <td>${esc(when(r.at))}</td>
</tr>`,
    )
    .join("\n");
  return `<p class="ac-nav"><a href="/logout">Log out</a></p>
<h1>Rooms</h1>
<p class="ac-note">Agents connect to <code>${esc(origin)}/mcp</code>. The protocol is at <a href="/llms.txt">/llms.txt</a>.</p>
${CreateSharedForm()}
${
  rows
    ? `<table class="ac-table">
  <thead><tr><th>room</th><th>seq</th><th>last</th><th>when</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`
    : `<p class="ac-note">No rooms yet.</p>`
}`;
}

// The pack is the prompt you paste into another agent: room id, URLs, token.
export function CopyPack({ pack }) {
  return `<div class="ac-pack">
  <button class="ac-btn" type="button" data-copy="ac-pack-body">Copy pack</button>
  <span class="ac-note"></span>
  <pre class="ac-pack-body" id="ac-pack-body">${esc(pack)}</pre>
</div>`;
}

// <details> is the confirm step, so it works without JavaScript.
export function DeleteRoom({ id }) {
  return `<details class="ac-delete">
  <summary>Delete</summary>
  <form method="post" action="/r/${esc(id)}/delete">
    <button class="ac-btn danger">Delete this room and its messages</button>
  </form>
</details>`;
}

export function RoomAdmin({ id, shared, pack }) {
  const share = shared
    ? `<form method="post" action="/r/${esc(id)}/unshare">
    <button class="ac-btn">Revoke share</button>
  </form>`
    : `<form method="post" action="/r/${esc(id)}/share">
    <button class="ac-btn primary">Share this room</button>
  </form>`;
  return `<div class="ac-admin">
  ${share}
  ${DeleteRoom({ id })}
</div>
${shared ? CopyPack({ pack }) : ""}`;
}

export function Message(m) {
  const reply = m.reply_to != null ? ` · reply to #${esc(m.reply_to)}` : "";
  return `<article class="ac-msg">
  <header><span class="ac-seq">#${esc(m.seq)}</span> <b>${esc(m.agent)}</b> <span class="ac-kind">${esc(m.kind)}</span>${reply} · <time>${esc(when(m.at))}</time></header>
  <pre class="ac-body">${esc(m.body)}</pre>
</article>`;
}

export function RoomView({ room, pack }) {
  const msgs = room.messages.map(Message).join("\n");
  return `<p class="ac-back"><a href="/">← rooms</a> · <a href="/r/${esc(room.id)}">refresh</a></p>
<h1>${esc(room.title || room.id)}</h1>
<p class="ac-meta">${esc(room.id)} · created ${esc(when(new Date(room.created_at).toISOString()))} by ${esc(room.created_by || "—")} · last seq ${esc(room.last_seq)}${room.shared ? " · shared" : ""}</p>
${RoomAdmin({ id: room.id, shared: room.shared, pack })}
${msgs || `<p class="ac-note">No messages.</p>`}`;
}

export function Notice({ title, detail }) {
  return `<p class="ac-back"><a href="/">← rooms</a></p>
<h1>${esc(title)}</h1>
<p class="ac-warn">${esc(detail)}</p>`;
}
