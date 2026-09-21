"use strict";

const h = require("./helper");
const path = require("node:path");

const PROBE = h.toFileUrl(path.join(h.FIXTURES, "probe.html"));

async function fresh(ctx) {
  await ctx.page.goto(PROBE, { waitUntil: "load" });
  await ctx.page.evaluate(() => localStorage.clear());
  await h.openApp(ctx.page, ctx.appUrl);
  await ctx.page.click('.nav-item[data-goto="review"]');
}

// 往「本月的另一天」塞一份完整的记录，用来检查回看能不能读出来
async function seedAnotherDay(ctx) {
  return ctx.page.evaluate(() => {
    const j = window.__jintian;
    const now = new Date();
    const day = now.getDate() > 1 ? now.getDate() - 1 : 2;
    const key =
      now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
    j.state.tasks[key] = [
      { id: "p1", name: "逛超市买菜", est: 60, spentSec: 48 * 60, done: true, feeling: "" },
      { id: "p2", name: "做一顿正经的饭", est: 90, spentSec: 105 * 60, done: true, feeling: "比预计久，但值得。" },
      { id: "p3", name: "收拾阳台", est: 45, spentSec: 0, done: false, feeling: "" },
    ];
    j.state.summaries[key] = "今天没安排工作，反而过得踏实。";
    j.state.notes[key] = [{ id: "n1", time: "11:20", text: "番茄炖牛腩下次少放盐。" }];
    j.saveNow();
    j.renderAll();
    return key;
  });
}

module.exports = {
  phase: 7,
  title: "回看",
  tests: [
    {
      name: "日历显示当月，有记录的日期带小圆点，今天有单独标记",
      async run(ctx) {
        await fresh(ctx);
        const info = await ctx.page.evaluate(() => {
          const now = new Date();
          return {
            month: document.getElementById("cal-month").textContent.trim(),
            year: now.getFullYear(),
            m: now.getMonth() + 1,
            days: document.querySelectorAll(".cal-day").length,
            todayMarks: document.querySelectorAll(".cal-day.is-today").length,
          };
        });
        ctx.assert.includes(info.month, info.year + " 年 " + info.m + " 月", "月份显示不对");
        ctx.assert.ok(info.days >= 28 && info.days <= 31, "日期格数量不对：" + info.days);
        ctx.assert.eq(info.todayMarks, 1, "今天没有被单独标记，或者标了不止一个");

        const key = await seedAnotherDay(ctx);
        const marked = await ctx.page.evaluate((k) => document.querySelector('.cal-day[data-date="' + k + '"]').classList.contains("has-data"), key);
        ctx.assert.eq(marked, true, "有记录的那天没有小圆点");
        const plain = await ctx.page.evaluate(() => document.querySelectorAll(".cal-day.has-data").length);
        ctx.assert.eq(plain, 1, "不该有别的日期被标成有记录");
      },
    },
    {
      name: "点一个有记录的日子，右边显示那天的任务、用时、感受、专注时长、总结和随手记",
      async run(ctx) {
        await fresh(ctx);
        const key = await seedAnotherDay(ctx);
        await ctx.page.click('.cal-day[data-date="' + key + '"]');
        await ctx.sleep(200);

        const view = await ctx.page.evaluate(() => {
          const host = document.getElementById("dayview");
          return {
            text: host.innerText,
            selected: document.querySelectorAll(".cal-day.is-selected").length,
            editables: host.querySelectorAll("input, textarea, select").length,
          };
        });
        ctx.assert.includes(view.text, "逛超市买菜", "没有列出那天的任务");
        ctx.assert.includes(view.text, "48 分钟", "没有显示用时");
        ctx.assert.includes(view.text, "做一顿正经的饭", "少了一条任务");
        ctx.assert.includes(view.text, "比预计久，但值得。", "没有显示任务感受");
        ctx.assert.includes(view.text, "2 小时 33 分", "当天专注时长不对");
        ctx.assert.includes(view.text, "完成 2 件", "完成件数不对");
        ctx.assert.includes(view.text, "今天没安排工作，反而过得踏实。", "没有显示当天的总结");
        ctx.assert.includes(view.text, "番茄炖牛腩下次少放盐。", "没有显示当天的随手记");
        ctx.assert.eq(view.selected, 1, "被选中的日期不是唯一一个");
        ctx.assert.eq(view.editables, 0, "过去的日子里出现了可以打字的地方，应该是只读的");
      },
    },
    {
      name: "点一个没有记录的日子，明确告诉我是空的",
      async run(ctx) {
        await fresh(ctx);
        const key = await seedAnotherDay(ctx);
        // 找一个本月里既不是今天、也没有记录的日子
        const emptyKey = await ctx.page.evaluate((seeded) => {
          const now = new Date();
          for (let d = 1; d <= 28; d++) {
            const k =
              now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
            const el = document.querySelector('.cal-day[data-date="' + k + '"]');
            if (!el) continue;
            if (k === seeded) continue;
            if (el.classList.contains("is-today")) continue;
            return k;
          }
          return null;
        }, key);
        ctx.assert.ok(emptyKey, "找不到一个空白日期来测试");
        await ctx.page.click('.cal-day[data-date="' + emptyKey + '"]');
        await ctx.sleep(200);
        const text = await ctx.page.textContent("#dayview");
        ctx.assert.includes(text, "这一天没有留下记录");
      },
    },
    {
      name: "点今天：显示今天最新内容，并提示去别处修改",
      async run(ctx) {
        await fresh(ctx);
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.fill("#new-name", "写季度总结");
        await ctx.page.fill("#new-est", "40");
        await ctx.page.click('[data-act="add"]');
        await ctx.page.click('.nav-item[data-goto="notes"]');
        await ctx.page.fill("#summary", "今天把最重要的一件事做完了。");
        await ctx.sleep(450);
        await ctx.page.click('.nav-item[data-goto="review"]');
        await ctx.page.click(".cal-day.is-today");
        await ctx.sleep(250);

        const view = await ctx.page.evaluate(() => {
          const host = document.getElementById("dayview");
          return {
            text: host.innerText,
            editables: host.querySelectorAll("input, textarea, select").length,
          };
        });
        ctx.assert.includes(view.text, "写季度总结", "今天刚加的任务没显示出来");
        ctx.assert.includes(view.text, "今天把最重要的一件事做完了。", "今天的总结没显示出来");
        ctx.assert.includes(view.text, "今日计划", "没有提示去哪里修改");
        ctx.assert.eq(view.editables, 0, "今天的内容应该去别的页面改，这里不该有输入框");
      },
    },
  ],
};
