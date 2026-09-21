"use strict";

const h = require("./helper");
const path = require("node:path");

const PROBE = h.toFileUrl(path.join(h.FIXTURES, "probe.html"));

// 注意：不能用「清空存储 → 刷新页面」来重置，因为 App 在离开页面时会把内存里的
// 数据再写回去，反而把清理覆盖掉。所以先离开 App 页面，再用另一个同源页面操作存储。
async function withStorage(ctx, fn, arg) {
  await ctx.page.goto(PROBE, { waitUntil: "load" });
  await ctx.page.evaluate(fn, arg);
  await h.openApp(ctx.page, ctx.appUrl);
}

async function reset(ctx) {
  await withStorage(ctx, () => localStorage.clear());
}

async function addTask(ctx, name, est) {
  await ctx.page.click('.nav-item[data-goto="plan"]');
  await ctx.page.fill("#new-name", name);
  await ctx.page.fill("#new-est", String(est));
  await ctx.page.click('[data-act="add"]');
  await ctx.sleep(400); // 等自动保存
}

async function taskNames(page) {
  return page.$$eval(".task .task-name", (els) => els.map((e) => e.textContent.trim()));
}

async function raw(page, key) {
  return page.evaluate((k) => localStorage.getItem(k), key);
}

const KEY = "jintian.v1";

module.exports = {
  phase: 2,
  title: "数据层",
  tests: [
    {
      name: "添加的任务，刷新页面后还在",
      async run(ctx) {
        await reset(ctx);
        await addTask(ctx, "写季度总结", 40);
        ctx.assert.eq((await taskNames(ctx.page)).join("/"), "写季度总结");
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.waitForSelector("#app");
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await taskNames(ctx.page)).join("/"), "写季度总结", "刷新后任务没了");
        const est = await ctx.page.inputValue("#new-est");
        ctx.assert.eq(est, "30", "输入框被意外改动");
        const meta = await ctx.page.textContent(".task-meta");
        ctx.assert.includes(meta, "预估 40 分钟", "预估时长没有保存");
      },
    },
    {
      name: "关掉页面再打开一个新页面，数据还在",
      async run(ctx) {
        await reset(ctx);
        await addTask(ctx, "读 30 页书", 45);
        await ctx.page.close();
        const fresh = await ctx.openAppPage();
        await fresh.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await taskNames(fresh)).join("/"), "读 30 页书", "新开的页面里没有数据");
        await fresh.close();
      },
    },
    {
      name: "关掉整个浏览器再打开，数据还在",
      async run(ctx) {
        await reset(ctx);
        await addTask(ctx, "出门散步", 30);
        await ctx.page.close();
        await ctx.relaunch();
        const fresh = await ctx.context.newPage();
        await fresh.goto(ctx.appUrl, { waitUntil: "load" });
        await fresh.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await taskNames(fresh)).join("/"), "出门散步", "重启浏览器后数据丢了");
        await fresh.close();
        const again = await ctx.context.newPage();
        await again.goto(ctx.appUrl, { waitUntil: "load" });
        await again.evaluate(() => localStorage.clear());
        await again.close();
      },
    },
    {
      name: "本地数据被写坏时，页面不会白屏，还能继续用",
      async run(ctx) {
        await withStorage(ctx, () => localStorage.setItem("jintian.v1", "{这不是合法的数据"));
        ctx.assert.eq(await ctx.page.isVisible(".nav"), true, "页面没渲染出来");
        await addTask(ctx, "损坏后新建的事", 15);
        ctx.assert.eq((await taskNames(ctx.page)).join("/"), "损坏后新建的事", "损坏后无法继续写入");
      },
    },
    {
      name: "数据带版本号，缺字段的老数据也能读进来",
      async run(ctx) {
        await ctx.page.goto(ctx.appUrl, { waitUntil: "load" });
        const today = await ctx.page.evaluate(() => window.__jintian.todayKey());
        const legacy = {
          tasks: { [today]: [{ id: "old1", name: "老数据里的任务", est: 25, done: false }] },
        };
        await withStorage(ctx, ([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify(legacy)]);
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await taskNames(ctx.page)).join("/"), "老数据里的任务", "老数据没读出来");
        ctx.assert.eq(
          await ctx.page.evaluate(() => window.__jintian.state.version),
          await ctx.page.evaluate(() => window.__jintian.version),
          "版本号没有被补上"
        );
        const saved = JSON.parse(await raw(ctx.page, KEY));
        ctx.assert.ok(saved.version >= 1, "存下去的数据没有版本号");
      },
    },
  ],
};
