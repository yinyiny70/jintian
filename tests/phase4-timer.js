"use strict";

const h = require("./helper");
const path = require("node:path");

const PROBE = h.toFileUrl(path.join(h.FIXTURES, "probe.html"));

async function fresh(ctx) {
  await ctx.page.goto(PROBE, { waitUntil: "load" });
  await ctx.page.evaluate(() => localStorage.clear());
  await h.openApp(ctx.page, ctx.appUrl);
  await ctx.page.click('.nav-item[data-goto="plan"]');
}

async function addTask(ctx, name, est) {
  await h.addTask(ctx.page, name, est);
}

// 把结束时刻拨到过去，等价于「时间到了」，不用真等几分钟
async function expireTimer(ctx) {
  await ctx.page.evaluate(() => {
    if (window.__jintian.state.timer) window.__jintian.state.timer.endsAt = Date.now() - 200;
  });
  await ctx.page.waitForSelector("#dialog-ring", { state: "visible", timeout: 4000 });
}

module.exports = {
  phase: 4,
  title: "计时与提醒",
  tests: [
    {
      name: "点「开始」弹出输入框，默认填的是这条任务的预估时长",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "读 30 页书", 45);
        await ctx.page.click('[data-act="start"]');
        await ctx.page.waitForSelector("#dialog-start", { state: "visible" });
        ctx.assert.eq(await ctx.page.inputValue("#start-min"), "45", "默认时长不是预估时长");
        ctx.assert.includes(await ctx.page.textContent("#start-task"), "读 30 页书");
        await ctx.page.click('[data-act="start-cancel"]');
        ctx.assert.eq(await ctx.page.isVisible("#dialog-start"), false, "取消后弹框没关");
        ctx.assert.eq(await ctx.page.isVisible("#timerbar"), false, "取消后却开始计时了");
      },
    },
    {
      name: "开始计时后：任务行高亮、显示剩余时间、底部出现计时条",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "读 30 页书", 45);
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(600);
        ctx.assert.ok(await ctx.page.isVisible(".task.is-running"), "任务行没有高亮");
        ctx.assert.ok(await ctx.page.isVisible("#timerbar"), "底部没有出现计时条");
        const meta = await ctx.page.textContent(".task .task-meta");
        ctx.assert.includes(meta, "计时中", "任务行没有显示计时状态");
        const bar = (await ctx.page.textContent("#timerbar-time")).trim();
        ctx.assert.ok(/^0[45]:\d\d$/.test(bar), "剩余时间不对：" + bar);
      },
    },
    {
      name: "切到别的页面，计时条还在，时间继续走",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "读 30 页书", 45);
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(400);
        await ctx.page.click('.nav-item[data-goto="notes"]');
        ctx.assert.ok(await ctx.page.isVisible("#timerbar"), "切到备忘录后计时条消失了");
        const before = await ctx.page.textContent("#timerbar-time");
        await ctx.sleep(1600);
        const after = await ctx.page.textContent("#timerbar-time");
        ctx.assert.ok(before !== after, "切页面后时间不再走了（" + before + " 一直没变）");
        await ctx.page.click('.nav-item[data-goto="review"]');
        ctx.assert.ok(await ctx.page.isVisible("#timerbar"), "切到回看后计时条消失了");
      },
    },
    {
      name: "暂停后剩余时间停住，继续后接着走",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "读 30 页书", 45);
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(400);
        await ctx.page.click('[data-act="bar-pause"]');
        await ctx.sleep(300);
        const t1 = await ctx.page.textContent("#timerbar-time");
        await ctx.sleep(1500);
        const t2 = await ctx.page.textContent("#timerbar-time");
        ctx.assert.eq(t2, t1, "暂停后时间还在走");
        ctx.assert.includes(await ctx.page.textContent(".task .task-meta"), "已暂停");
        ctx.assert.eq(await ctx.page.textContent("#bar-pause"), "继续", "按钮没有变成「继续」");

        await ctx.page.click('[data-act="bar-pause"]');
        await ctx.sleep(1500);
        const t3 = await ctx.page.textContent("#timerbar-time");
        ctx.assert.ok(t3 !== t2, "继续后时间没有接着走");
      },
    },
    {
      name: "到点会响铃，并弹出响铃框；响铃持续约 10 秒",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "读 30 页书", 45);
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(300);
        await expireTimer(ctx);
        ctx.assert.eq(await ctx.page.evaluate(() => window.__jintian.isRinging()), true, "到点后没有响铃");
        ctx.assert.includes(await ctx.page.textContent("#ring-name"), "读 30 页书");
        ctx.assert.includes(await ctx.page.textContent("#ring-sub"), "5 分钟", "响铃框显示的时长不对");
        const started = await ctx.page.evaluate(() => Date.now());
        await ctx.page.waitForFunction(() => !window.__jintian.isRinging(), null, { timeout: 20000 });
        const duration = (await ctx.page.evaluate(() => Date.now())) - started;
        ctx.assert.ok(duration >= 8500, "响铃太短了，只响了 " + Math.round(duration / 100) / 10 + " 秒");
        ctx.assert.ok(duration <= 13500, "响铃太长了，" + Math.round(duration / 100) / 10 + " 秒还在响");

        await ctx.sleep(2200);
        ctx.assert.eq(
          await ctx.page.evaluate(() => window.__jintian.isRinging()),
          false,
          "响铃停了之后又自己响起来了"
        );
        ctx.assert.ok(await ctx.page.isVisible("#dialog-ring"), "响铃框自己消失了，应该一直等用户处理");
        ctx.assert.eq(
          await ctx.page.evaluate(() => window.__jintian.isWaiting()),
          true,
          "响铃框还开着，但程序已经不认为在等用户处理了"
        );
      },
    },
    {
      name: "响铃后选「做完了」：写一句感受就自动打勾，用时和专注时长都记上",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "写季度总结", 40);
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "1");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(300);
        await expireTimer(ctx);
        await ctx.page.click('[data-act="ring-done"]');
        await ctx.page.waitForSelector("#ring-step2", { state: "visible" });
        await ctx.page.fill("#ring-feeling", "比想象中顺利。");
        await ctx.page.click('[data-act="ring-finish"]');
        await ctx.sleep(400);

        ctx.assert.eq(await ctx.page.isVisible("#dialog-ring"), false, "弹框没有关掉");
        ctx.assert.ok(await ctx.page.isVisible(".task.is-done"), "任务没有被自动打勾");
        const meta = await ctx.page.textContent(".task .task-meta");
        ctx.assert.includes(meta, "实际 1 分钟", "实际用时没有记上");
        const feeling = await ctx.page.evaluate(
          () => window.__jintian.state.tasks[window.__jintian.todayKey()][0].feeling
        );
        ctx.assert.eq(feeling, "比想象中顺利。", "感受没有存下来");

        await ctx.page.click('.nav-item[data-goto="home"]');
        ctx.assert.eq((await ctx.page.textContent("#home-total")).trim(), "1 分钟", "首页专注时长不对");
        ctx.assert.ok(await ctx.page.isVisible("#home-idle"), "计时结束后首页还显示在计时");
      },
    },
    {
      name: "响铃后选「先停下」：不打勾，但用掉的 1 分钟照样记账",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "读 30 页书", 45);
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "1");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(300);
        await expireTimer(ctx);
        await ctx.page.click('[data-act="ring-stop"]');
        await ctx.sleep(400);
        ctx.assert.eq(await ctx.page.isVisible(".task.is-done"), false, "「先停下」不该打勾");
        ctx.assert.includes(await ctx.page.textContent(".task .task-meta"), "实际 1 分钟", "用掉的时间没记账");
        ctx.assert.eq(await ctx.page.isVisible("#timerbar"), false, "计时条没有收起来");
      },
    },
    {
      name: "响铃后选「再加 2 分钟」：继续计时，之前的 1 分钟已经算进实际用时",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "读 30 页书", 45);
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "1");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(300);
        await expireTimer(ctx);
        await ctx.page.fill("#ring-extra", "2");
        await ctx.page.click('[data-act="ring-extend"]');
        await ctx.sleep(500);

        ctx.assert.eq(await ctx.page.isVisible("#dialog-ring"), false, "弹框没有关掉");
        ctx.assert.ok(await ctx.page.isVisible("#timerbar"), "加时后没有继续计时");
        const remaining = await ctx.page.evaluate(() => Math.round(window.__jintian.timerRemainingSec()));
        ctx.assert.ok(remaining > 100 && remaining <= 120, "加时后的剩余时间不对：" + remaining);
        ctx.assert.includes(
          await ctx.page.textContent(".task .task-meta"),
          "实际 1 分钟",
          "之前那 1 分钟没算进实际用时"
        );
      },
    },
    {
      name: "计时中刷新页面，计时接着走，不白费",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "读 30 页书", 45);
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(1500);
        const before = await ctx.page.evaluate(() => window.__jintian.timerRemainingSec());
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.waitForSelector("#app");
        await ctx.sleep(300);
        // 刷新后停在首页，首页本身就是倒计时（第三条需求：计时中首页只显示倒计时）
        ctx.assert.ok(await ctx.page.isVisible("#home-running"), "刷新后首页没有显示还在计时");
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.ok(await ctx.page.isVisible("#timerbar"), "切到今日计划后底部计时条应该出现");
        const after = await ctx.page.evaluate(() => window.__jintian.timerRemainingSec());
        ctx.assert.ok(after < before, "刷新后剩余时间没有继续减少");
        ctx.assert.near(before - after, 1.5, 1.2, "刷新后的剩余时间和真实经过的时间对不上");
      },
    },
    {
      name: "关掉页面期间时间已经走完，再打开会立刻补响",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "读 30 页书", 45);
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(300);
        await ctx.page.evaluate(() => { window.__jintian.state.timer.endsAt = Date.now() - 60000; });
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.waitForSelector("#app");
        await ctx.page.waitForSelector("#dialog-ring", { state: "visible", timeout: 4000 });
        ctx.assert.eq(await ctx.page.evaluate(() => window.__jintian.isRinging()), true, "补响没有发生");
      },
    },
    {
      name: "同时只能有一个计时：给另一件事点「开始」会被拦下",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "第一件", 10);
        await addTask(ctx, "第二件", 20);
        await ctx.page.click(".task:nth-child(1) [data-act='start']");
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(300);

        // 先让第一件真的计时一会儿，否则不足 1 秒、四舍五入就是 0 秒，测不出「有没有记账」
        await ctx.sleep(1600);
        await ctx.page.click(".task:nth-child(2) [data-act='start']");
        await ctx.page.waitForSelector("#dialog-confirm", { state: "visible" });
        ctx.assert.includes(
          await ctx.page.textContent("#confirm-body"),
          "第一件",
          "提示里没说清还在给哪件事计时"
        );
        const firstId = await ctx.page.evaluate(() => window.__jintian.state.tasks[window.__jintian.todayKey()][0].id);
        await ctx.page.click('[data-act="confirm-cancel"]');
        ctx.assert.eq(
          await ctx.page.evaluate(() => window.__jintian.state.timer.taskId),
          firstId,
          "取消后计时被换掉了"
        );

        await ctx.page.click(".task:nth-child(2) [data-act='start']");
        await ctx.page.click('[data-act="confirm-ok"]');
        await ctx.page.waitForSelector("#dialog-start", { state: "visible" });
        ctx.assert.includes(await ctx.page.textContent("#start-task"), "第二件", "确认后没有切到第二件");
        const firstSpent = await ctx.page.evaluate(
          () => window.__jintian.state.tasks[window.__jintian.todayKey()][0].spentSec
        );
        ctx.assert.ok(firstSpent > 0, "前一件事用掉的时间没有记账（记录为 " + firstSpent + " 秒）");
      },
    },
    {
      name: "计时条上的「结束」能中途停下来，用掉的时间照样记账",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "读 30 页书", 45);
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(1200);
        await ctx.page.click('[data-act="bar-stop"]');
        await ctx.sleep(400);
        ctx.assert.eq(await ctx.page.isVisible("#timerbar"), false, "计时条没有收起来");
        ctx.assert.eq(await ctx.page.isVisible(".task.is-running"), false, "任务行还是计时中的样子");
        const spent = await ctx.page.evaluate(
          () => window.__jintian.state.tasks[window.__jintian.todayKey()][0].spentSec
        );
        ctx.assert.ok(spent >= 1 && spent <= 3, "中途结束的用时不对：" + spent + " 秒");
      },
    },
  ],
};
