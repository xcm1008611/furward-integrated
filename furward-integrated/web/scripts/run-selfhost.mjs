import { projectRoot } from "./selfhost-env.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const mode = process.argv[2] || "start";
let args;
if (mode === "dev") {
  args = [resolve(projectRoot, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", process.env.BIND_ADDRESS || "127.0.0.1", ...process.argv.slice(3)];
} else if (mode === "start") {
  if (process.argv.length > 3) throw new Error("生产启动使用环境变量，例如 PORT=3001 BIND_ADDRESS=0.0.0.0 npm run start:selfhost；不接受命令行参数。");
  const entry = resolve(projectRoot, ".next/standalone/server.js");
  if (!existsSync(entry)) throw new Error("还没有生产版本，请先运行 npm run build:selfhost。");
  process.env.HOSTNAME = process.env.BIND_ADDRESS || "127.0.0.1";
  args = [entry];
} else throw new Error("Unknown self-host mode.");
const child = spawn(process.execPath, args, { cwd: projectRoot, env: process.env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
