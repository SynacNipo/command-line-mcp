// Cloudflare Worker: stable public MCP front-end for the local Command-Line server.
// A local agent (agent.js) opens a WebSocket to /agent?secret=... and the Worker
// relays all other HTTP traffic to it. Without an attached, secret-authenticated
// agent, the endpoint returns 503 — so it cannot be operated by anyone but you.

export class AgentHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.agent = null;            // WebSocket to the local agent
    this.pending = new Map();     // request id -> { resolve, reject }
    this.counter = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("upgrade") === "websocket" && url.pathname === "/agent") {
      return this.handleAgent(request, url);
    }

    if (!this.agent || this.agent.readyState !== 1) {
      return new Response("No agent connected. Start agent.js on your machine with the secret.", { status: 503 });
    }

    const id = ++this.counter;
    const headers = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    let body = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = await request.text();
    }

    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    try {
      this.agent.send(JSON.stringify({
        id, method: request.method, path: url.pathname + url.search, headers, body,
      }));
    } catch (e) {
      this.pending.delete(id);
      return new Response("Agent send failed: " + e.message, { status: 502 });
    }

    const timer = setTimeout(() => {
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        p.reject(new Error("agent timeout"));
      }
    }, 300000);

    try {
      const res = await promise;
      clearTimeout(timer);
      return new Response(res.body ?? "", { status: res.status, headers: res.headers || {} });
    } catch (e) {
      return new Response("Agent error: " + e.message, { status: 502 });
    }
  }

  handleAgent(request, url) {
    const secret = url.searchParams.get("secret");
    if (!secret || secret !== this.env.PROXY_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    const pair = new WebSocketPair();
    const [client, server] = pair;
    this.agent = server;
    server.accept();

    server.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "response" && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve({ status: msg.status, headers: msg.headers || {}, body: msg.body });
        }
      } catch {
        /* ignore malformed */
      }
    });
    server.addEventListener("close", () => { this.agent = null; });
    server.addEventListener("error", () => { this.agent = null; });

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const id = env.AGENT.idFromName("singleton");
    return env.AGENT.get(id).fetch(request);
  },
};
