#!/usr/bin/env node
/** No dependencies: can also run inside the official Node 24 Docker image. */
import { randomBytes, pbkdf2Sync } from "node:crypto";
import { access, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";

function argumentsFor(argv) {
  const options = { output: resolve(".env.production"), credentials: resolve(".admin-credentials"), generate: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--generate") options.generate = true;
    else if (arg === "--output" || arg === "--credentials-file") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${arg} 后面需要填写文件路径。`);
      options[arg === "--output" ? "output" : "credentials"] = resolve(argv[++i]);
    } else throw new Error("支持参数：--generate、--output <环境文件路径>、--credentials-file <密码文件路径>。");
  }
  if (options.output === options.credentials) throw new Error("环境配置和密码信息需要使用不同的文件路径。");
  return options;
}
async function ensureNew(path) {
  try { await access(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error(`文件已存在，为避免覆盖已停止：${path}\n需要换密码时，请先备份并移走原配置，再重新运行。`);
}
function hiddenQuestion(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolveInput, reject) => {
    let value = "";
    const wasRaw = !!process.stdin.isRaw;
    emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
    const finish = () => { process.stdin.off("keypress", handler); process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stdout.write("\n"); };
    const handler = (character, key = {}) => {
      if (key.ctrl && key.name === "c") { finish(); reject(new Error("已取消，未保存配置。")); }
      else if (key.name === "return" || key.name === "enter") { finish(); resolveInput(value); }
      else if (key.name === "backspace") value = Array.from(value).slice(0, -1).join("");
      else if (character && !key.ctrl && !key.meta && !/[\r\n\u0000-\u001f\u007f]/.test(character)) value += character;
    };
    process.stdin.on("keypress", handler);
  });
}
async function writePrivateNew(path, value) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(value); await file.chmod(0o600); } finally { await file.close(); }
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  await ensureNew(options.output); await ensureNew(options.credentials);
  let password;
  if (options.generate) password = randomBytes(24).toString("base64url");
  else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("交互设置需要终端；自动生成请添加 --generate。密码不会打印到日志。");
    process.stdout.write("设置网站后台密码（输入时不会回显）。\n");
    password = await hiddenQuestion("输入至少 12 个字符的密码；直接回车则自动生成：");
    if (!password) password = randomBytes(24).toString("base64url");
    else {
      if (password.length < 12 || password.length > 256) throw new Error("密码需为 12–256 个字符，请重新运行设置。");
      if (password !== await hiddenQuestion("请再次输入密码：")) throw new Error("两次密码不一致，请重新运行设置。");
    }
  }
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, 600000, 32, "sha256");
  const passwordHash = `pbkdf2-sha256:600000:${salt.toString("base64url")}:${hash.toString("base64url")}`;
  const secret = randomBytes(32).toString("base64url");
  await writePrivateNew(options.output, `# Private deployment configuration; never commit or share.\nADMIN_PASSWORD_HASH='${passwordHash}'\nADMIN_SESSION_SECRET='${secret}'\n`);
  try {
    await writePrivateNew(options.credentials, `网站后台登录信息（仅供你本人保存，请勿公开分享）\n\n后台地址：你的网站域名/admin\n后台密码：${password}\n\n不需要 ChatGPT 账号。请把密码保存在密码管理器，之后可以删除本文件。\n环境文件：${options.output}\n重设密码会使旧登录失效。\n`);
  } catch (error) { await unlink(options.output); throw error; }
  process.stdout.write(`\n后台配置已生成。\n环境文件：${options.output}\n密码信息：${options.credentials}\n两个文件仅允许当前用户读写。密码没有打印到日志。\n启动或重启网站后，打开 /admin 登录。\n`);
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
