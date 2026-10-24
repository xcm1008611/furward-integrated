import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("请先安装 Node.js 24 LTS，再运行自托管版本。");
const envFile = resolve(projectRoot, ".env.production");
if (existsSync(envFile)) process.loadEnvFile(envFile);
// Next's standalone server changes cwd. Resolve the persistent directory FIRST.
process.env.DATA_DIR = resolve(projectRoot, process.env.DATA_DIR || "./data");
process.env.NEXT_TELEMETRY_DISABLED ||= "1";
