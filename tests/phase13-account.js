"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const h = require("./helper");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};
// 起一个「和线上一样」的服务器：静态文件 + /api 都由它提供。
// 线上是 Cloudflare Worker，这里是本机 HTTP 服务，但跑的是同一份后端代码，
// 所以测的是真实逻辑，不是假装。
async function startServer() {
  const worker = await import(pathToFileURL(path.join(h.ROOT, "server", "worker.js")).href);
  const memory = await import(pathToFileURL(path.join(h.ROOT, "server", "store-memory.js")).href);
  const store = memory.makeMemoryStore();
  const server = http.createServer(async (req, res) => {
    if (req.url.indexOf("/api/") === 0) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const request = new Request("http://127.0.0.1" + req.url, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" || !body.length ? undefined : body,
      });
      const response = await worker.handle(request, store);
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const name = decodeURIComponent(req.url.split("?")[0]).replace(/^\//, "") || "index.html";
    const file = path.join(h.ROOT, name);
    if (!file.startsWith(h.ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, store, base: "http://127.0.0.1:" + server.address().port };
}
async function api(base, pathname, options) {
  const opts = options || {};
  const res = await fetch(base + pathname, {
    method: opts.method || "GET",
    headers: Object.assign({ "Content-Type": "application/json" }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function freshDevice(page, url) {
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(() => localStorage.clear());
  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector("#app");
  await h.dismissBackupPrompt(page);
}
async function login(page, name, pass, isRegister) {
  // 登录成功会自动收窗；失败时它开着，所以这里判断一下再决定要不要点开
  if (!(await page.isVisible("#dialog-account"))) {
    await page.click("#account-chip");
    await page.waitForSelector("#dialog-account", { state: "visible" });
  }
  await page.fill("#account-name", name);
  await page.fill("#account-pass", pass);
  await page.click(isRegister ? '[data-act="account-register"]' : '[data-act="account-login"]');
}
function taskNamesOf(page) {
  return page.$$eval(".task .task-name", (els) => els.map((e) => e.textContent.trim()));
}
module.exports = {
  phase: 13,
  title: "第三版 · 账号与云同步",
  tests: [
    {
      name: "注册账号：云端是空的、本机有记录时，会问你一句要不要传上去",
      async run(ctx) {
        const api1 = await startServer();
        try {
          await freshDevice(ctx.page, api1.base + "/index.html");
          await h.addTask(ctx.page, "写季度总结", 40);
          await ctx.sleep(500);
          await login(ctx.page, "yinyin", "abc12345", true);
          await ctx.page.waitForSelector("#dialog-confirm", { state: "visible", timeout: 5000 });
          ctx.assert.includes(
            await ctx.page.textContent("#confirm-body"),
            "本机",
            "没有问「要不要把本机记录传上去」"
          );
          await ctx.page.click('[data-act="confirm-ok"]');
          await ctx.sleep(1500);
          const seen = await api(api1.base, "/api/login", {
            method: "POST",
            body: { username: "yinyin", password: "abc12345" },
          });
          ctx.assert.eq(seen.status, 200, "登录接口没通");
          ctx.assert.ok(seen.body.data, "云端还没有数据");
          ctx.assert.includes(JSON.stringify(seen.body.data), "写季度总结", "本机记录没有传上去");
          await ctx.page.click("#account-chip");
          await ctx.page.waitForSelector("#dialog-account", { state: "visible" });
          ctx.assert.includes(await ctx.page.textContent("#account-status"), "yinyin", "没有显示已登录的用户名");
          await ctx.page.click('[data-act="account-close"]');
        } finally {
          api1.server.close();
        }
      },
    },
    {
      name: "换一台电脑：打开同一个网址、登录同一个账号，就看到同样的记录",
      async run(ctx) {
        const api1 = await startServer();
        const { chromium } = h.loadPlaywright();
        let device2 = null;
        try {
          await freshDevice(ctx.page, api1.base + "/index.html");
          await login(ctx.page, "yinyin", "abc12345", true);
          await ctx.sleep(800);
          await h.addTask(ctx.page, "读 30 页书", 45);
          await ctx.sleep(3200);
          const onCloud = await api(api1.base, "/api/login", {
            method: "POST",
            body: { username: "yinyin", password: "abc12345" },
          });
          ctx.assert.includes(
            JSON.stringify(onCloud.body.data || {}),
            "读 30 页书",
            "改动没有自动传上去"
          );
          device2 = await chromium.launchPersistentContext(h.tempProfile("phase13-device2"), {
            executablePath: h.findBrowser(),
            viewport: { width: 1200, height: 820 },
          });
          const page2 = await device2.newPage();
          await freshDevice(page2, api1.base + "/index.html");
          await page2.click('.nav-item[data-goto="plan"]');
          ctx.assert.eq(await page2.$$eval(".task", (els) => els.length), 0, "新电脑一开始应该是空的");
          await login(page2, "yinyin", "abc12345", false);
          await page2.waitForTimeout(1600);
          await page2.click('.nav-item[data-goto="plan"]');
          ctx.assert.eq(
            (await taskNamesOf(page2)).join("/"),
            "读 30 页书",
            "换台电脑登录后没有拿到自己的记录"
          );
        } finally {
          if (device2) await device2.close().catch(() => {});
          api1.server.close();
        }
      },
    },
    {
      name: "密码错、用户名被占用、用户名不合格，都会给人话提示",
      async run(ctx) {
        const api1 = await startServer();
        try {
          await freshDevice(ctx.page, api1.base + "/index.html");
          // 先注册一个账号再退出 —— 登录着的时候界面只显示「已登录」，
          // 要试注册/登录得先退出（这也是正确的产品行为）
          await login(ctx.page, "yinyin", "abc12345", true);
          await ctx.sleep(900);
          await ctx.page.click("#account-chip");
          await ctx.page.click('[data-act="account-logout"]');
          await ctx.sleep(400);
          await ctx.page.click('[data-act="account-close"]');
          await ctx.sleep(200);
          await login(ctx.page, "yinyin", "other999", true);
          await ctx.sleep(800);
          ctx.assert.includes(await ctx.page.textContent("#account-msg"), "已经被用了", "重名注册没有提示");
          await login(ctx.page, "yinyin", "wrongpass", false);
          await ctx.sleep(800);
          ctx.assert.includes(
            await ctx.page.textContent("#account-msg"),
            "用户名或密码不对",
            "密码错没有提示"
          );
          await login(ctx.page, "ab", "abc12345", true);
          await ctx.sleep(800);
          ctx.assert.includes(await ctx.page.textContent("#account-msg"), "用户名", "用户名不合格没有提示");
        } finally {
          api1.server.close();
        }
      },
    },
    {
      name: "退出登录后：本机记录还在，但不再往云端同步",
      async run(ctx) {
        const api1 = await startServer();
        try {
          await freshDevice(ctx.page, api1.base + "/index.html");
          await login(ctx.page, "yinyin", "abc12345", true);
          await ctx.sleep(900);
          await h.addTask(ctx.page, "写季度总结", 40);
          await ctx.sleep(3200);
          await ctx.page.click("#account-chip");
          await ctx.page.click('[data-act="account-logout"]');
          await ctx.sleep(400);
          // 退出后应该回到"填用户名密码"那一面，而不是还显示已登录
          ctx.assert.ok(await ctx.page.isVisible("#account-out"), "退出后没有回到登录界面");
          ctx.assert.eq(await ctx.page.isVisible("#account-in"), false, "退出后还显示着已登录的样子");
          await ctx.page.click('[data-act="account-close"]');
          await h.addTask(ctx.page, "退出之后加的事", 20);
          await ctx.sleep(3200);
          const seen = await api(api1.base, "/api/login", {
            method: "POST",
            body: { username: "yinyin", password: "abc12345" },
          });
          ctx.assert.notIncludes(
            JSON.stringify(seen.body.data || {}),
            "退出之后加的事",
            "退出登录之后还在往云端传"
          );
          await ctx.page.click('.nav-item[data-goto="plan"]');
          ctx.assert.includes(
            (await taskNamesOf(ctx.page)).join("/"),
            "退出之后加的事",
            "退出登录把本机记录弄丢了"
          );
        } finally {
          api1.server.close();
        }
      },
    },
    {
      name: "云端更新过时，本机不会硬盖上去（先问一句，选取消就不动）",
      async run(ctx) {
        const api1 = await startServer();
        try {
          await freshDevice(ctx.page, api1.base + "/index.html");
          await login(ctx.page, "yinyin", "abc12345", true);
          await ctx.sleep(900);
          const logged = await api(api1.base, "/api/login", {
            method: "POST",
            body: { username: "yinyin", password: "abc12345" },
          });
          const token = logged.body.token;
          const today = await ctx.page.evaluate(() => window.__jintian.todayKey());
          await api(api1.base, "/api/data", {
            method: "PUT",
            headers: { Authorization: "Bearer " + token },
            body: {
              data: {
                version: 1,
                tasks: {
                  [today]: [
                    { id: "x1", name: "另一台设备写的事", est: 30, spentSec: 0, done: false, feeling: "" },
                  ],
                },
                summaries: {},
                notes: {},
                timer: null,
                settings: {},
              },
              baseUpdatedAt: logged.body.updatedAt,
            },
          });
          await h.addTask(ctx.page, "本机新加的事", 20);
          await ctx.page.waitForSelector("#dialog-confirm", { state: "visible", timeout: 9000 });
          ctx.assert.includes(await ctx.page.textContent("#confirm-title"), "云端", "冲突时没有提示");
          await ctx.page.click('[data-act="confirm-cancel"]');
          await ctx.sleep(300);
          await ctx.page.click('.nav-item[data-goto="plan"]');
          ctx.assert.includes(
            (await taskNamesOf(ctx.page)).join("/"),
            "本机新加的事",
            "点了取消却把本机改掉了"
          );
          await h.addTask(ctx.page, "再试一次", 10);
          await ctx.page.waitForSelector("#dialog-confirm", { state: "visible", timeout: 9000 });
          await ctx.page.click('[data-act="confirm-ok"]');
          await ctx.sleep(700);
          await ctx.page.click('.nav-item[data-goto="plan"]');
          ctx.assert.eq(
            (await taskNamesOf(ctx.page)).join("/"),
            "另一台设备写的事",
            "选了覆盖却没有用云端的数据"
          );
        } finally {
          api1.server.close();
        }
      },
    },
  ],
};
