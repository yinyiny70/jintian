"use strict";
/* ============================================================
   把后端代码（server/worker.js）整段放进剪贴板。
   这样部署的时候不用手动全选、也不怕漏掉开头结尾。
   ============================================================ */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const FILE = path.join(ROOT, "server", "worker.js");

function runPS(script, extraEnv) {
  return execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " + script,
    ],
    {
      env: Object.assign({}, process.env, { JINTIAN_FILE: FILE }, extraEnv || {}),
      encoding: "utf8",
    }
  );
}

function main() {
  let code;
  try {
    code = fs.readFileSync(FILE, "utf8");
  } catch (err) {
    console.log("[×] 找不到后端代码：" + FILE);
    return 1;
  }

  try {
    runPS("Set-Clipboard -Value ([IO.File]::ReadAllText($env:JINTIAN_FILE, [Text.Encoding]::UTF8))");
  } catch (err) {
    console.log("[×] 复制失败：" + String(err.message || err).split("\n")[0]);
    console.log("    （可以把这一行截图发给 Codex）");
    return 1;
  }

  // 再读回来对一遍，确认中文和内容都在
  let back = "";
  try {
    back = runPS("Get-Clipboard -Raw");
  } catch (err) {
    back = "";
  }
  const norm = (s) => String(s).replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const same = norm(back) === norm(code);
  const lines = code.split("\n").length;

  console.log("");
  console.log("[√] 后端代码已经复制好了（共 " + lines + " 行）。");
  console.log(same ? "    机器核对过内容，一模一样。" : "    （内容核对有出入，但复制动作已完成）");
  console.log("");
  console.log("接下来：");
  console.log("  1. 打开 Cloudflare 里那个 Worker 的编辑页面");
  console.log("  2. 在代码框里点一下，按 Ctrl+A 全选，再按 Ctrl+V 粘贴");
  console.log("  3. 点右上角的「部署 / Deploy」");
  console.log("");
  return 0;
}

process.exit(main());
