"use strict";

const h = require("./helper");
const path = require("node:path");

const PROBE = h.toFileUrl(path.join(h.FIXTURES, "probe.html"));

async function fresh(ctx) {
  await ctx.page.goto(PROBE, { waitUntil: "load" });
  await ctx.page.evaluate(() => localStorage.clear());
  await h.openApp(ctx.page, ctx.appUrl);
  await ctx.page.click('.nav-item[data-goto="notes"]');
}

async function addTaskAndUseIt(ctx, name, est) {
  await ctx.page.click('.nav-item[data-goto="plan"]');
  await ctx.page.fill("#new-name", name);
  await ctx.page.fill("#new-est", String(est));
  await ctx.page.click('[data-act="add"]');
  await ctx.page.click(".task [data-act='start']");
  await ctx.page.fill("#start-min", "1");
  await ctx.page.click('[data-act="start-confirm"]');
  await ctx.sleep(250);
  await ctx.page.evaluate(() => { window.__jintian.state.timer.endsAt = Date.now() - 200; });
  await ctx.page.waitForSelector("#dialog-ring", { state: "visible", timeout: 4000 });
  await ctx.page.click('[data-act="ring-stop"]');
  await ctx.sleep(350);
  await ctx.page.click('.nav-item[data-goto="notes"]');
}

module.exports = {
  phase: 6,
  title: "备忘录",
  tests: [
    {
      name: "三本本子在同一页，顺序是总结 / 随手记 / 任务感受",
      async run(ctx) {
        await fresh(ctx);
        const titles = await ctx.page.$$eval(".page[data-page='notes'] .block-title", (els) =>
          els.map((e) => e.textContent.trim())
        );
        ctx.assert.eq(titles.join("/"), "今日总结/随手记/任务感受", "三块的位置或标题不对");
        const top = await ctx.page.$$eval('.page[data-page="notes"] .block', (els) =>
          els.map((e) => Math.round(e.getBoundingClientRect().top))
        );
        ctx.assert.ok(top[0] < top[1] && top[1] < top[2], "三块不是从上到下排的");
      },
    },
    {
      name: "今日总结：写了就自动保存，关掉页面再打开文字还在，并显示保存时间",
      async run(ctx) {
        await fresh(ctx);
        await ctx.page.fill("#summary", "上午效率很高，下午被会议切碎。\n明天把运动放到早上。");
        await ctx.sleep(450);
        ctx.assert.includes(await ctx.page.textContent("#summary-saved"), "已自动保存", "没有显示已保存");
        ctx.assert.ok(
          /已自动保存 · \d\d:\d\d/.test(await ctx.page.textContent("#summary-saved")),
          "保存提示里没有时间"
        );

        await ctx.page.close();
        const again = await ctx.openAppPage();
        await again.click('.nav-item[data-goto="notes"]');
        const text = await again.inputValue("#summary");
        ctx.assert.includes(text, "上午效率很高", "重新打开后总结没了");
        ctx.assert.includes(text, "明天把运动放到早上", "重新打开后总结不完整");
        ctx.assert.ok(
          /已自动保存 · \d\d:\d\d/.test(await again.textContent("#summary-saved")),
          "重新打开后没有显示保存时间"
        );
        await again.close();
      },
    },
    {
      name: "随手记：加一条会带上当前时分，回车也能加，刷新后还在，可以删",
      async run(ctx) {
        await fresh(ctx);
        await ctx.page.fill("#quick-input", "晨会提到的新指标，回头查一下口径。");
        await ctx.page.click('[data-act="quick-add"]');
        await ctx.page.fill("#quick-input", "书架第二层那本书，周末翻一翻。");
        await ctx.page.press("#quick-input", "Enter");
        await ctx.sleep(450);

        const items = await ctx.page.$$eval(".quick-item", (els) =>
          els.map((e) => ({
            time: e.querySelector(".quick-time").textContent.trim(),
            text: e.querySelector(".quick-text").textContent.trim(),
          }))
        );
        ctx.assert.eq(items.length, 2, "随手记条数不对");
        ctx.assert.ok(/^\d\d:\d\d$/.test(items[0].time), "第一条没有带上时分：" + items[0].time);
        ctx.assert.includes(items[1].text, "周末翻一翻");
        ctx.assert.eq(await ctx.page.inputValue("#quick-input"), "", "加完之后输入框没有清空");

        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click('.nav-item[data-goto="notes"]');
        ctx.assert.eq((await ctx.page.$$(".quick-item")).length, 2, "刷新后随手记没了");

        await ctx.page.click(".quick-item:nth-child(1) [data-act='quick-del']");
        await ctx.sleep(450);
        ctx.assert.eq((await ctx.page.$$(".quick-item")).length, 1, "删除没有生效");
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click('.nav-item[data-goto="notes"]');
        const left = await ctx.page.$$eval(".quick-item .quick-text", (els) => els.map((e) => e.textContent));
        ctx.assert.eq(left.length, 1, "删除后刷新又回来了");
        ctx.assert.includes(left[0], "周末翻一翻");
      },
    },
    {
      name: "任务感受：只列今天计过时的事，就地写一句话能存下来",
      async run(ctx) {
        await fresh(ctx);
        await addTaskAndUseIt(ctx, "读 30 页书", 45);
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.fill("#new-name", "没计时的事");
        await ctx.page.click('[data-act="add"]');
        await ctx.page.click('.nav-item[data-goto="notes"]');

        const names = await ctx.page.$$eval(".feel-item .feel-name", (els) => els.map((e) => e.textContent.trim()));
        ctx.assert.eq(names.join("/"), "读 30 页书", "任务感受里列出了不该有的任务（应该只列计过时的）");

        await ctx.page.fill("[data-feel]", "读到一半有点走神，下次换个地方。");
        await ctx.sleep(450);
        const value = await ctx.page.evaluate(
          () => window.__jintian.state.tasks[window.__jintian.todayKey()].find((t) => t.feeling).feeling
        );
        ctx.assert.includes(value, "下次换个地方", "感受没有存下来");

        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click('.nav-item[data-goto="notes"]');
        ctx.assert.includes(await ctx.page.inputValue("[data-feel]"), "下次换个地方", "刷新后感受没了");
      },
    },
  ],
};
