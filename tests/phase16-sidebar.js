"use strict";
const h = require("./helper");

module.exports = {
  phase: 16,
  title: "第四版 · 侧边栏收拾干净",
  tests: [
    {
      name: "备份入口收成了一个小按钮：不再占着原来那两行的地方",
      async run(ctx) {
        await h.openApp(ctx.page);
        ctx.assert.ok(await ctx.page.isVisible("#backup-chip"), "备份入口不见了");

        const box = await ctx.page.locator("#backup-chip").boundingBox();
        const account = await ctx.page.locator("#account-chip").boundingBox();
        ctx.assert.ok(box.height < 44, "备份入口还是一大块：高 " + Math.round(box.height) + " 像素");
        ctx.assert.ok(
          box.height < account.height,
          "备份入口并没有比账号那条更小（备份 " + Math.round(box.height) + " / 账号 " + Math.round(account.height) + "）"
        );
        // 两行状态字还在 DOM 里（读屏软件要读），但视觉上只剩 1 像素，等于没占地方
        const hidden = await ctx.page.evaluate(() => {
          const box = document.querySelector("#backup-chip .sr-only");
          const r = box.getBoundingClientRect();
          return {
            w: Math.round(r.width),
            h: Math.round(r.height),
            text: box.textContent.replace(/\s+/g, " ").trim(),
          };
        });
        ctx.assert.ok(hidden.w <= 2 && hidden.h <= 2, "状态字还占着地方：" + JSON.stringify(hidden));
        ctx.assert.ok(hidden.text.length > 0, "状态文字没了（读屏软件会读不到）");

        // 状态改成悬停提示，鼠标停上去还能看到
        const title = await ctx.page.getAttribute("#backup-chip", "title");
        ctx.assert.includes(title, "备份", "悬停提示里没写清这是什么");
        const label = await ctx.page.getAttribute("#backup-chip", "aria-label");
        ctx.assert.includes(label, "备份与恢复", "读屏文字里没写清这是什么");
      },
    },
    {
      name: "点了那个小按钮，出来的还是原来那个备份窗口（三件事都在）",
      async run(ctx) {
        await h.openApp(ctx.page);
        await ctx.page.click("#backup-chip");
        await ctx.page.waitForSelector("#dialog-backup", { state: "visible" });

        ctx.assert.includes(
          await ctx.page.textContent("#backup-title-d"),
          "备份与恢复",
          "窗口标题不对"
        );
        ctx.assert.ok(await ctx.page.isVisible("#backup-choose"), "少了「选择备份文件的位置」");
        ctx.assert.ok(await ctx.page.isVisible('[data-act="backup-now"]'), "少了「立刻备份一次」");
        ctx.assert.ok(await ctx.page.isVisible('[data-act="backup-restore"]'), "少了「从文件恢复」");
        ctx.assert.ok(await ctx.page.isVisible('[data-act="backup-later"]'), "少了「先不设置」");

        await ctx.page.click('[data-act="backup-close"]');
        await ctx.page.waitForSelector("#dialog-backup", { state: "hidden" });
      },
    },
  ],
};
