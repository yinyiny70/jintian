"use strict";

const h = require("./helper");

async function open(ctx) {
  await ctx.openApp();
  await ctx.page.waitForSelector("#app");
}

function visiblePages(page) {
  return page.evaluate(() =>
    Array.prototype.filter
      .call(document.querySelectorAll(".page"), (s) => !s.hidden)
      .map((s) => s.dataset.page)
  );
}

module.exports = {
  phase: 1,
  title: "骨架与导航",
  tests: [
    {
      name: "打开就停在首页，且只显示首页",
      async run(ctx) {
        await open(ctx);
        const page = await visiblePages(ctx.page);
        ctx.assert.eq(ctx.page.url().indexOf("index.html") > -1, true, "打开的地址不是 index.html");
        ctx.assert.eq(await ctx.page.getAttribute("#app", "data-page"), "home");
        ctx.assert.eq(page.join(","), "home", "同时显示了不该显示的页面");
      },
    },
    {
      name: "四个入口都存在，点了能切换，且一次只显示一个页面",
      async run(ctx) {
        await open(ctx);
        const labels = await ctx.page.$$eval(".nav-item", (els) => els.map((e) => e.textContent.trim()));
        ctx.assert.eq(labels.join("/"), "首页/今日计划/备忘录/回看", "四个入口的文字或数量不对");

        for (const name of ["plan", "notes", "review", "home"]) {
          await ctx.page.click('.nav-item[data-goto="' + name + '"]');
          const shown = await visiblePages(ctx.page);
          ctx.assert.eq(shown.join(","), name, "切到「" + name + "」时显示的页面不对");
          ctx.assert.eq(await ctx.page.getAttribute("#app", "data-page"), name);
          const active = await ctx.page.$$eval(".nav-item.is-active", (els) =>
            els.map((e) => e.dataset.goto)
          );
          ctx.assert.eq(active.join(","), name, "高亮的位置不对");
        }
      },
    },
    {
      name: "侧边栏显示今天的日期和备份入口",
      async run(ctx) {
        await open(ctx);
        const expected = await ctx.page.evaluate(() => window.__jintian.dateLabel(window.__jintian.todayKey()));
        const label = await ctx.page.textContent("#today-label");
        ctx.assert.eq(label.trim(), expected, "侧边栏上的日期不对");
        ctx.assert.ok(await ctx.page.isVisible("#backup-chip"), "备份入口看不到");
      },
    },
    {
      name: "窄窗口（320 像素）不出现横向滚动，宽窗口内容跟着变宽",
      async run(ctx) {
        await open(ctx);
        await ctx.page.setViewportSize({ width: 320, height: 820 });
        await ctx.sleep(120);
        const narrow = await ctx.page.evaluate(() => ({
          doc: document.documentElement.scrollWidth,
          win: window.innerWidth,
        }));
        ctx.assert.ok(
          narrow.doc <= narrow.win + 1,
          "窄窗口出现了横向滚动：内容宽 " + narrow.doc + "，窗口宽 " + narrow.win
        );

        await ctx.page.setViewportSize({ width: 1180, height: 900 });
        await ctx.sleep(120);
        const wide = await ctx.page.evaluate(() => {
          const main = document.querySelector(".main").getBoundingClientRect();
          return { mainWidth: Math.round(main.width), win: window.innerWidth };
        });
        ctx.assert.ok(
          wide.mainWidth > wide.win * 0.6,
          "窗口变宽后内容没有跟着变宽，右边留了一大条空白"
        );
      },
    },
    {
      name: "跟随系统的深色设置，且深色下文字与背景不同色",
      async run(ctx) {
        const dark = await ctx.context.newPage();
        await dark.emulateMedia({ colorScheme: "dark" });
        await dark.goto(h.toFileUrl(h.APP_HTML), { waitUntil: "load" });
        const d = await dark.evaluate(() => {
          const s = getComputedStyle(document.body);
          return { color: s.color, bg: s.backgroundColor };
        });
        await dark.close();
        ctx.assert.ok(d.color !== d.bg, "深色模式下文字和背景同色");

        const light = await ctx.context.newPage();
        await light.emulateMedia({ colorScheme: "light" });
        await light.goto(h.toFileUrl(h.APP_HTML), { waitUntil: "load" });
        const l = await light.evaluate(() => getComputedStyle(document.body).backgroundColor);
        await light.close();
        ctx.assert.ok(d.bg !== l, "深浅两种模式下背景色没有区别，说明没有跟随系统");
      },
    },
  ],
};
