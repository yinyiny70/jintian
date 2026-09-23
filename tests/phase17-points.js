"use strict";
const h = require("./helper");

// 每条测试都从"一台干净的电脑"开始，免得上一条测试攒的分跑到下一条里去
async function openShop(page) {
  await h.freshState(page);
  await page.click("#shop-chip");
  await page.waitForSelector('.page[data-page="shop"]', { state: "visible" });
}

// 模拟"已经专注了一段时间"：直接给任务记上用时。
// 真实计时那条路在第 4 阶段已经测过了；这里要测的是"攒够 5 分钟会不会自动加分"，
// 不然这条测试得真等 5 分钟。
async function pretendFocus(page, seconds) {
  await page.evaluate((sec) => {
    const j = window.__jintian;
    const date = j.todayKey();
    const list = j.state.tasks[date] || (j.state.tasks[date] = []);
    if (!list.length) {
      list.push({ id: "sim1", name: "模拟专注", est: 10, spentSec: 0, done: false, feeling: "" });
    }
    list[list.length - 1].spentSec = sec;
    j.saveNow();
    j.renderAll();
  }, seconds);
}

module.exports = {
  phase: 17,
  title: "第四版 · 积分规则",
  tests: [
    {
      name: "小铺打开就能看见：我现在多少分、今天三件事各自什么状态",
      async run(ctx) {
        await openShop(ctx.page);
        ctx.assert.eq((await ctx.page.textContent("#shop-balance")).trim(), "0", "一开始不该有分");
        ctx.assert.ok(await ctx.page.isVisible("#daily-checkin"), "少了签到");
        ctx.assert.ok(await ctx.page.isVisible("#daily-focus"), "少了专注");
        ctx.assert.ok(await ctx.page.isVisible("#daily-done"), "少了完成");
        ctx.assert.includes(await ctx.page.textContent("#daily-checkin-note"), "点一下", "签到没提示怎么拿分");
        ctx.assert.includes(await ctx.page.textContent("#daily-focus-note"), "满 5 分钟", "专注那条没写清条件");
        ctx.assert.includes(await ctx.page.textContent("#daily-done-note"), "0 / 5", "完成那条没写清进度");
        ctx.assert.eq(await ctx.page.$$eval(".daily.is-done", (els) => els.length), 0, "一开始就不该有做完的");
        // 今天还有分没拿 → 侧边栏那个入口上亮着小圆点
        ctx.assert.eq(await ctx.page.isVisible("#shop-badge"), true, "还有分没拿，却没有提醒");
      },
    },
    {
      name: "签到拿 5 分；再点一次不会重复加；关掉重开分还在",
      async run(ctx) {
        await openShop(ctx.page);
        await ctx.page.click("#daily-checkin");
        await ctx.page.waitForFunction(() => document.querySelector("#shop-balance").textContent.trim() === "5", null, { timeout: 5000 });
        ctx.assert.ok(
          await ctx.page.$eval("#daily-checkin", (el) => el.classList.contains("is-done")),
          "签完到没有打勾"
        );
        ctx.assert.eq(await ctx.page.isDisabled("#daily-checkin"), true, "签过了按钮还能再点");

        // 硬点一次也不该再加分
        const again = await ctx.page.evaluate(() => window.__jintian.checkin());
        ctx.assert.eq(again, 0, "签了第二次还给了分");
        ctx.assert.eq((await ctx.page.textContent("#shop-balance")).trim(), "5", "分数被重复加了");

        // 关掉重开，分还在
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click("#shop-chip");
        await ctx.page.waitForSelector('.page[data-page="shop"]', { state: "visible" });
        ctx.assert.eq((await ctx.page.textContent("#shop-balance")).trim(), "5", "刷新之后分没了");
        ctx.assert.ok(
          await ctx.page.$eval("#daily-checkin", (el) => el.classList.contains("is-done")),
          "刷新之后签到记录没了"
        );
      },
    },
    {
      name: "专注满 5 分钟自动 +3 分；不到 5 分钟不给，给过就不再给",
      async run(ctx) {
        await openShop(ctx.page);
        await pretendFocus(ctx.page, 4 * 60);
        ctx.assert.eq((await ctx.page.textContent("#shop-balance")).trim(), "0", "只专注 4 分钟就给了分");

        await pretendFocus(ctx.page, 5 * 60);
        ctx.assert.eq((await ctx.page.textContent("#shop-balance")).trim(), "3", "满 5 分钟没有自动加分");
        ctx.assert.ok(
          await ctx.page.$eval("#daily-focus", (el) => el.classList.contains("is-done")),
          "拿到了却没打勾"
        );

        await pretendFocus(ctx.page, 40 * 60);
        ctx.assert.eq((await ctx.page.textContent("#shop-balance")).trim(), "3", "同一天重复给了专注的分");
        ctx.assert.includes(await ctx.page.textContent("#daily-focus-note"), "已经拿到", "没有说清已经拿过");
      },
    },
    {
      name: "完成满 5 个任务自动 +5 分；只加一次",
      async run(ctx) {
        await h.freshState(ctx.page);
        for (let i = 1; i <= 4; i++) await h.addTask(ctx.page, "第 " + i + " 件事", 10);
        for (let i = 1; i <= 4; i++) await ctx.page.check(".task:nth-child(" + i + ") .task-check");
        await ctx.page.click("#shop-chip");
        await ctx.page.waitForSelector('.page[data-page="shop"]', { state: "visible" });
        ctx.assert.eq((await ctx.page.textContent("#shop-balance")).trim(), "0", "只完成 4 个就给了分");
        ctx.assert.includes(await ctx.page.textContent("#daily-done-note"), "4 / 5", "进度没跟上");

        await h.addTask(ctx.page, "第 5 件事", 10);
        await ctx.page.check(".task:nth-child(5) .task-check");
        ctx.assert.eq((await ctx.page.textContent("#shop-balance")).trim(), "5", "完成第 5 个没有加分");

        await h.addTask(ctx.page, "第 6 件事", 10);
        await ctx.page.check(".task:nth-child(6) .task-check");
        ctx.assert.eq((await ctx.page.textContent("#shop-balance")).trim(), "5", "第 6 个又加了一次");
      },
    },
    {
      name: "三件事全拿完正好 13 分，一天不会超过",
      async run(ctx) {
        await openShop(ctx.page);
        await ctx.page.click("#daily-checkin");
        await pretendFocus(ctx.page, 10 * 60);
        await h.addTask(ctx.page, "一件", 5);
        for (let i = 0; i < 4; i++) await h.addTask(ctx.page, "又一件 " + i, 5);
        for (let i = 1; i <= 5; i++) await ctx.page.check(".task:nth-child(" + i + ") .task-check");

        ctx.assert.eq((await ctx.page.textContent("#shop-balance")).trim(), "13", "三件事加起来的数不对");
        const st = await ctx.page.evaluate(() => window.__jintian.pointsStatus());
        ctx.assert.eq(st.earned, 13, "总共赚到的数不对");
        ctx.assert.eq(st.all, true, "三件事没有全部打勾");
        ctx.assert.eq(await ctx.page.isVisible("#shop-badge"), false, "分都拿完了，圆点还亮着");
      },
    },
    {
      name: "过了今晚 12 点，明天又是新的一天（可以重新拿）",
      async run(ctx) {
        await openShop(ctx.page);
        await ctx.page.click("#daily-checkin");
        await pretendFocus(ctx.page, 10 * 60);

        const out = await ctx.page.evaluate(() => {
          const j = window.__jintian;
          const RealDate = Date;
          const fake = RealDate.now() + 24 * 60 * 60 * 1000;
          const before = j.pointsStatus();
          try {
            // 把页面里的"现在"挪到明天
            window.Date = class extends RealDate {
              constructor() {
                if (arguments.length === 0) super(fake);
                else super(...arguments);
              }
              static now() {
                return fake;
              }
            };
            const fresh = j.pointsStatus();
            const gain = j.checkin();
            return { before: before, fresh: fresh, gain: gain, after: j.pointsStatus() };
          } finally {
            window.Date = RealDate;
            j.renderAll();
          }
        });

        ctx.assert.ok(out.fresh.date !== out.before.date, "日期没有往前走");
        ctx.assert.eq(out.fresh.checkin, false, "到了第二天，签到还是打勾的");
        ctx.assert.eq(out.fresh.focus, false, "到了第二天，专注还是打勾的");
        ctx.assert.eq(out.fresh.focusSec, 0, "到了第二天，专注时间还算着昨天的");
        ctx.assert.eq(out.gain, 5, "第二天签到没有加分");
        ctx.assert.eq(out.after.balance, out.before.balance + 5, "第二天的分没加上去");
      },
    },
  ],
};
