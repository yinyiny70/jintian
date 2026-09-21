"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ROOT, line, rule } = require("./git-common");

const LINK_NAME = "今天.lnk";

// 用 PowerShell 的 -EncodedCommand 传脚本，这样中文路径不会被编码问题搞坏
function runPowerShell(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

async function main() {
  line("");
  rule("=");
  line("   在桌面上放一个「今天」");
  rule("=");
  line("");

  const target = path.join(ROOT, "index.html");
  if (!fs.existsSync(target)) {
    line("  [×] 没找到 App 本体：" + target);
    line("      这一份好像不完整，把这句话截图发给 Codex。");
    line("");
    return 1;
  }

  // 桌面位置由系统自己回答，不写死路径
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    "if ([string]::IsNullOrWhiteSpace($desktop)) { throw '桌面路径为空' }",
    "$link = Join-Path $desktop '" + LINK_NAME + "'",
    "$ws = New-Object -ComObject WScript.Shell",
    "$sc = $ws.CreateShortcut($link)",
    "$sc.TargetPath = '" + target + "'",
    "$sc.WorkingDirectory = '" + ROOT + "'",
    "$sc.Description = '今天 · 每日计划与计时'",
    "$sc.Save()",
    "$chk = (New-Object -ComObject WScript.Shell).CreateShortcut($link)",
    "Write-Output ('OK|' + $link + '|' + $chk.TargetPath)",
  ].join("\n");

  let out = "";
  try {
    out = String(runPowerShell(script)).trim();
  } catch (err) {
    const detail = err && err.stderr ? String(err.stderr).trim() : "";
    line("  [×] 创建失败：" + (err && err.message ? err.message.split("\n")[0] : String(err)));
    if (detail) line("      " + detail);
    line("");
    line("  你也可以自己手动做，三步：");
    line("    1. 在桌面空白处右键 → 新建 → 快捷方式");
    line("    2. 位置填这一行：");
    line("       " + target);
    line("    3. 名字写「今天」，完成");
    line("");
    return 1;
  }

  const parts = out.split("|");
  const link = parts[1] || "";
  const resolved = parts[2] || "";

  if (parts[0] !== "OK" || !link || !fs.existsSync(link)) {
    line("  [×] 系统说创建完成了，但我在桌面找不到它。");
    line("      请把这段内容截图发给 Codex：");
    line("      " + out);
    line("");
    return 1;
  }

  if (path.resolve(resolved).toLowerCase() !== path.resolve(target).toLowerCase()) {
    line("  [×] 快捷方式指向的不是这个 App，请告知 Codex。");
    line("      实际指向：" + resolved);
    line("");
    return 1;
  }

  line("  [√] 已经放在你的桌面上：");
  line("      " + link);
  line("");
  line("  [√] 它指向的是：");
  line("      " + resolved);
  line("");
  line("  现在回到桌面，双击那个叫「今天」的图标就能用了。");
  line("  右键它选「固定到任务栏」，以后一点就开，更省事。");
  line("");
  line("  注意：桌面上的图标只是一个「入口」，App 本体还是在");
  line("      " + ROOT);
  line("  这个文件夹里（它在 C 盘，不是你桌面上那个文件夹）。");
  line("");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    line("");
    line("  [×] 出错了：" + (err && err.message ? err.message : String(err)));
    line("      把这段截图发给 Codex。");
    line("");
    process.exit(1);
  });
