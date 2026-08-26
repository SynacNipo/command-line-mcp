import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { z } from "zod";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { provider, authorizationServerMetadata, protectedResourceMetadata } from "./oauthProvider.js";

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_TIMEOUT = Number(process.env.CMD_TIMEOUT_MS) || 120000;
const MAX_BUFFER = Number(process.env.CMD_MAX_BUFFER) || 4 * 1024 * 1024;

const app = express();
app.use(express.json());

// --- OAuth 2.1 authorization server (Dynamic Client Registration + PKCE) ---
app.use("/authorize", authorizationHandler({ provider }));
app.use("/token", tokenHandler({ provider }));
app.use("/register", clientRegistrationHandler({ clientsStore: provider.clientsStore }));

// Authorization server metadata (RFC 8414) — derived from the request host so it
// works behind a changing tunnel URL.
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.set("Cache-Control", "no-store").json(authorizationServerMetadata(req));
});
// Protected resource metadata (RFC 9728)
app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
  res.set("Cache-Control", "no-store").json(protectedResourceMetadata(req));
});

function buildServer() {
  const server = new McpServer({
    name: "command-line-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "run_command",
    {
      title: "Run Command",
      description:
        "Execute a shell command on the host system and return its standard output and standard error. " +
        "Supports pipes, redirection and shell built-ins. Be careful: this runs with the privileges of the user running the server.",
      inputSchema: {
        command: z
          .string()
          .min(1)
          .describe("The shell command to execute, e.g. 'ls -la' or 'git status'."),
        cwd: z
          .string()
          .optional()
          .describe("Working directory to run the command in. Defaults to the server's current directory."),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Hard timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT}.`),
      },
    },
    async ({ command, cwd, timeout_ms }) => {
      const timeout = Math.min(timeout_ms || DEFAULT_TIMEOUT, 600000);
      const result = await new Promise((resolve) => {
        const child = exec(
          command,
          { cwd, timeout, maxBuffer: MAX_BUFFER, windowsHide: true },
          (err, stdout, stderr) => {
            const exitCode = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
            const killed = !!(err && err.killed);
            const timedOut = !!(err && err.signal === "SIGTERM");
            resolve({
              stdout: stdout || "",
              stderr: stderr || "",
              exit_code: exitCode,
              killed,
              timed_out: timedOut,
            });
          }
        );
        child.on("error", (spawnErr) => {
          resolve({
            stdout: "",
            stderr: `Failed to spawn command: ${spawnErr.message}`,
            exit_code: 1,
            killed: false,
            timed_out: false,
          });
        });
      });

      const parts = [
        `exit_code: ${result.exit_code}`,
        result.timed_out ? "status: timed out (killed)" : result.killed ? "status: killed" : "status: completed",
        "--- stdout ---",
        result.stdout.trimEnd(),
        "--- stderr ---",
        result.stderr.trimEnd(),
      ];

      return {
        content: [
          {
            type: "text",
            text: parts.join("\n"),
          },
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
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (req, res) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.delete("/mcp", async (req, res) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, name: "command-line-mcp", id: randomUUID() });
});

app.listen(PORT, () => {
  console.log(`command-line-mcp listening on http://localhost:${PORT}/mcp`);
});
