"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const h = require("./helper");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// 用本地小服务把同一份代码跑起来。原因：浏览器不允许 file:// 页面使用它自己的
// 文件系统（备份功能要用），所以测备份相关的部分时改用 http://127.0.0.1。
function serveApp(rootDir) {
  const fixtures = path.join(rootDir, "tests", "fixtures");
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const clean = decodeURIComponent(String(req.url).split("?")[0]);
      const isFixture = clean.indexOf("/__fixtures/") === 0;
      const target = isFixture
        ? path.join(fixtures, clean.slice("/__fixtures/".length))
        : path.join(rootDir, clean === "/" ? "index.html" : clean);
      const base = isFixture ? fixtures : rootDir;
      if (!target.startsWith(base)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      fs.readFile(target, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "Content-Type": MIME[path.extname(target)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));

function discover() {
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => /^phase\d+.*\.js$/.test(f))
    .sort((a, b) => parseInt(a.match(/^phase(\d+)/)[1], 10) - parseInt(b.match(/^phase(\d+)/)[1], 10));
  return files.map((f) => {
    const mod = require(path.join(__dirname, f));
    return { file: f, phase: mod.phase, title: mod.title, tests: mod.tests };
  });
}

async function main() {
  const suites = discover();
  const selected = only.length
    ? suites.filter((s) => only.some((o) => String(s.phase) === o || s.file.includes(o)))
    : suites;

  if (!selected.length) {
    console.error("没有找到要运行的测试。");
    process.exit(2);
  }

  const { chromium } = h.loadPlaywright();
  const browserPath = h.findBrowser();
  const profile = h.tempProfile("main");
  const server = await serveApp(h.ROOT);
  const httpUrl = "http://127.0.0.1:" + server.address().port + "/index.html";
  const httpProbeUrl = "http://127.0.0.1:" + server.address().port + "/__fixtures/probe.html";
  const launchOptions = {
    executablePath: browserPath,
    viewport: { width: 1180, height: 900 },
  };
  // 用「持久化的浏览器资料目录」，这样测试才能验证「关掉浏览器再打开，数据还在」
  const holder = { context: await chromium.launchPersistentContext(profile, launchOptions) };

  async function relaunch() {
    await holder.context.close().catch(() => {});
    holder.context = await chromium.launchPersistentContext(profile, launchOptions);
  }

  const results = [];
  let pass = 0;
  let fail = 0;

  const makeCtx = (page, extra) =>
    Object.assign(
      {
        page,
        get context() { return holder.context; },
        root: h.ROOT,
        appUrl: h.toFileUrl(h.APP_HTML),
        httpUrl,
        httpProbeUrl,
        fileUrl: h.toFileUrl,
        sleep: h.sleep,
        assert: h.assert,
        openApp: async (url) => h.openApp(page, url),
        openAppPage: async () => {
          const p = await holder.context.newPage();
          await h.openApp(p);
          return p;
        },
        relaunch,
      },
      extra || {}
    );

  for (const suite of selected) {
    console.log("");
    console.log(`第 ${suite.phase} 阶段 · ${suite.title}   (${suite.file})`);
    for (const t of suite.tests) {
      const page = await holder.context.newPage();
      const ctx = makeCtx(page, { newPage: () => holder.context.newPage() });
      let status = "通过";
      let error = null;
      const started = Date.now();
      try {
        await t.run(ctx);
      } catch (err) {
        status = "失败";
        error = err;
        try {
          const dir = path.join(__dirname, "_failures");
          fs.mkdirSync(dir, { recursive: true });
          const shot = path.join(dir, "第" + suite.phase + "阶段-" + t.name.replace(/[^\u4e00-\u9fa5\w-]/g, "_").slice(0, 60) + ".png");
          await page.screenshot({ path: shot });
          const state = await page.evaluate(() => ({
            overlay: document.getElementById("overlay") ? document.getElementById("overlay").hidden : "无",
            dialogs: Array.prototype.map
              .call(document.querySelectorAll(".dialog"), (d) => d.id + (d.hidden ? ":关" : ":开"))
              .join(" "),
            page: document.getElementById("app") ? document.getElementById("app").dataset.page : "无",
            storage: localStorage.getItem("jintian.v1") ? "有数据" : "空",
            dialogLog: (window.__dialogLog || []).join(" → "),
          }));
          console.log("      现场截图: " + shot);
          console.log("      页面状态: " + JSON.stringify(state));
        } catch (e) {
          /* 快照失败不影响测试结果 */
        }
      } finally {
        await page.close().catch(() => {});
      }
      const ms = Date.now() - started;
      if (status === "通过") {
        pass++;
        console.log(`  ✓ ${t.name}  (${ms}ms)`);
      } else {
        fail++;
        console.log(`  ✗ ${t.name}  (${ms}ms)`);
        console.log(
          "      " + String(error && error.message ? error.message : error).split("\n").join("\n      ")
        );
      }
      results.push({ phase: suite.phase, name: t.name, status, ms });
    }
  }

  await holder.context.close().catch(() => {});
  await new Promise((r) => server.close(r));

  console.log("");
  console.log("──────────────────────────────────────────");
  console.log(`合计 ${results.length} 项：通过 ${pass}，失败 ${fail}`);
  if (fail > 0) {
    console.log("");
    console.log("失败的项：");
    results.filter((r) => r.status === "失败").forEach((r) => console.log(`  - 第 ${r.phase} 阶段 · ${r.name}`));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("测试执行器崩溃：" + err.message);
  process.exit(2);
});
