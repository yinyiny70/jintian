"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
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

// 对外发布只用到这 4 个文件；其他东西（文档、测试、Git 历史）都不上传
const SITE_FILES = ["index.html", "styles.css", "app.js", "favicon.svg"];
const SITE_DIR = "网页版";

function refreshSiteFolder() {
  const dir = path.join(ROOT, SITE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const copied = [];
  SITE_FILES.forEach(function (name) {
    const from = path.join(ROOT, name);
    if (!fs.existsSync(from)) return;
    fs.copyFileSync(from, path.join(dir, name));
    copied.push(name);
  });
  return copied;
}

// 推送这一步既要让你实时看到输出（比如"请在浏览器里完成登录"），
// 又要把输出内容留下来，好在失败时判断到底是哪种原因。
// 所以这里用 spawn 边打边存。
function gitStreaming(args) {
  return new Promise(function (resolve) {
    const child = spawn("git", args, { cwd: ROOT, stdio: ["inherit", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", function (chunk) {
      const s = chunk.toString("utf8");
      text += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", function (chunk) {
      const s = chunk.toString("utf8");
      text += s;
      process.stderr.write(s);
    });
    child.on("close", function (code) {
      resolve({ ok: code === 0, text: text });
    });
    child.on("error", function (err) {
      resolve({ ok: false, text: String((err && err.message) || err) });
    });
  });
}

async function main() {
  line("");
  rule("=");
  line("   发布到网上（推到 GitHub）");
  rule("=");
  line("");

  if (!tryGit(["--version"]).ok) {
    line("  [×] 没找到 git 命令。");
    line("");
    return 1;
  }
  if (!fs.existsSync(path.join(ROOT, ".git"))) {
    line("  [×] 这个文件夹还不是 Git 仓库，先双击「初始化Git仓库.bat」。");
    line("");
    return 1;
  }
  fixDubiousOwnership();

  const asker = makeAsker();
  await ensureIdentity();
  line("");

  // ---------- 1. 有没有关联 GitHub 仓库 ----------
  let remote = tryGit(["remote", "get-url", "origin"]).out;
  if (!remote) {
    rule("-");
    line("  还差一步：这个项目还没有关联 GitHub 仓库。");
    line("");
    line("  请先在 GitHub 网站上建一个**空仓库**（Private 私有就行）：");
    line("    GitHub → 右上角 + → New repository → 名字填 jintian");
    line("    ⚠️ 不要勾选 Add a README / .gitignore / license，保持空仓库");
    line("");
    line("  建好之后，把下面两样告诉我（填在这里）：");
    rule("-");
    line("");
    const user = await asker.ask("  你的 GitHub 用户名：");
    const repo = (await asker.ask("  仓库名（直接回车 ＝ jintian）：")) || "jintian";
    if (!user) {
      asker.close();
      line("");
      line("  [×] 用户名没填，先不折腾了。想好了再双击一次这个文件。");
      line("");
      return 1;
    }
    const url = "https://github.com/" + user.trim() + "/" + repo.trim() + ".git";
    try {
      git(["remote", "add", "origin", url]);
    } catch (err) {
      asker.close();
      line("");
      line("  [×] 关联失败：" + (err && err.message ? err.message.split("\n")[0] : String(err)));
      line("");
      return 1;
    }
    line("");
    line("  [√] 已关联：" + url);
    remote = url;
  } else {
    line("  [√] 已关联仓库：" + remote);
  }

  // ---------- 2. 更新要发布的那 4 个文件 ----------
  const copied = refreshSiteFolder();
  line("  [√] 已更新 " + SITE_DIR + " 文件夹（" + copied.join("、") + "）");
  line("");

  // ---------- 3. 存档 ----------
  const message = (await asker.ask("  这次改了什么？（直接回车 ＝ 日常更新）：")) || "日常更新";
  line("");

  git(["add", "-A"]);
  let committed = true;
  try {
    git(["commit", "-m", message]);
  } catch (err) {
    committed = false;
  }
  line(committed ? "  [√] 已存档" : "  [·] 没有新改动，直接推送");

  // ---------- 4. 推上去 ----------
  line("");
  line("  正在推送到 GitHub ...");
  line("  （第一次会让你在浏览器里登录 GitHub，登录一次以后就免了）");
  line("");

  let pushed = false;
  let failure = "";
  for (let attempt = 1; attempt <= 2 && !pushed; attempt++) {
    const result = await gitStreaming(["push", "-u", "origin", "HEAD"]);
    if (result.ok) {
      pushed = true;
      break;
    }
    failure = result.text || "";
    // 「找不到仓库」是最常见的一种：要么仓库没建，要么地址填错。
    // 这种可以当场问一次，改完地址直接重试，不用关窗口重来。
    const notFound = /not found|does not exist|does not appear to be a git repository|仓库不存在/i.test(failure);
    if (!notFound || attempt === 2) break;

    line("");
    line("  [×] GitHub 说找不到这个仓库：");
    line("      " + remote);
    line("");
    line("      三种可能：");
    line("      1. GitHub 上还没建这个仓库；");
    line("      2. 上面地址里的用户名或仓库名不对；");
    line("      3. 浏览器里登录的不是这个账号，或者登录没走完 ——");
    line("         这种直接重试一次就能过。");
    line("");
    const fix = await asker.ask("  要现在改地址重试吗？（回车 ＝ 改；输 n ＝ 先不改）：");
    if (String(fix).trim().toLowerCase() === "n") break;
    const user = await asker.ask("  你的 GitHub 用户名：");
    const repo = (await asker.ask("  仓库名（直接回车 ＝ jintian）：")) || "jintian";
    if (!String(user).trim()) break;
    const url = "https://github.com/" + String(user).trim() + "/" + String(repo).trim() + ".git";
    try {
      git(["remote", "set-url", "origin", url]);
    } catch (setErr) {
      break;
    }
    remote = url;
    line("");
    line("  [√] 已改成：" + url + "，再试一次 ...");
    line("");
  }

  if (!pushed) {
    asker.close();
    line("");
    line("  [×] 还是没推上去。");
    line("");
    line("  请先确认两件事，然后再双击一次这个文件：");
    line("    1. 登录 github.com，看仓库列表里有没有 jintian");
    line("       （没有就点右上角 + → New repository 建一个空仓库）");
    line("    2. 点右上角头像，看登录的账号名是不是你告诉我的那个");
    line("");
    line("  还不行就把这段截图发给 Codex。");
    line("");
    return 1;
  }
  asker.close();

  line("");
  rule("=");
  line("   推送成功！");
  rule("=");
  line("");
  line("  Cloudflare 那边如果已经接好这个仓库，网站会在一两分钟内自动更新。");
  line("  以后每次想更新网站，只要：改完 → 双击本文件 → 等一两分钟。");
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
      line("  处理：手动跑一次下面这行，然后再双击一次这个文件 ——");
      line("      git config --global --add safe.directory \"" + ROOT.replace(/\\/g, "/") + "\"");
    } else {
      line("  把上面这段内容截图发给 Codex，我来处理。");
    }
    line("");
    process.exit(1);
  });
