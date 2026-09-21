"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  ROOT,
  git,
  tryGit,
  line,
  rule,
  makeAsker,
  ensureIdentity,
  fixDubiousOwnership,
} = require("./git-common");

async function main() {
  line("");
  rule("=");
  line("   给「今天」留一个存档点");
  rule("=");
  line("");

  if (!tryGit(["--version"]).ok) {
    line("  [×] 没找到 git 命令。");
    line("");
    return 1;
  }

  if (!fs.existsSync(path.join(ROOT, ".git"))) {
    line("  [×] 这个文件夹还不是 Git 仓库。");
    line("      请先双击「初始化Git仓库.bat」。");
    line("");
    return 1;
  }

  if (fixDubiousOwnership()) {
    line("  [√] 已把这个目录登记为「可信目录」");
    line("      （这个文件夹的所有者不是我，Git 默认会拒绝操作，登记一次即可）");
    line("");
  }

  await ensureIdentity();
  line("");

  const asker = makeAsker();
  const answer = await asker.ask("  这次改了什么？（直接回车 ＝ 日常存档）：");
  asker.close();
  const message = answer || "日常存档";
  line("");

  line("  正在把改动纳入版本管理 ...");
  git(["add", "-A"]);

  let committed = true;
  try {
    git(["commit", "-m", message]);
  } catch (err) {
    committed = false;
  }

  line("");
  if (committed) {
    rule("=");
    line("   已存档。最近的存档点：");
    rule("=");
  } else {
    line("  没有新改动要存档。最近的存档点：");
  }
  try {
    git(["log", "--oneline", "-8"]);
  } catch (err) {
    line("  （还没有任何存档）");
  }
  line("");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const text = String((err && err.message) || err);
    line("");
    line("  [×] 出错了：");
    line("      " + text.split("\n")[0]);
    line("");
    if (text.indexOf("dubious ownership") !== -1) {
      line("  原因：这个文件夹的所有者不是你，Git 默认不信任它。");
      line("  处理：手动跑一次下面这行，然后再双击一次这个文件 ——");
      line("      git config --global --add safe.directory \"" + ROOT.replace(/\\/g, "/") + "\"");
    } else {
      line("  把上面这段内容截图发给 Codex，我来处理。");
    }
    line("");
    process.exit(1);
  });
