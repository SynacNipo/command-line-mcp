import { spawn, execSync } from "node:child_process";
import { platform } from "node:os";

const PORT = Number(process.env.PORT) || 3000;

function killPort(port) {
  try {
    if (platform === "win32") {
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

setTimeout(() => {
  const child = spawn("node", ["server.js"], { stdio: "inherit", env: process.env });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => { console.error(err); process.exit(1); });
}, 600);
