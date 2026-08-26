import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { z } from "zod";
import { exec, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import os from "node:os";
import { provider, authorizationServerMetadata, protectedResourceMetadata } from "./oauthProvider.js";

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_TIMEOUT = Number(process.env.CMD_TIMEOUT_MS) || 120000;
const MAX_BUFFER = Number(process.env.CMD_MAX_BUFFER) || 8 * 1024 * 1024;

const app = express();
app.use(express.json());

// --- OAuth 2.1 authorization server (Dynamic Client Registration + PKCE) ---
app.use("/authorize", authorizationHandler({ provider }));
app.use("/token", tokenHandler({ provider }));
app.use("/register", clientRegistrationHandler({ clientsStore: provider.clientsStore }));

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.set("Cache-Control", "no-store").json(authorizationServerMetadata(req));
});
app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
  res.set("Cache-Control", "no-store").json(protectedResourceMetadata(req));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCommand(command, opts = {}) {
  const { cwd, timeout_ms, shell } = opts;
  const timeout = Math.min(timeout_ms || DEFAULT_TIMEOUT, 600000);
  return new Promise((resolve) => {
    const cb = (err, stdout, stderr) => {
      const exitCode = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({
        stdout: stdout || "",
        stderr: stderr || "",
        exit_code: exitCode,
        killed: !!(err && err.killed),
        timed_out: !!(err && err.signal === "SIGTERM"),
      });
    };
    let child;
    if (shell === "powershell") {
      child = execFile("powershell", ["-NoProfile", "-Command", command], {
        cwd, timeout, maxBuffer: MAX_BUFFER, windowsHide: true,
      }, cb);
    } else {
      child = exec(command, { cwd, timeout, maxBuffer: MAX_BUFFER, windowsHide: true }, cb);
    }
    child.on("error", (spawnErr) => {
      resolve({
        stdout: "",
        stderr: `Failed to spawn command: ${spawnErr.message}`,
        exit_code: 1, killed: false, timed_out: false,
      });
    });
  });
}

function git(args, cwd) {
  return new Promise((resolve) => {
    const child = execFile("git", ["-C", cwd || process.cwd(), ...args], {
      maxBuffer: MAX_BUFFER, windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || "",
        stderr: stderr || "",
        exit_code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
      });
    });
    child.on("error", (e) => resolve({ stdout: "", stderr: `git error: ${e.message}`, exit_code: 1 }));
  });
}

function resolvePath(path, base) {
  return isAbsolute(path) ? path : resolve(base || process.cwd(), path);
}

function formatCommandResult(r) {
  const parts = [
    `exit_code: ${r.exit_code}`,
    r.timed_out ? "status: timed out (killed)" : r.killed ? "status: killed" : "status: completed",
    "--- stdout ---",
    r.stdout.trimEnd(),
    "--- stderr ---",
    r.stderr.trimEnd(),
  ];
  return parts.join("\n");
}

function shortDiff(oldText, newText, maxLines = 6) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const lines = [];
  oldLines.slice(0, maxLines).forEach((l) => lines.push(`- ${l}`));
  newLines.slice(0, maxLines).forEach((l) => lines.push(`+ ${l}`));
  if (oldLines.length > maxLines || newLines.length > maxLines) {
    lines.push(`(… truncated; ${oldLines.length} removed / ${newLines.length} added lines)`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MCP server (stateless: fresh instance per request)
// ---------------------------------------------------------------------------

function buildServer() {
  const server = new McpServer({
    name: "command-line-mcp",
    version: "1.1.0",
  });

  // --- Environment info (so the client learns the shell/OS up front) ---
  server.registerTool(
    "get_info",
    {
      title: "Get Environment Info",
      description: "Report the host OS, default shell, and current working directory. Call this once at the start so you know whether to use cmd.exe or PowerShell.",
      inputSchema: {},
    },
    async () => {
      const info = {
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        default_cwd: process.cwd(),
        default_shell: os.platform() === "win32" ? "cmd.exe" : "/bin/sh",
        shell_hint: "run_command accepts a 'shell' parameter: 'cmd' (default on Windows) or 'powershell'. Use 'powershell' for PowerShell syntax.",
        node_version: process.version,
      };
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }
  );

  // --- Run a shell command ---
  server.registerTool(
    "run_command",
    {
      title: "Run Command",
      description:
        "Execute a shell command on the host and return stdout/stderr/exit code. " +
        "On Windows the default shell is cmd.exe (so use 'dir', 'cd', not 'ls'/'pwd') unless you pass shell:'powershell'.",
      inputSchema: {
        command: z.string().min(1).describe("The command to execute."),
        cwd: z.string().optional().describe("Working directory."),
        timeout_ms: z.number().int().positive().optional().describe(`Hard timeout (max 600000). Default ${DEFAULT_TIMEOUT}.`),
        shell: z.enum(["cmd", "powershell"]).optional().describe("Which shell to use. Default 'cmd' (Windows) / system shell. Use 'powershell' for PowerShell."),
      },
    },
    async ({ command, cwd, timeout_ms, shell }) => {
      const r = await runCommand(command, { cwd, timeout_ms, shell });
      return { content: [{ type: "text", text: formatCommandResult(r) }] };
    }
  );

  // --- Read a file ---
  server.registerTool(
    "read_file",
    {
      title: "Read File",
      description: "Read a text file from the host. Optionally a line range (1-based).",
      inputSchema: {
        path: z.string().describe("File path (absolute or relative to cwd)."),
        offset: z.number().int().positive().optional().describe("1-based start line."),
        limit: z.number().int().positive().optional().describe("Max number of lines to return."),
      },
    },
    async ({ path, offset, limit }) => {
      const full = resolvePath(path);
      const content = await readFile(full, "utf8");
      const lines = content.split("\n");
      const start = offset ? offset - 1 : 0;
      const slice = lines.slice(start, limit ? start + limit : undefined);
      return {
        content: [{ type: "text", text: `// ${full} (${lines.length} lines)\n` + slice.join("\n") }],
      };
    }
  );

  // --- List files / directory tree ---
  server.registerTool(
    "list_files",
    {
      title: "List Files",
      description: "List files in a directory. Set recursive to walk the tree (depth-limited to 4).",
      inputSchema: {
        path: z.string().optional().describe("Directory path. Defaults to cwd."),
        recursive: z.boolean().optional().describe("Walk subdirectories. Default false."),
      },
    },
    async ({ path, recursive }) => {
      const base = path ? resolvePath(path) : process.cwd();
      const entries = [];
      const walk = async (dir, depth) => {
        const items = await readdir(dir, { withFileTypes: true });
        for (const it of items) {
          const p = join(dir, it.name);
          entries.push((it.isDirectory() ? "[D] " : "[F] ") + p);
          if (recursive && it.isDirectory() && depth < 4) await walk(p, depth + 1);
        }
      };
      await walk(base, 0);
      return { content: [{ type: "text", text: entries.join("\n") }] };
    }
  );

  // --- Edit a file (exact string replace, like an IDE find/replace) ---
  server.registerTool(
    "edit_file",
    {
      title: "Edit File",
      description:
        "Replace exact text in a file. old_text must appear exactly once unless replace_all is true. " +
        "This is the preferred way to make code edits — far more reliable than shell string manipulation.",
      inputSchema: {
        path: z.string().describe("File path to edit."),
        old_text: z.string().min(1).describe("Exact text to find."),
        new_text: z.string().describe("Replacement text."),
        replace_all: z.boolean().optional().describe("Replace every occurrence. Default false."),
      },
    },
    async ({ path, old_text, new_text, replace_all }) => {
      const full = resolvePath(path);
      const content = await readFile(full, "utf8");
      let newContent;
      let count;
      if (replace_all) {
        const parts = content.split(old_text);
        count = parts.length - 1;
        if (count === 0) throw new Error("old_text not found in file.");
        newContent = parts.join(new_text);
      } else {
        const idx = content.indexOf(old_text);
        if (idx === -1) throw new Error("old_text not found in file.");
        const second = content.indexOf(old_text, idx + old_text.length);
        if (second !== -1) {
          throw new Error("old_text appears more than once. Make it unique or set replace_all=true.");
        }
        newContent = content.slice(0, idx) + new_text + content.slice(idx + old_text.length);
        count = 1;
      }
      await writeFile(full, newContent, "utf8");
      return {
        content: [
          { type: "text", text: `Edited ${full}\nReplacements: ${count}\n\n${shortDiff(old_text, new_text)}` },
        ],
      };
    }
  );

  // --- Apply a unified diff patch (via git apply) ---
  server.registerTool(
    "apply_patch",
    {
      title: "Apply Patch",
      description:
        "Apply a unified diff to a git repository using 'git apply'. The patch must be a standard unified diff. " +
        "Run inside the repo root (set cwd). Returns git's output or error.",
      inputSchema: {
        cwd: z.string().optional().describe("Repository root. Defaults to server cwd."),
        patch: z.string().describe("Unified diff text to apply."),
      },
    },
    async ({ cwd, patch }) => {
      const tmp = join(os.tmpdir(), `mcp-patch-${randomUUID()}.diff`);
      await writeFile(tmp, patch, "utf8");
      const r = await git(["apply", "--whitespace=nowarn", tmp], cwd);
      if (r.exit_code !== 0) {
        const r2 = await git(["apply", "--3way", "--whitespace=nowarn", tmp], cwd);
        if (r2.exit_code === 0) {
          return { content: [{ type: "text", text: `Applied with --3way.\n${r2.stdout}${r2.stderr}` }] };
        }
        throw new Error(`git apply failed:\n${r.stderr || r.stdout}\n\n(also tried --3way)`);
      }
      return { content: [{ type: "text", text: `Patch applied.\n${r.stdout}${r.stderr}` }] };
    }
  );

  // --- Native git passthrough ---
  server.registerTool(
    "git_status",
    {
      title: "Git Status",
      description: "Run 'git status' (short form) in a repo.",
      inputSchema: { cwd: z.string().optional().describe("Repository root.") },
    },
    async ({ cwd }) => {
      const r = await git(["status", "-sb"], cwd);
      return { content: [{ type: "text", text: r.stderr || r.stdout || "(clean)" }] };
    }
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git Diff",
      description: "Show a git diff. Pass staged:true for the index, or paths to limit scope.",
      inputSchema: {
        cwd: z.string().optional().describe("Repository root."),
        staged: z.boolean().optional().describe("Show staged changes (git diff --cached)."),
        paths: z.array(z.string()).optional().describe("Optional path(s) to limit the diff."),
      },
    },
    async ({ cwd, staged, paths }) => {
      const args = ["diff"];
      if (staged) args.push("--cached");
      if (paths && paths.length) args.push("--", ...paths);
      const r = await git(args, cwd);
      return { content: [{ type: "text", text: r.stdout || "(no diff)" }] };
    }
  );

  server.registerTool(
    "git_log",
    {
      title: "Git Log",
      description: "Show commit history (oneline).",
      inputSchema: {
        cwd: z.string().optional().describe("Repository root."),
        max_count: z.number().int().positive().optional().describe("Number of commits. Default 10."),
        revision: z.string().optional().describe("Revision range, e.g. 'HEAD~5..HEAD'."),
      },
    },
    async ({ cwd, max_count, revision }) => {
      const args = ["log", "--oneline", "-n", String(max_count || 10)];
      if (revision) args.push(revision);
      const r = await git(args, cwd);
      return { content: [{ type: "text", text: r.stdout || "(no history)" }] };
    }
  );

  server.registerTool(
    "git_show",
    {
      title: "Git Show",
      description: "Show a commit, file at a revision, or a full diff for a revision.",
      inputSchema: {
        cwd: z.string().optional().describe("Repository root."),
        revision: z.string().describe("Commit hash, branch, tag, or 'rev:path'."),
      },
    },
    async ({ cwd, revision }) => {
      const r = await git(["show", revision], cwd);
      return { content: [{ type: "text", text: r.stdout || r.stderr || "(empty)" }] };
    }
  );

  // --- Write a whole file (create or overwrite) ---
  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description: "Write full text content to a file (creates or overwrites). Use mode:'append' to add to the end.",
      inputSchema: {
        path: z.string().describe("File path to write."),
        content: z.string().describe("Text content."),
        mode: z.enum(["overwrite", "append"]).optional().describe("Default 'overwrite'."),
      },
    },
    async ({ path, content, mode }) => {
      const full = resolvePath(path);
      if (mode === "append") {
        const existing = await readFile(full, "utf8").catch(() => "");
        await writeFile(full, existing + content, "utf8");
      } else {
        await writeFile(full, content, "utf8");
      }
      return { content: [{ type: "text", text: `Wrote ${full} (${content.split("\n").length} lines, mode=${mode || "overwrite"})` }] };
    }
  );

  // --- Batch read multiple files in one call ---
  server.registerTool(
    "batch_read",
    {
      title: "Batch Read Files",
      description: "Read several files at once. Each entry: { path, offset?, limit? }. Returns each file labeled.",
      inputSchema: {
        files: z.array(z.object({
          path: z.string(),
          offset: z.number().int().positive().optional(),
          limit: z.number().int().positive().optional(),
        })).min(1).describe("Files to read."),
      },
    },
    async ({ files }) => {
      const blocks = [];
      for (const f of files) {
        const full = resolvePath(f.path);
        const content = await readFile(full, "utf8");
        const lines = content.split("\n");
        const start = f.offset ? f.offset - 1 : 0;
        const slice = lines.slice(start, f.limit ? start + f.limit : undefined);
        blocks.push(`===== ${f.path} (${lines.length} lines) =====\n` + slice.join("\n"));
      }
      return { content: [{ type: "text", text: blocks.join("\n\n") }] };
    }
  );

  // --- Batch edit multiple files (transactional: all-or-nothing) ---
  server.registerTool(
    "batch_edit",
    {
      title: "Batch Edit Files",
      description:
        "Apply multiple exact-text edits across one or more files in a single call. " +
        "All edits are validated before any file is written — if one old_text is missing or ambiguous, nothing is changed. " +
        "Each edit: { path, old_text, new_text, replace_all? }.",
      inputSchema: {
        edits: z.array(z.object({
          path: z.string(),
          old_text: z.string().min(1),
          new_text: z.string(),
          replace_all: z.boolean().optional(),
        })).min(1).describe("Edits to apply."),
      },
    },
    async ({ edits }) => {
      // Group edits by resolved path
      const byPath = new Map();
      for (const e of edits) {
        const full = resolvePath(e.path);
        if (!byPath.has(full)) byPath.set(full, []);
        byPath.get(full).push(e);
      }
      const results = [];
      // Validate + compute everything BEFORE writing (transactional)
      const pending = new Map();
      for (const [full, fileEdits] of byPath) {
        let content = await readFile(full, "utf8");
        const original = content;
        for (const e of fileEdits) {
          if (e.replace_all) {
            const parts = content.split(e.old_text);
            if (parts.length - 1 === 0) throw new Error(`old_text not found in ${full}`);
            content = parts.join(e.new_text);
          } else {
            const idx = content.indexOf(e.old_text);
            if (idx === -1) throw new Error(`old_text not found in ${full}`);
            if (content.indexOf(e.old_text, idx + e.old_text.length) !== -1) {
              throw new Error(`old_text is ambiguous in ${full}; make it unique or set replace_all`);
            }
            content = content.slice(0, idx) + e.new_text + content.slice(idx + e.old_text.length);
          }
          results.push(`--- ${full} ---\n${shortDiff(e.old_text, e.new_text)}`);
        }
        pending.set(full, { original, content });
      }
      // All validated: write
      for (const [full, { content }] of pending) {
        await writeFile(full, content, "utf8");
      }
      return { content: [{ type: "text", text: `Applied ${edits.length} edit(s) across ${byPath.size} file(s).\n\n` + results.join("\n") }] };
    }
  );

  // --- Pull a file from a remote URL onto the host disk ---
  server.registerTool(
    "pull_file",
    {
      title: "Pull File",
      description:
        "Download a file from a remote http(s) URL and save it onto the host disk (Claude's working disk). " +
        "Use this to bring a file from the user/remote into the local workspace so it can be read or edited. " +
        "By default it refuses to overwrite an existing destination unless overwrite:true.",
      inputSchema: {
        url: z.string().url().describe("Remote http(s) URL of the file to pull."),
        destination: z.string().describe("Local path (absolute or relative to cwd) to write the file."),
        overwrite: z.boolean().optional().describe("Replace an existing file. Default false."),
      },
    },
    async ({ url, destination, overwrite }) => {
      const dest = resolvePath(destination);
      if (!overwrite) {
        const exists = await stat(dest).catch(() => null);
        if (exists) throw new Error(`Destination already exists: ${dest}. Pass overwrite:true to replace it.`);
      }
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Pull failed: HTTP ${resp.status} ${resp.statusText} for ${url}`);
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      await writeFile(dest, buf);
      return {
        content: [
          { type: "text", text: `Pulled ${url}\nSaved to ${dest}\nBytes: ${buf.length}` },
        ],
      };
    }
  );

  // --- Push a local file back to a remote URL ---
  server.registerTool(
    "push_file",
    {
      title: "Push File",
      description:
        "Read a local file from the host disk and upload it to a remote http(s) URL (PUT by default) so the " +
        "user/remote receives the modified version. Use this after editing a pulled file to push changes back. " +
        "method defaults to PUT; set method:'POST' if the endpoint expects a POST upload.",
      inputSchema: {
        source: z.string().describe("Local file path to read and push."),
        url: z.string().url().describe("Remote http(s) URL to upload the file to."),
        method: z.enum(["PUT", "POST"]).optional().describe("HTTP method. Default 'PUT'."),
        content_type: z.string().optional().describe("Content-Type header (e.g. 'application/json')."),
      },
    },
    async ({ source, url, method, content_type }) => {
      const src = resolvePath(source);
      const buf = await readFile(src);
      const headers = {};
      if (content_type) headers["Content-Type"] = content_type;
      const resp = await fetch(url, { method: method || "PUT", body: buf, headers });
      const text = await resp.text().catch(() => "");
      if (!resp.ok) {
        throw new Error(`Push failed: HTTP ${resp.status} ${resp.statusText}\n${text}`);
      }
      return {
        content: [
          { type: "text", text: `Pushed ${src} -> ${url}\nHTTP ${resp.status} ${resp.statusText}\n${text}` },
        ],
      };
    }
  );

  return server;
}

app.post(
  "/mcp",
  requireBearerAuth({
    verifier: provider,
    requiredScopes: ["command-line"],
    resourceMetadataUrl: "/.well-known/oauth-protected-resource/mcp",
  }),
  async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  }
);

app.get("/mcp", async (req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});
app.delete("/mcp", async (req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
});
app.get("/health", (_req, res) => {
  res.json({ ok: true, name: "command-line-mcp", id: randomUUID() });
});

app.listen(PORT, () => {
  console.log(`command-line-mcp listening on http://localhost:${PORT}/mcp`);
});
