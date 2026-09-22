"use strict";

const h = require("./helper");
const path = require("node:path");

const PROBE = h.toFileUrl(path.join(h.FIXTURES, "probe.html"));

async function fresh(ctx) {
  await ctx.page.goto(PROBE, { waitUntil: "load" });
  await ctx.page.evaluate(() => localStorage.clear());
  await h.openApp(ctx.page, ctx.appUrl);
  await ctx.page.click('.nav-item[data-goto="home"]');
}

module.exports = {
  phase: 12,
  title: "第三版 · 首页金句",
  tests: [
    {
      name: "金句库内容够用，三类都有，没有重复",
      async run(ctx) {
        await fresh(ctx);
        const info = await ctx.page.evaluate(() => {
          const q = window.JINTIAN_QUOTES || [];
          const by = {};
          q.forEach((x) => { by[x.k] = (by[x.k] || 0) + 1; });
          const seen = new Set();
          let dup = 0;
          q.forEach((x) => { if (seen.has(x.t)) dup++; seen.add(x.t); });
          return {
            total: q.length,
            by,
            dup,
            missing: q.filter((x) => !x.t || !x.s).length,
            exposed: window.__jintian.quoteCount(),
          };
        });
        ctx.assert.ok(info.total >= 150, "金句数量不够，只有 " + info.total + " 条");
        ctx.assert.ok(info.by.gu >= 40, "古诗古文太少：" + info.by.gu);
        ctx.assert.ok(info.by.ming >= 30, "名言太少：" + info.by.ming);
        ctx.assert.ok(info.by.ge >= 30, "歌词太少：" + info.by.ge);
        ctx.assert.eq(info.dup, 0, "有重复的金句");
        ctx.assert.eq(info.missing, 0, "有缺字段的金句");
        ctx.assert.eq(info.exposed, info.total, "页面里读到的数量对不上");
      },
    },
    {
      name: "首页显示一句金句和出处，不是空的",
      async run(ctx) {
        await fresh(ctx);
        const quote = (await ctx.page.textContent("#home-quote")).trim();
        const src = (await ctx.page.textContent("#home-quote-src")).trim();
        ctx.assert.ok(quote.length >= 4, "首页金句是空的");
        ctx.assert.ok(src.length >= 2, "金句没有标出处：" + src);
        // 真的是库里的某一句，不是随便写死的
        const inList = await ctx.page.evaluate(
          (t) => (window.JINTIAN_QUOTES || []).some((x) => x.t === t),
          quote
        );
        ctx.assert.eq(inList, true, "显示的金句不在库里：" + quote);
      },
    },
    {
      name: "10 分钟换一句：同一时段是同一句，跨时段就换",
      async run(ctx) {
        await fresh(ctx);
        const r = await ctx.page.evaluate(() => {
          const j = window.__jintian;
          const slot = j.quoteSlotMs;
          const now = Date.now();
          const start = Math.floor(now / slot) * slot; // 当前时段的起点
          return {
            slot,
            same: j.quoteIndexAt(start) === j.quoteIndexAt(start + slot - 1), // 同一时段内不变
            next: j.quoteIndexAt(start) !== j.quoteIndexAt(start + slot),     // 到下一时段就换
            cycle: j.quoteIndexAt(start) === j.quoteIndexAt(start + slot * j.quoteCount()), // 一轮之后回到原处
          };
        });
        ctx.assert.eq(r.slot, 10 * 60 * 1000, "换句间隔不是 10 分钟");
        ctx.assert.eq(r.same, true, "同一个 10 分钟时段内金句变了");
        ctx.assert.eq(r.next, true, "过了 10 分钟金句没有换");
        ctx.assert.eq(r.cycle, true, "放完一轮没有回到开头");
      },
    },
    {
      name: "同一时段里来回切页面、刷新，金句不变",
      async run(ctx) {
        await fresh(ctx);
        const first = (await ctx.page.textContent("#home-quote")).trim();
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.click('.nav-item[data-goto="home"]');
        ctx.assert.eq((await ctx.page.textContent("#home-quote")).trim(), first, "切页面后金句变了");
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click('.nav-item[data-goto="home"]');
        ctx.assert.eq((await ctx.page.textContent("#home-quote")).trim(), first, "刷新后金句变了");
      },
    },
    {
      name: "计时中首页只剩倒计时：金句、分隔线、今天专注全部退场",
      async run(ctx) {
        await fresh(ctx);
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.fill("#new-name", "读 30 页书");
        await ctx.page.press("#new-name", "Enter");
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.page.click('.nav-item[data-goto="home"]');
        await ctx.sleep(400);

        ctx.assert.ok(await ctx.page.isVisible("#home-running"), "首页没有显示倒计时");
        ctx.assert.eq(await ctx.page.isVisible("#home-quote-wrap"), false, "计时中金句没有退场");
        ctx.assert.eq(await ctx.page.isVisible("#home-total-block"), false, "计时中「今天专注」没有退场");
        ctx.assert.eq(await ctx.page.isVisible("#home-hr"), false, "计时中分隔线没有退场");
        ctx.assert.eq(await ctx.page.isVisible("#home-idle"), false, "计时中还显示着没计时的状态");
        // 只剩倒计时：任务名 + 剩余时间 + 进度线 + 两个按钮
        ctx.assert.eq((await ctx.page.textContent("#home-task")).trim(), "读 30 页书");
        const remain = (await ctx.page.textContent("#home-time")).trim();
        ctx.assert.ok(/^\d\d:\d\d$/.test(remain), "倒计时格式不对：" + remain);
        ctx.assert.ok(await ctx.page.isVisible("#home-pause"), "首页没有暂停按钮");

        // 首页有自己的按钮，底部那条就不重复出现
        ctx.assert.eq(await ctx.page.isVisible("#timerbar"), false, "首页不该再出现底部计时条");
        await ctx.page.click('.nav-item[data-goto="notes"]');
        ctx.assert.ok(await ctx.page.isVisible("#timerbar"), "切到别的页面后底部计时条应该出现");
        await ctx.page.click('[data-act="bar-stop"]');

        // 结束后金句回来
        await ctx.page.click('.nav-item[data-goto="home"]');
        ctx.assert.ok(await ctx.page.isVisible("#home-quote-wrap"), "计时结束后金句没有回来");
        ctx.assert.ok(await ctx.page.isVisible("#home-total-block"), "计时结束后「今天专注」没有回来");
      },
    },
    {
      name: "首页的暂停按钮能用：点了变成「继续」，时间停住",
      async run(ctx) {
        await fresh(ctx);
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.fill("#new-name", "写季度总结");
        await ctx.page.press("#new-name", "Enter");
        await ctx.page.click('[data-act="start"]');
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.page.click('.nav-item[data-goto="home"]');
        await ctx.sleep(300);

        ctx.assert.eq((await ctx.page.textContent("#home-pause")).trim(), "暂停", "初始按钮文字不对");
        await ctx.page.click("#home-pause");
        await ctx.sleep(200);
        ctx.assert.eq((await ctx.page.textContent("#home-pause")).trim(), "继续", "点了暂停没有变成继续");
        const t1 = await ctx.page.textContent("#home-time");
        await ctx.sleep(1500);
        ctx.assert.eq(await ctx.page.textContent("#home-time"), t1, "暂停后时间还在走");

        await ctx.page.click("#home-pause");
        await ctx.sleep(1500);
        ctx.assert.ok((await ctx.page.textContent("#home-time")) !== t1, "继续后时间没有接着走");
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.click('[data-act="bar-stop"]');
      },
    },
  ],
};
