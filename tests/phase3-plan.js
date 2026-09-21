"use strict";

const h = require("./helper");
const path = require("node:path");

const PROBE = h.toFileUrl(path.join(h.FIXTURES, "probe.html"));
const KEY = "jintian.v1";

async function fresh(ctx) {
  await ctx.page.goto(PROBE, { waitUntil: "load" });
  await ctx.page.evaluate(() => localStorage.clear());
  await h.openApp(ctx.page, ctx.appUrl);
  await ctx.page.click('.nav-item[data-goto="plan"]');
}

async function addViaButton(ctx, name, est) {
  await ctx.page.fill("#new-name", name);
  await ctx.page.fill("#new-est", String(est));
  await ctx.page.click('[data-act="add"]');
}

async function names(page) {
  return page.$$eval(".task .task-name", (els) => els.map((e) => e.textContent.trim()));
}

module.exports = {
  phase: 3,
  title: "今日计划",
  tests: [
    {
      name: "点「添加」和按回车都能加任务，空名字加不进去",
      async run(ctx) {
        await fresh(ctx);
        await addViaButton(ctx, "写季度总结", 40);
        await ctx.page.fill("#new-name", "读 30 页书");
        await ctx.page.fill("#new-est", "45");
        await ctx.page.press("#new-name", "Enter");
        await ctx.assert.eq((await names(ctx.page)).join("/"), "写季度总结/读 30 页书");

        await ctx.page.click('[data-act="add"]');
        ctx.assert.eq((await names(ctx.page)).length, 2, "空名字被加进去了");
        ctx.assert.eq(await ctx.page.inputValue("#new-name"), "", "添加后输入框没有清空");
      },
    },
    {
      name: "任务行显示预估时长；顶部显示「完成 N / M」",
      async run(ctx) {
        await fresh(ctx);
        await addViaButton(ctx, "写季度总结", 40);
        await addViaButton(ctx, "读 30 页书", 45);
        const meta = await ctx.page.textContent(".task .task-meta");
        ctx.assert.includes(meta, "预估 40 分钟", "任务行没有显示预估时长");
        const sub = await ctx.page.textContent("#plan-sub");
        ctx.assert.includes(sub, "完成 0 / 2", "顶部汇总不对");
      },
    },
    {
      name: "勾选完成：名称加删除线、「开始」消失；取消勾选恢复",
      async run(ctx) {
        await fresh(ctx);
        await addViaButton(ctx, "写季度总结", 40);
        await ctx.page.check(".task .task-check");
        ctx.assert.ok(await ctx.page.isVisible(".task.is-done"), "勾选后没有完成样式");
        ctx.assert.eq(await ctx.page.isVisible('[data-act="start"]'), false, "完成的任务还有「开始」");
        ctx.assert.includes(await ctx.page.textContent("#plan-sub"), "完成 1 / 1");
        const deco = await ctx.page.$eval(".task-name", (el) => getComputedStyle(el).textDecorationLine);
        ctx.assert.includes(deco, "line-through", "名称没有删除线");

        await ctx.page.uncheck(".task .task-check");
        ctx.assert.eq(await ctx.page.isVisible(".task.is-done"), false, "取消勾选没有恢复");
        ctx.assert.ok(await ctx.page.isVisible('[data-act="start"]'), "取消勾选后「开始」没回来");
      },
    },
    {
      name: "改名：改完刷新还是新名字；空白名字不会把原名抹掉",
      async run(ctx) {
        await fresh(ctx);
        await addViaButton(ctx, "写季度总结", 40);
        await ctx.page.click('[data-act="edit"]');
        await ctx.page.fill("[data-name-input]", "写季度总结（改）");
        await ctx.page.press("[data-name-input]", "Enter");
        ctx.assert.eq((await names(ctx.page)).join("/"), "写季度总结（改）");
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await names(ctx.page)).join("/"), "写季度总结（改）", "刷新后改名丢了");

        await ctx.page.click('[data-act="edit"]');
        await ctx.page.fill("[data-name-input]", "   ");
        await ctx.page.press("[data-name-input]", "Enter");
        ctx.assert.eq((await names(ctx.page)).join("/"), "写季度总结（改）", "空名字把原名字抹掉了");
      },
    },
    {
      name: "拖动排序：顺序改变，刷新后保持",
      async run(ctx) {
        await fresh(ctx);
        await addViaButton(ctx, "第一件", 10);
        await addViaButton(ctx, "第二件", 20);
        await addViaButton(ctx, "第三件", 30);
        ctx.assert.eq((await names(ctx.page)).join("/"), "第一件/第二件/第三件");

        const rows = await ctx.page.$$(".task");
        await ctx.page.dragAndDrop(".task:nth-child(3)", ".task:nth-child(1)");
        await ctx.sleep(450);
        const after = (await names(ctx.page)).join("/");
        ctx.assert.eq(after, "第三件/第一件/第二件", "拖动后顺序不对");
        ctx.assert.eq(rows.length, 3, "拖动后条数变了");

        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await names(ctx.page)).join("/"), "第三件/第一件/第二件", "刷新后顺序没保持");
      },
    },
    {
      name: "删除：删掉后列表里没有，刷新后也不回来",
      async run(ctx) {
        await fresh(ctx);
        await addViaButton(ctx, "留着", 10);
        await addViaButton(ctx, "删掉", 20);
        await ctx.page.click(".task:nth-child(2) [data-act='del']");
        ctx.assert.eq((await names(ctx.page)).join("/"), "留着");
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await names(ctx.page)).join("/"), "留着", "删除的任务又回来了");
      },
    },
    {
      name: "实际用时超过预估时，那一行显示「（超了）」",
      async run(ctx) {
        await fresh(ctx);
        await addViaButton(ctx, "拖了很久的事", 20);
        await ctx.page.evaluate(() => {
          const j = window.__jintian;
          const date = j.todayKey();
          j.state.tasks[date][0].spentSec = 30 * 60;
          j.saveNow();
          j.renderAll();
        });
        const meta = await ctx.page.textContent(".task .task-meta");
        ctx.assert.includes(meta, "实际 30 分钟", "没有显示实际用时");
        ctx.assert.includes(meta, "超了", "超过预估没有提示");
      },
    },
  ],
};
