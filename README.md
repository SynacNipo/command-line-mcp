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

## Expose it to Claude Desktop (local + tunnel)

Claude Desktop connectors need an **HTTPS** URL, so run the server locally and tunnel it:

```bash
# cloudflared (recommended, free, no account needed for quick tunnel)
cloudflared tunnel --url http://localhost:3000

# or ngrok
ngrok http 3000
```

Copy the generated `https://…` URL and append `/mcp`, e.g.
`https://abc-123.trycloudflare.com/mcp`.

## Add to Claude Desktop

1. Open **Customize → Connectors → Add custom connector**.
2. Paste the tunnel URL (with `/mcp`), e.g. `https://abc-123.trycloudflare.com/mcp`.
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
