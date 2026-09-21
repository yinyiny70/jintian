"use strict";

const fs = require("node:fs");
const path = require("node:path");
const h = require("./helper");

// 用 route 拦截，把同一份代码"假扮"成部署在真实域名上的样子。
// 这样测的就是真正的网页版行为，而不是本机地址上的退化行为。
const HOST = "http://going.example";
const FILES = new Set(["index.html", "styles.css", "app.js", "favicon.svg"]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function openWeb(page) {
  await page.route("**/*", (route) => {
    const name = new URL(route.request().url()).pathname.replace(/^\//, "") || "index.html";
    if (!FILES.has(name)) {
      route.fulfill({ status: 404, body: "not found" });
      return;
    }
    route.fulfill({
      status: 200,
      contentType: MIME[path.extname(name)] || "application/octet-stream",
      body: fs.readFileSync(path.join(h.ROOT, name)),
    });
  });
  await page.goto(HOST + "/index.html", { waitUntil: "load" });
  await page.waitForSelector("#app");
}

module.exports = {
  phase: 10,
  title: "网页版（对外发布用）",
  tests: [
    {
      name: "网页版不会一进门就弹「设置备份位置」",
      async run(ctx) {
        await openWeb(ctx.page);
        await ctx.sleep(1000);
        ctx.assert.eq(await ctx.page.isVisible("#dialog-backup"), false, "网页版一打开就弹窗要人选文件");
        ctx.assert.eq(await ctx.page.isVisible("#overlay"), false, "网页版不该出现遮罩");
        ctx.assert.includes(await ctx.page.textContent("#backup-title"), "浏览器", "左下角没有说明数据存在哪");
      },
    },
    {
      name: "网页版首页会说明「数据只存在你这台设备」",
      async run(ctx) {
        await openWeb(ctx.page);
        await ctx.page.click('.nav-item[data-goto="home"]');
        ctx.assert.ok(await ctx.page.isVisible("#web-notice"), "首页没有这句说明");
        ctx.assert.includes(await ctx.page.textContent("#web-notice"), "浏览器");
        // 本机版不显示这句
        const local = await ctx.context.newPage();
        await h.openApp(local);
        await local.click('.nav-item[data-goto="home"]');
        ctx.assert.eq(await local.isVisible("#web-notice"), false, "本机版不该显示网页版说明");
        await local.close();
      },
    },
    {
      name: "网页版核心功能可用：加任务、计时、打勾、写总结，刷新后还在",
      async run(ctx) {
        await openWeb(ctx.page);
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.fill("#new-name", "写季度总结");
        await ctx.page.fill("#new-est", "40");
        await ctx.page.click('[data-act="add"]');
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "1");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(300);
        await ctx.page.evaluate(() => { window.__jintian.state.timer.endsAt = Date.now() - 200; });
        await ctx.page.waitForSelector("#dialog-ring", { state: "visible", timeout: 4000 });
        await ctx.page.click('[data-act="ring-done"]');
        await ctx.page.fill("#ring-feeling", "网页版也能跑。");
        await ctx.page.click('[data-act="ring-finish"]');
        await ctx.sleep(400);
        ctx.assert.ok(await ctx.page.isVisible(".task.is-done"), "网页版打勾没生效");

        await ctx.page.click('.nav-item[data-goto="notes"]');
        await ctx.page.fill("#summary", "在网页版写的一条总结。");
        await ctx.sleep(500);

        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.waitForSelector("#app");
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.ok(await ctx.page.isVisible(".task.is-done"), "刷新后网页版的任务没留住");
        await ctx.page.click('.nav-item[data-goto="notes"]');
        ctx.assert.includes(await ctx.page.inputValue("#summary"), "在网页版写的一条总结", "刷新后总结没了");
        ctx.assert.includes(
          await ctx.page.textContent(".feel-item .feel-name"),
          "写季度总结",
          "任务感受没跟过来"
        );
      },
    },
    {
      name: "能分清本机版和网页版，两边各自的表现都对",
      async run(ctx) {
        await h.openApp(ctx.page);
        ctx.assert.eq(
          await ctx.page.evaluate(() => window.__jintian.isWeb()),
          false,
          "本机版被误判成了网页版"
        );
        await ctx.page.unroute("**/*");
        await openWeb(ctx.page);
        ctx.assert.eq(
          await ctx.page.evaluate(() => window.__jintian.isWeb()),
          true,
          "网页版没有被识别出来"
        );
      },
    },
  ],
};
