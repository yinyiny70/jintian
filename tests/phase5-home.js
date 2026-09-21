"use strict";

const h = require("./helper");
const path = require("node:path");

const PROBE = h.toFileUrl(path.join(h.FIXTURES, "probe.html"));

async function fresh(ctx) {
  await ctx.page.goto(PROBE, { waitUntil: "load" });
  await ctx.page.evaluate(() => localStorage.clear());
  await h.openApp(ctx.page, ctx.appUrl);
}

async function addTask(ctx, name, est) {
  await ctx.page.click('.nav-item[data-goto="plan"]');
  await ctx.page.fill("#new-name", name);
  await ctx.page.fill("#new-est", String(est));
  await ctx.page.click('[data-act="add"]');
  await ctx.page.click('.nav-item[data-goto="home"]');
}

async function runOneMinute(ctx, rowIndex) {
  await ctx.page.click('.nav-item[data-goto="plan"]');
  await ctx.page.click(".task:nth-child(" + rowIndex + ") [data-act='start']");
  await ctx.page.fill("#start-min", "1");
  await ctx.page.click('[data-act="start-confirm"]');
  await ctx.sleep(250);
  await ctx.page.evaluate(() => { window.__jintian.state.timer.endsAt = Date.now() - 200; });
  await ctx.page.waitForSelector("#dialog-ring", { state: "visible", timeout: 4000 });
  await ctx.page.click('[data-act="ring-stop"]');
  await ctx.sleep(350);
}

module.exports = {
  phase: 5,
  title: "首页",
  tests: [
    {
      name: "没有计时时显示「没有在计时」，并且能跳到今日计划",
      async run(ctx) {
        await fresh(ctx);
        ctx.assert.ok(await ctx.page.isVisible("#home-idle"), "没有显示空的状态");
        ctx.assert.includes(await ctx.page.textContent("#home-idle"), "没有在计时");
        ctx.assert.eq(await ctx.page.isVisible("#home-running"), false, "不该显示计时中的样子");
        await ctx.page.click("#home-idle .link");
        ctx.assert.eq(await ctx.page.getAttribute("#app", "data-page"), "plan", "链接没有跳到今日计划");
      },
    },
    {
      name: "计时中显示任务名和剩余时间，数字每秒在变",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "写季度总结", 40);
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.page.click('.nav-item[data-goto="home"]');
        await ctx.sleep(400);
        ctx.assert.eq(await ctx.page.isVisible("#home-running"), true, "首页没有显示计时中");
        ctx.assert.eq(await ctx.page.isVisible("#home-idle"), false, "首页同时显示了空的状态");
        ctx.assert.eq((await ctx.page.textContent("#home-task")).trim(), "写季度总结");
        const t1 = await ctx.page.textContent("#home-time");
        await ctx.sleep(1600);
        const t2 = await ctx.page.textContent("#home-time");
        ctx.assert.ok(t1 !== t2, "首页的剩余时间没有在走（一直是 " + t1 + "）");
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.click('[data-act="bar-stop"]');
      },
    },
    {
      name: "「今天专注」等于当天所有实际用时之和",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "第一件", 10);
        await addTask(ctx, "第二件", 20);
        await runOneMinute(ctx, 1);
        await runOneMinute(ctx, 2);
        const total = (await ctx.page.textContent("#home-total")).trim();
        ctx.assert.eq(total, "2 分钟", "专注时长不是两件事之和");
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.waitForSelector("#app");
        ctx.assert.eq((await ctx.page.textContent("#home-total")).trim(), "2 分钟", "刷新后专注时长变了");
      },
    },
    {
      name: "首页上只有「此刻」和「今天专注」两组信息，不出现任务列表等内容",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "写季度总结", 40);
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.click(".task [data-act='start']");
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.page.click('.nav-item[data-goto="home"]');
        await ctx.sleep(300);

        const home = await ctx.page.evaluate(() => {
          const section = document.querySelector('.page[data-page="home"]');
          return {
            text: section.innerText,
            tasks: section.querySelectorAll(".task, .tasks, .cal, .cal-grid, textarea").length,
          };
        });
        ctx.assert.eq(home.tasks, 0, "首页里出现了任务列表 / 日历 / 输入框");
        ["预估", "完成 ", "随手记", "任务感受", "今日总结"].forEach((word) => {
          ctx.assert.notIncludes(home.text, word, "首页出现了不该有的内容：" + word);
        });
        const allowed = await ctx.page.evaluate(() => {
          const section = document.querySelector('.page[data-page="home"]');
          return Array.prototype.map
            .call(section.querySelectorAll(".kicker"), (el) => el.textContent.trim())
            .join("/");
        });
        ctx.assert.eq(allowed, "此刻/今天专注", "首页的标题不是「此刻」和「今天专注」两组");
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.click('[data-act="bar-stop"]');
      },
    },
  ],
};
