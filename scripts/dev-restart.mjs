import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { killPort } from "./lib/dev-utils.mjs";

const port = process.env.PORT ?? "4114";

killPort(port);

const logFd = openSync("dev-server.log", "w");
const child = spawn("npx", ["tsx", "src/index.ts"], {
  detached: true,
  stdio: ["ignore", logFd, logFd],
  env: { ...process.env, PORT: port },
  shell: true,
});
child.unref();

console.log(`Started server on port ${port} (pid ${child.pid}), logging to dev-server.log`);
