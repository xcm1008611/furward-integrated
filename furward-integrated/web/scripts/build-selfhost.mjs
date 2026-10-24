import { projectRoot } from "./selfhost-env.mjs";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const result = spawnSync(process.execPath, [resolve(projectRoot, "node_modules/next/dist/bin/next"), "build", "--webpack"], { cwd: projectRoot, stdio: "inherit", env: process.env });
if (result.status !== 0) process.exit(result.status || 1);
const output = resolve(projectRoot, ".next/standalone");
// Next traces local env files into standalone; configuration belongs on the
// destination server, never in the distributable build or Docker image.
for (const name of readdirSync(output)) if (name.startsWith(".env")) rmSync(resolve(output, name), { force: true });
for (const [from, to] of [["public", "public"], [".next/static", ".next/static"]]) cpSync(resolve(projectRoot, from), resolve(output, to), { recursive: true });
// Keep offline backup/restore and password setup available in the small runtime image.
for (const folder of ["lib", "scripts"]) mkdirSync(resolve(output, folder), { recursive: true });
for (const file of ["content.ts", "furward-v2-defaults.ts", "furward-migration.ts", "legacy-content.ts", "editorial-defaults.ts", "cms-validation.ts", "cms-store-node.ts", "selfhost-database.mjs"]) cpSync(resolve(projectRoot, "lib", file), resolve(output, "lib", file));
for (const file of ["furward-migrate.mjs", "selfhost-env.mjs", "selfhost-loader.mjs", "selfhost-backup.mjs", "selfhost-restore.mjs", "setup-admin.mjs"]) cpSync(resolve(projectRoot, "scripts", file), resolve(output, "scripts", file));
console.log("自托管生产版本已生成，运行 npm run start:selfhost。");
