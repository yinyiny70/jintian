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
const SITE_FILES = ["index.html", "styles.css", "app.js", "quotes.js", "config.js", "favicon.svg"];
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

// 把用户粘进来的东西整理成一个干净的仓库地址。
// 能手打当然好，但用户名里少个字母、多个空格、把 Markdown 链接一起粘进来，
// 都会让 GitHub 回一句「找不到仓库」，很难自己看出来。所以这里统一擦干净。
function normalizeRepoUrl(raw) {
  let s = String(raw || "").trim();
  const md = s.match(/\]\((https?:\/\/[^)\s]+)\)/);
  if (md) s = md[1];
  s = s.replace(/^[<\["'（(]+/, "").replace(/[>\]"'）)，。;；,]+$/, "").trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
  s = s.replace(/\/+$/, ""); // 先把末尾的斜杠去掉，再判断有没有 .git
  if (!/\.git$/i.test(s)) s += ".git";
  return s;
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
    line("  请先在 GitHub 网站上有一个**空仓库**：");
    line("    GitHub → 右上角 + → New repository → 名字填 jintian");
    line("    ⚠️ 不要勾选 Add a README / .gitignore / license，保持空仓库");
    line("");
    line("  然后**照抄地址**，别手打（用户名少一个字母就会失败）：");
    line("    在仓库页面点绿色的 Code 按钮 → 选 HTTPS → 复制那一行");
    rule("-");
    line("");
    const answer = await asker.ask("  粘贴仓库地址（长这样 https://github.com/用户名/jintian.git）：");
    if (!String(answer).trim()) {
      asker.close();
      line("");
      line("  [×] 地址没填，先不折腾了。想好了再双击一次这个文件。");
      line("");
      return 1;
    }
    const url = normalizeRepoUrl(answer);
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
    line("      请核对一下：这段地址和你在 GitHub 上复制的那行一模一样吗？");
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
    line("      最常见的原因是**地址打错了**——用户名差一个字母、或者大小写不对");
    line("      （GitHub 的用户名里大小写和拼写都要一模一样）。");
    line("");
    line("      另外两种可能：");
    line("      1. GitHub 上还没建这个仓库；");
    line("      2. 浏览器里登录的不是这个账号，或者登录没走完。");
    line("");
    line("  建议：回 GitHub 仓库页面点绿色 Code 按钮 → 复制 HTTPS 那一行 → 粘贴到这里。");
    line("");
    const fix = await asker.ask("  要现在改地址重试吗？（回车 ＝ 改；输 n ＝ 先不改）：");
    if (String(fix).trim().toLowerCase() === "n") break;
    const pasted = await asker.ask("  粘贴正确的仓库地址：");
    if (!String(pasted).trim()) break;
    const url = normalizeRepoUrl(pasted);
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
