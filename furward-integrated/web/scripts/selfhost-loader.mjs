import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname, extname } from "node:path";

if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("自托管命令需要 Node.js 24 或更新版本。");
const root = fileURLToPath(new URL("../", import.meta.url));
// Node 24 strips TypeScript natively. This small resolver supplies the project's
// @/ and extensionless imports for offline migration and integration tests.
registerHooks({ resolve(specifier, context, nextResolve) {
  let path;
  if (specifier.startsWith("@/")) path = resolve(root, specifier.slice(2));
  else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) path = resolve(dirname(fileURLToPath(context.parentURL)), specifier);
  if (path && !extname(path)) {
    for (const extension of [".ts", ".mts", ".mjs", ".js"]) {
      if (existsSync(path + extension)) return nextResolve(pathToFileURL(path + extension).href, context);
    }
  }
  return nextResolve(specifier, context);
} });
