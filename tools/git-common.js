"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");
const readline = require("node:readline");

const ROOT = path.resolve(__dirname, "..");

// 正常执行：输出直接接到窗口上
function git(args) {
  return execFileSync("git", args, { cwd: ROOT, stdio: "inherit" });
}

// 试探性执行：只要结果，不要它往窗口上打东西
function tryGit(args) {
  try {
    const out = execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: String(out).trim() };
  } catch (err) {
    return { ok: false, out: "", message: String(err && err.message ? err.message : err) };
  }
}

function line(text) {
  process.stdout.write((text == null ? "" : text) + "\n");
}

function rule(char) {
  line((char || "=").repeat(44));
}

// 全程只用一个输入读取器。
// 原因：如果每问一句就新建一个，输入被一次性读进来时，第二句会拿不到内容。
function makeAsker() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question) {
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          // 真实窗口里，你敲的回车会让光标换行；管道输入时不会，补一个
          if (!process.stdout.isTTY) line("");
          resolve(String(answer || "").trim());
        });
      });
    },
    close() {
      rl.close();
    },
  };
}

// 这个文件夹是我在受限制的账号下建的，所以它的「所有者」不是你。
// Git 出于安全会拒绝这种仓库，报 "detected dubious ownership"。
// 官方给的解法就是在配置里把这一个目录列为「可信目录」，等同于你亲口说
// 「这个目录是我自己的，我知道它的来历」。这里自动帮你做掉。
function fixDubiousOwnership() {
  const probe = tryGit(["status", "--short"]);
  if (probe.ok) return false;
  const message = probe.message || "";
  if (message.indexOf("dubious ownership") === -1) return false;
  const target = ROOT.replace(/\\/g, "/");
  const known = tryGit(["config", "--global", "--get-all", "safe.directory"]).out;
  const list = known ? known.split(/\r?\n/).map(function (s) { return s.trim().toLowerCase(); }) : [];
  if (list.indexOf(target.toLowerCase()) === -1) {
    try {
      git(["config", "--global", "--add", "safe.directory", target]);
    } catch (err) {
      return false;
    }
  }
  return tryGit(["status", "--short"]).ok;
}

// 第一次用 Git 时，得先告诉它「你是谁」。
// 两个脚本共用这一段，所以不论是「初始化」还是「保存版本」，
// 只要发现还没配过，都会问你一次。
async function ensureIdentity() {
  const name = tryGit(["config", "--get", "user.name"]).out;
  const email = tryGit(["config", "--get", "user.email"]).out;
  if (name && email) {
    line("  [√] Git 已经知道你是谁：" + name + " <" + email + ">");
    return { name, email };
  }

  rule("-");
  line("  第一次用 Git，需要先告诉它「你是谁」。");
  line("  这两项只写进你自己电脑上的提交记录，");
  line("  不会发给任何人，随便填就行。");
  line("  不想填就直接按回车，用默认值。");
  rule("-");
  line("");

  const asker = makeAsker();
  let finalName = name;
  let finalEmail = email;
  if (!finalName) {
    const input = await asker.ask("  你的名字（回车 ＝ me）：");
    finalName = input || "me";
    git(["config", "--global", "user.name", finalName]);
  }
  if (!finalEmail) {
    const input = await asker.ask("  你的邮箱（回车 ＝ me@local）：");
    finalEmail = input || "me@local";
    git(["config", "--global", "user.email", finalEmail]);
  }
  asker.close();
  line("");
  line("  [√] 记住了：" + finalName + " <" + finalEmail + ">");
  return { name: finalName, email: finalEmail };
}

module.exports = {
  ROOT,
  git,
  tryGit,
  line,
  rule,
  makeAsker,
  ensureIdentity,
  fixDubiousOwnership,
};
