"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ROOT, git, tryGit, line, rule, makeAsker, ensureIdentity } = require("./git-common");

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
    line("");
    line("  [×] 出错了：" + (err && err.message ? err.message : String(err)));
    line("      把上面的报错内容截图发给 Codex。");
    line("");
    process.exit(1);
  });
