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

async function taskNames(page) {
  return page.$$eval(".task .task-name", (els) => els.map((e) => e.textContent.trim()));
}

module.exports = {
  phase: 11,
  title: "第三版 · 添加栏 / 秒级用时 / 深浅切换",
  tests: [
    {
      name: "添加栏不再有分钟数输入框，只写名字就能加",
      async run(ctx) {
        await fresh(ctx);
        ctx.assert.eq(await ctx.page.$("#new-est"), null, "添加栏还留着分钟数输入框");
        const addBox = await ctx.page.$eval(".add", (el) => el.querySelectorAll("input").length);
        ctx.assert.eq(addBox, 1, "添加栏里应该只剩一个输入框");

        await ctx.page.fill("#new-name", "写季度总结");
        await ctx.page.press("#new-name", "Enter");
        ctx.assert.eq((await taskNames(ctx.page)).join("/"), "写季度总结");
        const meta = await ctx.page.textContent(".task-meta");
        ctx.assert.notIncludes(meta, "预估", "没设预估不该显示预估");
      },
    },
    {
      name: "预估改到任务行的编辑状态里设，设完照旧显示、照样会提示「超了」",
      async run(ctx) {
        await fresh(ctx);
        await ctx.page.fill("#new-name", "读 30 页书");
        await ctx.page.press("#new-name", "Enter");

        await ctx.page.click('[data-act="edit"]');
        await ctx.page.fill("[data-est-input]", "45");
        await ctx.page.click('[data-act="edit-done"]');
        ctx.assert.includes(await ctx.page.textContent(".task-meta"), "预估 45 分钟", "设了预估却没有显示");

        // 改名字和改预估是在同一个编辑状态里一起完成的
        await ctx.page.click('[data-act="edit"]');
        await ctx.page.fill("[data-name-input]", "读 60 页书");
        await ctx.page.fill("[data-est-input]", "60");
        await ctx.page.press("[data-est-input]", "Enter");
        ctx.assert.eq((await taskNames(ctx.page)).join("/"), "读 60 页书", "编辑状态里改名字没生效");
        ctx.assert.includes(await ctx.page.textContent(".task-meta"), "预估 1 小时", "编辑状态里改预估没生效");

        // 超过预估照样提示
        await ctx.page.evaluate(() => {
          const j = window.__jintian;
          const list = j.state.tasks[j.todayKey()];
          list[0].spentSec = 70 * 60;
          j.saveNow();
          j.renderAll();
        });
        ctx.assert.includes(await ctx.page.textContent(".task-meta"), "（超了）", "超过预估没有提示");

        // 刷新后预估还在
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.includes(await ctx.page.textContent(".task-meta"), "预估 1 小时", "刷新后预估丢了");
      },
    },
    {
      name: "没设预估的任务，点开始时弹框默认 25 分钟",
      async run(ctx) {
        await fresh(ctx);
        await ctx.page.fill("#new-name", "临时想到的事");
        await ctx.page.press("#new-name", "Enter");
        await ctx.page.click('[data-act="start"]');
        await ctx.page.waitForSelector("#dialog-start", { state: "visible" });
        ctx.assert.eq(await ctx.page.inputValue("#start-min"), "25", "没设预估时默认值不对");
        await ctx.page.click('[data-act="start-cancel"]');

        // 设了预估就跟预估走
        await ctx.page.click('[data-act="edit"]');
        await ctx.page.fill("[data-est-input]", "40");
        await ctx.page.click('[data-act="edit-done"]');
        await ctx.page.click('[data-act="start"]');
        await ctx.page.waitForSelector("#dialog-start", { state: "visible" });
        ctx.assert.eq(await ctx.page.inputValue("#start-min"), "40", "设了预估却没有跟预估走");
        await ctx.page.click('[data-act="start-cancel"]');
      },
    },
    {
      name: "单件事的用时精确到秒，总时长仍然到分",
      async run(ctx) {
        await fresh(ctx);
        await ctx.page.fill("#new-name", "写季度总结");
        await ctx.page.press("#new-name", "Enter");
        await ctx.page.fill("#new-name", "读 30 页书");
        await ctx.page.press("#new-name", "Enter");

        // 造出两个用时：3 分 12 秒 和 45 秒
        await ctx.page.evaluate(() => {
          const j = window.__jintian;
          const list = j.state.tasks[j.todayKey()];
          list[0].spentSec = 3 * 60 + 12;
          list[1].spentSec = 45;
          j.saveNow();
          j.renderAll();
        });

        const metas = await ctx.page.$$eval(".task .task-meta", (els) => els.map((e) => e.textContent));
        ctx.assert.includes(metas[0], "实际 3 分 12 秒", "任务行没有精确到秒：" + metas[0]);
        ctx.assert.includes(metas[1], "实际 45 秒", "不满一分钟的显示不对：" + metas[1]);

        // 备忘录的任务感受也到秒
        await ctx.page.click('.nav-item[data-goto="notes"]');
        const feels = await ctx.page.$$eval(".feel-item .feel-meta", (els) => els.map((e) => e.textContent));
        ctx.assert.eq(feels[0].trim(), "3 分 12 秒", "任务感受的用时没有到秒：" + feels[0]);

        // 回看里"当天做的事"也到秒
        await ctx.page.click('.nav-item[data-goto="review"]');
        await ctx.page.click(".cal-day.is-today");
        await ctx.sleep(200);
        const dayText = await ctx.page.textContent("#dayview");
        ctx.assert.includes(dayText, "3 分 12 秒", "回看里的单件事用时没有到秒");

        // 但总时长还是到分
        await ctx.page.click('.nav-item[data-goto="home"]');
        const total = (await ctx.page.textContent("#home-total")).trim();
        ctx.assert.notIncludes(total, "秒", "首页的总时长不该精确到秒：" + total);
        ctx.assert.eq(total, "4 分钟", "首页总时长不对（3 分 12 秒 + 45 秒 四舍五入应是 4 分钟）：" + total);
      },
    },
    {
      name: "深浅色：默认阳光浅色，能手动切成深色，也能切回跟随系统，设置记得住",
      async run(ctx) {
        await fresh(ctx);
        const scheme = () => ctx.page.evaluate(() => document.documentElement.style.colorScheme);
        const pressed = () =>
          ctx.page.$$eval(".theme-btn", (els) =>
            els.filter((e) => e.getAttribute("aria-pressed") === "true").map((e) => e.dataset.theme)
          );

        ctx.assert.eq(await scheme(), "light", "默认不是浅色");
        ctx.assert.eq((await pressed()).join(","), "light", "默认没有把浅色标成选中");

        // 切换按钮都在
        const labels = await ctx.page.$$eval(".theme-btn", (els) => els.map((e) => e.textContent.trim()));
        ctx.assert.eq(labels.join("/"), "浅色/深色/跟随系统", "深浅切换的选项不对");

        await ctx.page.click('.theme-btn[data-theme="dark"]');
        ctx.assert.eq(await scheme(), "dark", "点了深色没变");
        ctx.assert.eq((await pressed()).join(","), "dark", "深色没有标成选中");
        const darkBg = await ctx.page.evaluate(() => getComputedStyle(document.body).backgroundColor);

        await ctx.page.click('.theme-btn[data-theme="auto"]');
        ctx.assert.eq(await scheme(), "light dark", "跟随系统没生效");

        await ctx.page.click('.theme-btn[data-theme="light"]');
        const lightBg = await ctx.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        ctx.assert.ok(lightBg !== darkBg, "浅色和深色的背景没有区别");
        ctx.assert.includes(lightBg, "239", "浅色底应该是暖奶油色，现在不是：" + lightBg);

        // 刷新后记得住
        await ctx.page.reload({ waitUntil: "load" });
        ctx.assert.eq(await scheme(), "light", "刷新后深浅设置丢了");
        ctx.assert.eq((await pressed()).join(","), "light", "刷新后选中的按钮不对");
      },
    },
  ],
};
