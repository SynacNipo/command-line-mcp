import { spawn, execSync } from "node:child_process";

const PORT = Number(process.env.PORT) || 3000;
const isWin = process.platform === "win32";

function killPort(port) {
  try {
    if (isWin) {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split("\n")) {
        const m = line.match(new RegExp(`:${port}\\b[^\\d]*(\\d+)\\s*$`));
        if (m) pids.add(m[1]);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`);
          console.log(`[start] killed PID ${pid} holding port ${port}`);
        } catch { /* already gone */ }
      }
    } else {
      execSync(`lsof -ti tcp:${port} | xargs -r kill -9`);
    }
  } catch { /* nothing on the port */ }
}

killPort(PORT);

const children = [];

function spawnChild(cmd, args, name) {
  const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code) => console.log(`[start] ${name} exited (${code})`));
  child.on("error", (err) => console.error(`[start] ${name} error:`, err));
  children.push(child);
  return child;
}

setTimeout(() => {
  spawnChild("node", ["server.js"], "server");
  // give the server a moment to bind before the agent tries to relay to it
  setTimeout(() => {
    spawnChild("node", ["agent.js"], "agent");
  }, 1500);
}, 600);

function shutdown(signal) {
  for (const c of children) {
    try { c.kill(signal); } catch { /* ignore */ }
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
