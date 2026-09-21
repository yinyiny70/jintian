"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ROOT, git, tryGit, line, rule, ensureIdentity } = require("./git-common");

async function main() {
  line("");
  rule("=");
  line("   给「今天」建一个 Git 存档仓库");
  rule("=");
  line("");

  const version = tryGit(["--version"]);
  if (!version.ok) {
    line("  [×] 没找到 git 命令。");
    line("      请先确认 Git 装好了，然后再双击一次这个文件。");
    line("");
    return 1;
  }
  line("  [√] 找到 Git：" + version.out);
  line("");

  await ensureIdentity();
  line("");

  if (fs.existsSync(path.join(ROOT, ".git"))) {
    line("  [√] 这个文件夹已经是 Git 仓库了");
  } else {
    line("  正在创建仓库 ...");
    git(["init", "-b", "main"]);
    line("  [√] 仓库建好了");
  }

  line("");
  line("  正在把文件纳入版本管理 ...");
  git(["add", "-A"]);

  line("  正在做第一个存档点 ...");
  let committed = true;
  try {
    git(["commit", "-m", "第一版：今天 App 完成，61 项测试全过"]);
  } catch (err) {
    committed = false;
  }

  line("");
  if (committed) {
    rule("=");
    line("   完成！这是现在的存档列表：");
    rule("=");
  } else {
    line("  没有新东西要存档（可能之前已经存过了）。现有存档：");
  }
  try {
    git(["log", "--oneline"]);
  } catch (err) {
    line("  （还没有任何存档）");
  }
  line("");
  line("  工作区状态（下面是空的，就说明全部已存档）：");
  try {
    git(["status", "--short"]);
  } catch (err) {
    /* 忽略 */
  }
  line("");
  line("  以后想留个存档点，双击文件夹里的「保存版本.bat」。");
  line("");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    line("");
    line("  [×] 出错了：" + (err && err.message ? err.message : String(err)));
    line("");
    line("  常见原因和处理办法：");
    line("  1. 这个文件夹里的 .git 有问题");
    line("     → 把 .git 文件夹整个删掉（它现在还是空的，删了没有任何损失），再双击一次");
    line("  2. git 本身没配好");
    line("     → 把上面的报错内容截图发给 Codex");
    line("");
    process.exit(1);
  });
