"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..");
const APP_HTML = path.join(ROOT, "index.html");
const FIXTURES = path.join(__dirname, "fixtures");

const PLAYWRIGHT_HINTS = [
  "playwright",
  "C:/Users/Lenovo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
];

function loadPlaywright() {
  const tried = [];
  for (const hint of PLAYWRIGHT_HINTS) {
    try {
      return require(hint);
    } catch (err) {
      tried.push("  " + hint + "  ->  " + err.message.split("\n")[0]);
    }
  }
  throw new Error("找不到浏览器驱动。试过：\n" + tried.join("\n"));
}

const EDGE_HINTS = [
  process.env.GOING_EDGE,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].filter(Boolean);

function findBrowser() {
  for (const p of EDGE_HINTS) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function toFileUrl(p) {
  const norm = path.resolve(p).replace(/\\/g, "/");
  return (
    "file:///" +
    norm
      .split("/")
      .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)))
      .join("/")
  );
}

function tempProfile(name) {
  const dir = path.join(os.tmpdir(), "going-tests-" + (name || "default"));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 第一次打开时会引导设置备份文件，测试里先跳过它
async function dismissBackupPrompt(page) {
  const btn = await page.waitForSelector('[data-act="backup-later"]', { timeout: 800 }).catch(() => null);
  if (btn) await btn.click().catch(() => {});
}

async function openApp(page, url) {
  await page.goto(url || toFileUrl(APP_HTML), { waitUntil: "load" });
  await page.waitForSelector("#app");
  await dismissBackupPrompt(page);
}

// 把"这台测试电脑"上的 App 数据清空，回到全新状态。
// 注意顺序：一定要先离开 App 那个页面再清。
// App 里对"页面要关了"有一个保存动作（不然关掉页面时正在计时的时间会丢），
// 所以在 App 页面上直接清，一导航它就把内存里的旧数据又写回去了。
async function freshState(page) {
  await page.goto(toFileUrl(path.join(FIXTURES, "probe.html")), { waitUntil: "load" });
  await page.evaluate(() => localStorage.clear());
  await page.goto(toFileUrl(APP_HTML), { waitUntil: "load" });
  await page.waitForSelector("#app");
  await dismissBackupPrompt(page);
}

// 第三版起：添加任务只写名字（不再填预估时长），预估改成在任务行上设置。
// 下面两个函数让测试继续走真实的界面路径。
async function setEstimateOfLast(page, est) {
  const id = await page.evaluate(() => {
    const j = window.__jintian;
    const list = j.state.tasks[j.todayKey()];
    return list.length ? list[list.length - 1].id : null;
  });
  if (!id) throw new Error("列表里还没有任务，设不了预估");
  await page.click('.task[data-id="' + id + '"] [data-act="edit"]');
  await page.fill('[data-est-input="' + id + '"]', String(est));
  await page.click('[data-act="edit-done"]');
}

async function addTask(page, name, est) {
  await page.click('.nav-item[data-goto="plan"]');
  await page.fill("#new-name", name);
  await page.click('[data-act="add"]');
  if (est) await setEstimateOfLast(page, est);
}

function fail(message) {
  throw new Error(message);
}

const assert = {
  ok(value, message) {
    if (!value) fail(message || "期望为真，实际为 " + JSON.stringify(value));
  },
  eq(actual, expected, message) {
    if (actual !== expected) {
      fail(
        (message || "两个值不相等") +
          "\n      实际: " +
          JSON.stringify(actual) +
          "\n      期望: " +
          JSON.stringify(expected)
      );
    }
  },
  near(actual, expected, tolerance, message) {
    if (Math.abs(actual - expected) > tolerance) {
      fail(
        (message || "两个值相差过大") +
          "\n      实际: " +
          actual +
          "\n      期望: " +
          expected +
          " (±" +
          tolerance +
          ")"
      );
    }
  },
  includes(haystack, needle, message) {
    if (String(haystack).indexOf(needle) === -1) {
      fail(
        (message || "没有找到期望的内容") +
          "\n      期望包含: " +
          JSON.stringify(needle) +
          "\n      实际内容: " +
          JSON.stringify(String(haystack).slice(0, 300))
      );
    }
  },
  notIncludes(haystack, needle, message) {
    if (String(haystack).indexOf(needle) !== -1) {
      fail(
        (message || "不该出现的内容出现了") +
          "\n      不该包含: " +
          JSON.stringify(needle)
      );
    }
  },
};

module.exports = {
  ROOT,
  APP_HTML,
  FIXTURES,
  loadPlaywright,
  findBrowser,
  toFileUrl,
  tempProfile,
  sleep,
  openApp,
  freshState,
  dismissBackupPrompt,
  addTask,
  setEstimateOfLast,
  assert,
};
