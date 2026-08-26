// Local agent: keeps a WebSocket open to the Cloudflare Worker and relays MCP
// traffic to the server running on this machine (http://localhost:3000).
// Run:  node agent.js   (after setting WORKER_URL and PROXY_SECRET in .dev.vars)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ProxyAgent } from "undici";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDevVars() {
  try {
    const txt = readFileSync(join(__dirname, ".dev.vars"), "utf8");
    const out = {};
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (m) {
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        out[m[1]] = val;
      }
    }
    return out;
  } catch {
    return {};
  }
}

const env = { ...loadDevVars(), ...process.env };
const WORKER_URL = env.WORKER_URL;
const SECRET = env.PROXY_SECRET;
const ORIGIN = env.ORIGIN_URL || "http://localhost:3000";

if (!WORKER_URL || !SECRET) {
  console.error("Set WORKER_URL and PROXY_SECRET (in .dev.vars or environment) before starting the agent.");
  process.exit(1);
}

const wsUrl = `${WORKER_URL.replace(/\/$/, "")}/agent?secret=${encodeURIComponent(SECRET)}`;
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const wsOptions = proxy ? { dispatcher: new ProxyAgent(proxy) } : {};
if (proxy) console.log(`[agent] routing WebSocket via proxy ${proxy}`);

let heartbeat;

function connect() {
  const ws = new WebSocket(wsUrl, wsOptions);

  ws.onopen = () => {
    console.log(`[agent] connected to ${WORKER_URL} — relaying to ${ORIGIN}`);
    heartbeat = setInterval(() => {
      try { ws.ping(); } catch { /* ignore */ }
    }, 25000);
  };

  ws.onerror = (e) => console.error("[agent] socket error:", e?.message || e?.error || e);

  ws.onclose = () => {
    clearInterval(heartbeat);
    console.log("[agent] disconnected — retrying in 3s...");
    setTimeout(connect, 3000);
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
    } catch {
      return;
    }
    if (!msg.method) return; // only handle request messages (pings/keepalives ignored)

    try {
      const headers = { ...msg.headers };
      delete headers.host;
      delete headers["content-length"];
      delete headers.connection;
      delete headers["transfer-encoding"];
      const u = new URL(WORKER_URL);
      headers["x-forwarded-host"] = u.host;
      headers["x-forwarded-proto"] = "https";

      const resp = await fetch(ORIGIN + msg.path, {
        method: msg.method,
        headers,
        body: msg.body != null ? msg.body : undefined,
        redirect: "manual",
      });
      const body = await resp.text();
      const out = {};
      resp.headers.forEach((v, k) => { out[k] = v; });
      ws.send(JSON.stringify({ type: "response", id: msg.id, status: resp.status, headers: out, body }));
    } catch (e) {
      ws.send(JSON.stringify({ type: "response", id: msg.id, status: 502, headers: {}, body: `agent error: ${e.message}` }));
    }
  };
}

connect();
