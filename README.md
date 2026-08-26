# Command-Line MCP Server

A remote [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a
single tool, `run_command`, allowing Claude (via the Claude Desktop **Connectors** feature)
to execute shell commands on the machine running this server.

The server implements OAuth 2.1 (Dynamic Client Registration + PKCE) because Claude Desktop
connectors **require** an OAuth handshake — a connector with no auth server is rejected at
sign-in. This server auto-approves authorization (no user prompt), which is fine for a
personal, tunnel-exposed server.

> ⚠️ **Security warning**: Anyone who can reach this server and complete the (automatic) OAuth
> flow can run arbitrary commands as the user running it. Only expose it through a private
> tunnel (cloudflared / ngrok) and never on a public network.

## How it works

- Transport: **Streamable HTTP** (the transport Claude Desktop connectors require).
- Stateless: every request spins up a fresh server/transport instance (no session store needed).
- Endpoint: `POST /mcp`
- Health check: `GET /health`

## Tools

### `run_command`
Execute a shell command. On Windows the default shell is `cmd.exe` (use `dir`, `cd`, not `ls`/`pwd`) unless you pass `shell: "powershell"`.

| Parameter    | Type   | Required | Description                                                        |
| ------------ | ------ | -------- | ------------------------------------------------------------------ |
| `command`    | string | yes      | The shell command to run.                                          |
| `cwd`        | string | no       | Working directory.                                                 |
| `timeout_ms` | number | no       | Hard timeout (max 600000). Default 120000.                         |
| `shell`      | string | no       | `"cmd"` (default) or `"powershell"`.                               |

### `get_info`
Returns OS, architecture, default shell (`cmd.exe` on Windows), and current working directory — call once so the client knows which shell to use.

### `read_file`
Read a text file (optional `offset`/`limit` line range). `path` is absolute or relative to cwd.

### `list_files`
List a directory. `recursive: true` walks the tree (depth-limited to 4).

### `edit_file`
Exact string replace — the preferred way to edit code (no shell escaping needed).
`path`, `old_text`, `new_text`, optional `replace_all`. `old_text` must be unique unless `replace_all` is set. Returns a short diff.

### `apply_patch`
Apply a unified diff via `git apply` (with a `--3way` fallback). `cwd` = repo root, `patch` = diff text.

### `write_file`
Write full content to a file (`overwrite`, or `append`).

### `batch_read`
Read several files in one call. `files`: array of `{ path, offset?, limit? }`.

### `batch_edit`
Apply many exact-text edits across one or more files in a single call. **Transactional**: every `old_text` is validated before any file is written, so a missing/ambiguous match aborts the whole batch (nothing changes). Each edit: `{ path, old_text, new_text, replace_all? }`.

### Native git passthrough
`git_status` (`-sb`), `git_diff` (`staged` + `paths` options), `git_log` (`max_count`, `revision`), `git_show` (`revision`). Each takes an optional `cwd`.

> All file paths are resolved on the host running the server — they point at **this machine**, not Claude's sandbox.

## Run locally

```bash
npm install
npm start
# server listens on http://localhost:3000/mcp
```

Optional env vars: `PORT`, `CMD_TIMEOUT_MS`, `CMD_MAX_BUFFER`.

`npm start` runs `start.js`, which frees port 3000 (kills any process holding it)
before launching the server, so you never hit `EADDRINUSE`.

## Expose it to Claude Desktop

### Option A — Cloudflare Worker (stable URL, no trycloudflare, no domain needed)

A small local **agent** keeps a WebSocket open to a Cloudflare Worker, which becomes
your stable public `*.workers.dev` MCP endpoint. The Worker only relays to your
machine while the agent (authenticated with `PROXY_SECRET`) is connected.

1. `wrangler login` (free Cloudflare account).
2. Deploy: `wrangler deploy` → note your URL, e.g.
   `https://command-line-mcp.<subdomain>.workers.dev`.
3. Set the secret (same value already in your gitignored `.dev.vars`):
   `wrangler secret put PROXY_SECRET` (paste the `PROXY_SECRET` from `.dev.vars`).
4. Point the agent at the deployed Worker: set `WORKER_URL` in `.dev.vars` to that URL.
5. On your machine, run both:
   ```bash
   npm start          # the MCP server on :3000
   npm run agent      # connects to the Worker with the secret
   ```
6. In Claude Desktop: **Customize → Connectors → Add custom connector**, paste
   `https://command-line-mcp.<subdomain>.workers.dev/mcp`.

Local testing without deploying: `wrangler dev --port 8787` (Worker on :8787),
then `npm run agent` — the agent reads `WORKER_URL` from `.dev.vars`.

### Option B — cloudflared / ngrok tunnel (ephemeral URL)

Claude Desktop connectors need an **HTTPS** URL, so run the server locally and tunnel it:

```bash
cloudflared tunnel --url http://localhost:3000 --protocol http2
# or: ngrok http 3000
```

Copy the generated `https://…` URL and append `/mcp`, e.g.
`https://abc-123.trycloudflare.com/mcp`.

## Add to Claude Desktop

1. Open **Customize → Connectors → Add custom connector**.
2. Paste the URL (with `/mcp`), e.g. the Worker URL from Option A.
3. Name it **Command-Line**.
4. Save. Claude discovers the OAuth metadata, registers a client, and opens a browser to
   the (auto-approving) authorize endpoint, then redirects back and is ready. No "OAuth
   Client ID" needs to be entered manually — DCR handles it.

## Testing without Claude

Use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector):

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: http://localhost:3000/mcp
```

## Hardening (for non-personal use)

OAuth is already implemented (see `oauthProvider.js`). For anything beyond a personal
tunnel you should:

1. Replace the auto-approve `authorize()` with a real consent screen, or at least an
   allow-listed set of redirect URIs / clients.
2. Persist clients/tokens (currently in-memory — they reset on restart).
3. Host behind a stable HTTPS domain (e.g. a VPS, Cloudflare Workers, Fly.io).
4. Consider an allow-list of permitted commands to limit blast radius.

## License

MIT
