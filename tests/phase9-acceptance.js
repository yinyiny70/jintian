"use strict";
const h = require("./helper");
const path = require("node:path");
const FILE_PROBE = h.toFileUrl(path.join(h.FIXTURES, "probe.html"));
const DB = "jintian";
async function wipe(page, appUrl, probeUrl, openAfter) {
  await page.goto(probeUrl, { waitUntil: "load" });
  await page.evaluate(
    (db) =>
      new Promise((resolve) => {
        localStorage.clear();
        const req = indexedDB.deleteDatabase(db);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(true);
        req.onblocked = () => resolve(true);
        setTimeout(() => resolve(true), 1500);
      }),
    DB
  );
  if (openAfter !== false) await h.openApp(page, appUrl);
}
async function fresh(ctx) {
  await wipe(ctx.page, ctx.appUrl, FILE_PROBE);
}
async function addTask(ctx, name, est) {
  await h.addTask(ctx.page, name, est);
}
async function names(page) {
  return page.$$eval(".task-name", (els) => els.map((e) => e.textContent.trim()));
}
async function runTimerToRing(ctx, rowIndex, minutes) {
  await ctx.page.click('.nav-item[data-goto="plan"]');
  await ctx.page.click(".task:nth-child(" + rowIndex + ") [data-act='start']");
  await ctx.page.fill("#start-min", String(minutes));
  await ctx.page.click('[data-act="start-confirm"]');
  await ctx.sleep(250);
  await ctx.page.evaluate(() => { window.__jintian.state.timer.endsAt = Date.now() - 200; });
  await ctx.page.waitForSelector("#dialog-ring", { state: "visible", timeout: 4000 });
}
async function clearTimer(ctx) {
  await ctx.page.evaluate(() => {
    const j = window.__jintian;
    if (j.state.timer) { j.state.timer = null; j.saveNow(); j.renderAll(); }
  });
}
module.exports = {
  phase: 9,
  title: "整体验收（PRD 第 10 节 40 条）",
  tests: [
    {
      name: "A 打开与持久化（第 1—4 条）",
      async run(ctx) {
        await fresh(ctx);
        const home = await ctx.page.evaluate(() => {
          const s = document.querySelector('.page[data-page="home"]');
          return { text: s.innerText, extras: s.querySelectorAll(".task, textarea, input").length };
        });
        ctx.assert.includes(home.text, "没有在计时");
        ctx.assert.includes(home.text, "今天专注");
        ctx.assert.eq(home.extras, 0, "首页出现了不该有的内容");
        await addTask(ctx, "写季度总结", 40);
        await addTask(ctx, "回邮件和消息", 20);
        await addTask(ctx, "整理下周计划", 45);
        await ctx.sleep(500);
        const order = "写季度总结/回邮件和消息/整理下周计划";
        ctx.assert.eq((await names(ctx.page)).join("/"), order);
        const before = await ctx.page.$$eval(".task .task-meta", (els) => els.map((e) => e.textContent));
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await names(ctx.page)).join("/"), order, "刷新后顺序或内容变了");
        const after = await ctx.page.$$eval(".task .task-meta", (els) => els.map((e) => e.textContent));
        ctx.assert.eq(after.join("|"), before.join("|"), "刷新后预估时长变了");
        await ctx.page.close();
        const p2 = await ctx.openAppPage();
        await p2.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await names(p2)).length, 3, "关掉页面再打开，数据没了");
        await p2.close();
        await ctx.relaunch();
        const p3 = await ctx.context.newPage();
        await h.openApp(p3);
        await p3.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await names(p3)).length, 3, "关掉整个浏览器再打开，数据没了");
        await p3.close();
      },
    },
    {
      name: "B 今日计划（第 5—10 条）",
      async run(ctx) {
        await fresh(ctx);
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.fill("#new-name", "按回车加的事");
        await ctx.page.press("#new-name", "Enter");
        ctx.assert.eq((await names(ctx.page)).join("/"), "按回车加的事", "回车没有加上");
        await addTask(ctx, "甲", 10);
        await addTask(ctx, "乙", 20);
        await addTask(ctx, "丙", 30);
        await addTask(ctx, "丁", 40);
        ctx.assert.eq((await names(ctx.page)).length, 5);
        await ctx.page.dragAndDrop(".task:nth-child(5)", ".task:nth-child(2)");
        await ctx.sleep(500);
        const moved = (await names(ctx.page)).join("/");
        ctx.assert.eq(moved, "按回车加的事/丁/甲/乙/丙", "拖动后顺序不对");
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await names(ctx.page)).join("/"), moved, "刷新后顺序没保持");
        await ctx.page.check(".task:nth-child(3) .task-check");
        ctx.assert.ok(await ctx.page.isVisible(".task:nth-child(3).is-done"), "勾选后没有完成样式");
        ctx.assert.eq(await ctx.page.isVisible(".task:nth-child(3) [data-act='start']"), false, "完成的任务还有开始");
        await ctx.page.uncheck(".task:nth-child(3) .task-check");
        ctx.assert.ok(await ctx.page.isVisible(".task:nth-child(3) [data-act='start']"), "取消勾选后没恢复");
        await ctx.page.click(".task:nth-child(1) [data-act='edit']");
        await ctx.page.fill("[data-name-input]", "改过名字的事");
        await ctx.page.press("[data-name-input]", "Enter");
        await ctx.sleep(450);
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.includes((await names(ctx.page)).join("/"), "改过名字的事", "刷新后改名丢了");
        await ctx.page.click(".task:nth-child(5) [data-act='del']");
        await ctx.sleep(450);
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await names(ctx.page)).length, 4, "删掉的任务又回来了");
        await ctx.page.evaluate(() => {
          const j = window.__jintian;
          const list = j.state.tasks[j.todayKey()];
          list[0].est = 20;
          list[0].spentSec = 30 * 60;
          j.saveNow();
          j.renderAll();
        });
        ctx.assert.includes(await ctx.page.textContent(".task .task-meta"), "（超了）", "超过预估没有提示");
      },
    },
    {
      name: "C 计时与提醒（第 11—21 条）",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "甲", 10);
        await addTask(ctx, "乙", 20);
        await ctx.page.click(".task:nth-child(1) [data-act='start']");
        await ctx.page.waitForSelector("#dialog-start", { state: "visible" });
        ctx.assert.eq(await ctx.page.inputValue("#start-min"), "10", "默认时长不是预估时长");
        await ctx.page.fill("#start-min", "1");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(600);
        ctx.assert.ok(await ctx.page.isVisible(".task.is-running"), "任务行没有高亮");
        ctx.assert.ok(await ctx.page.isVisible("#timerbar"), "没有出现计时条");
        await ctx.page.click('.nav-item[data-goto="notes"]');
        ctx.assert.ok(await ctx.page.isVisible("#timerbar"), "切页面后计时条消失");
        await ctx.page.click('.nav-item[data-goto="review"]');
        ctx.assert.ok(await ctx.page.isVisible("#timerbar"), "切到回看后计时条消失");
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.click('[data-act="bar-pause"]');
        await ctx.sleep(300);
        const paused = await ctx.page.textContent("#timerbar-time");
        await ctx.sleep(1400);
        ctx.assert.eq(await ctx.page.textContent("#timerbar-time"), paused, "暂停后还在走");
        await ctx.page.click('[data-act="bar-pause"]');
        await ctx.sleep(1400);
        ctx.assert.ok((await ctx.page.textContent("#timerbar-time")) !== paused, "继续后没有接着走");
        await ctx.page.click(".task:nth-child(2) [data-act='start']");
        await ctx.page.waitForSelector("#dialog-confirm", { state: "visible" });
        await ctx.page.click('[data-act="confirm-cancel"]');
        ctx.assert.ok(await ctx.page.isVisible("#timerbar"), "取消后计时被弄丢了");
        await ctx.page.click('[data-act="bar-stop"]');
        await ctx.sleep(400);
        ctx.assert.eq(await ctx.page.isVisible("#timerbar"), false, "结束后计时条还在");
        const spentAfterStop = await ctx.page.evaluate(
          () => window.__jintian.state.tasks[window.__jintian.todayKey()][0].spentSec
        );
        ctx.assert.ok(spentAfterStop > 0, "中途结束没有记账");
        await runTimerToRing(ctx, 1, 1);
        ctx.assert.includes(await ctx.page.textContent("#ring-sub"), "1 分钟", "响铃框显示的时长不对");
        const bellStart = await ctx.page.evaluate(() => Date.now());
        await ctx.page.waitForFunction(() => !window.__jintian.isRinging(), null, { timeout: 20000 });
        const bellMs = (await ctx.page.evaluate(() => Date.now())) - bellStart;
        ctx.assert.ok(bellMs >= 8000 && bellMs <= 14000, "响铃时长不在 10 秒上下：" + bellMs + "ms");
        ctx.assert.ok(await ctx.page.isVisible("#dialog-ring"), "响铃框自己消失了");
        await ctx.page.click('[data-act="ring-done"]');
        await ctx.page.fill("#ring-feeling", "这一步感觉不错。");
        await ctx.page.click('[data-act="ring-finish"]');
        await ctx.sleep(400);
        ctx.assert.includes(await ctx.page.textContent(".task:nth-child(1) .task-meta"), "实际", "做完后没有记用时");
        ctx.assert.ok(await ctx.page.isVisible(".task:nth-child(1).is-done"), "做完没有打勾");
        const feels = await ctx.page.evaluate(
          () => window.__jintian.state.tasks[window.__jintian.todayKey()][0].feeling
        );
        ctx.assert.eq(feels, "这一步感觉不错。", "感受没有存下来");
        await runTimerToRing(ctx, 2, 1);
        await ctx.page.click('[data-act="ring-stop"]');
        await ctx.sleep(350);
        ctx.assert.eq(await ctx.page.isVisible(".task:nth-child(2).is-done"), false, "「先停下」不该打勾");
        ctx.assert.includes(await ctx.page.textContent(".task:nth-child(2) .task-meta"), "实际", "「先停下」没记账");
        await runTimerToRing(ctx, 2, 1);
        await ctx.page.fill("#ring-extra", "2");
        await ctx.page.click('[data-act="ring-extend"]');
        await ctx.sleep(500);
        ctx.assert.ok(await ctx.page.isVisible("#timerbar"), "加时后没有继续计时");
        const remain = await ctx.page.evaluate(() => Math.round(window.__jintian.timerRemainingSec()));
        ctx.assert.ok(remain > 100 && remain <= 120, "加时后的剩余时间不对：" + remain);
        await clearTimer(ctx);
        // 第一件在刚才已经打勾完成，不再有「开始」，改用第二件
        await ctx.page.click(".task:nth-child(2) [data-act='start']");
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(1500);
        const r1 = await ctx.page.evaluate(() => window.__jintian.timerRemainingSec());
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.waitForSelector("#app");
        await ctx.sleep(300);
        // 刷新后停在首页，首页本身就是倒计时
        ctx.assert.ok(await ctx.page.isVisible("#home-running"), "刷新后首页没有显示还在计时");
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.ok(await ctx.page.isVisible("#timerbar"), "切到今日计划后底部计时条应该出现");
        const r2 = await ctx.page.evaluate(() => window.__jintian.timerRemainingSec());
        ctx.assert.near(r1 - r2, 1.5, 1.2, "刷新后剩余时间和真实经过的时间对不上");
        await ctx.page.click('[data-act="bar-stop"]');
        await ctx.sleep(350);
        ctx.assert.eq(await ctx.page.isVisible("#timerbar"), false, "中途结束没有收起来");
      },
    },
    {
      name: "D 首页（第 22—24 条）",
      async run(ctx) {
        await fresh(ctx);
        await ctx.page.click('.nav-item[data-goto="home"]');
        ctx.assert.includes(await ctx.page.textContent("#home-idle"), "没有在计时");
        await addTask(ctx, "甲", 10);
        await addTask(ctx, "乙", 10);
        await runTimerToRing(ctx, 1, 1);
        await ctx.page.click('[data-act="ring-stop"]');
        await ctx.sleep(400);
        await runTimerToRing(ctx, 2, 1);
        await ctx.page.click('[data-act="ring-stop"]');
        await ctx.sleep(400);
        await ctx.page.click('.nav-item[data-goto="home"]');
        ctx.assert.eq((await ctx.page.textContent("#home-total")).trim(), "2 分钟", "专注时长不是两件事之和");
        ctx.assert.ok(await ctx.page.isVisible("#home-idle"), "没有计时时首页还显示计时中");
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await ctx.page.click(".task:nth-child(1) [data-act='start']");
        await ctx.page.fill("#start-min", "5");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.page.click('.nav-item[data-goto="home"]');
        await ctx.sleep(400);
        ctx.assert.ok(await ctx.page.isVisible("#home-running"), "计时中首页没有显示");
        ctx.assert.eq((await ctx.page.textContent("#home-task")).trim(), "甲");
        const t1 = await ctx.page.textContent("#home-time");
        await ctx.sleep(1500);
        ctx.assert.ok((await ctx.page.textContent("#home-time")) !== t1, "首页剩余时间没有在走");
      },
    },
    {
      name: "E 备忘录（第 25—28 条）",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "甲", 10);
        await addTask(ctx, "没计时的事", 10);
        await runTimerToRing(ctx, 1, 1);
        await ctx.page.click('[data-act="ring-stop"]');
        await ctx.sleep(400);
        await ctx.page.click('.nav-item[data-goto="notes"]');
        await ctx.page.fill("#summary", "今天把最重要的一件事做完了。");
        await ctx.page.fill("#quick-input", "顺手记一条。");
        await ctx.page.press("#quick-input", "Enter");
        await ctx.sleep(500);
        ctx.assert.ok(/已自动保存 · \d\d:\d\d/.test(await ctx.page.textContent("#summary-saved")), "没有显示保存时间");
        ctx.assert.eq((await ctx.page.$$(".quick-item")).length, 1, "随手记没加上");
        ctx.assert.ok(/^\d\d:\d\d$/.test((await ctx.page.textContent(".quick-time")).trim()), "随手记没有时分");
        await ctx.page.close();
        const p2 = await ctx.openAppPage();
        await p2.click('.nav-item[data-goto="notes"]');
        ctx.assert.includes(await p2.inputValue("#summary"), "最重要的一件事", "重开后总结没了");
        ctx.assert.eq((await p2.$$(".quick-item")).length, 1, "重开后随手记没了");
        const feelNames = await p2.$$eval(".feel-item .feel-name", (els) => els.map((e) => e.textContent.trim()));
        ctx.assert.eq(feelNames.join("/"), "甲", "任务感受里列了没计过时的任务");
        await p2.fill("[data-feel]", "还行。");
        await ctx.sleep(450);
        await p2.close();
        const p3 = await ctx.context.newPage();
        await h.openApp(p3);
        await p3.click('.nav-item[data-goto="notes"]');
        ctx.assert.eq(await p3.inputValue("[data-feel]"), "还行。", "任务感受没存下来");
        await p3.click(".quick-item [data-act='quick-del']");
        await ctx.sleep(450);
        ctx.assert.eq((await p3.$$(".quick-item")).length, 0, "随手记删不掉");
        await p3.close();
      },
    },
    {
      name: "F 回看（第 29—33 条）",
      async run(ctx) {
        await fresh(ctx);
        const seeded = await ctx.page.evaluate(() => {
          const j = window.__jintian;
          const now = new Date();
          const day = now.getDate() > 1 ? now.getDate() - 1 : 2;
          const key =
            now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(day).padStart(2, "0");
          j.state.tasks[key] = [
            { id: "p1", name: "逛超市买菜", est: 60, spentSec: 48 * 60, done: true, feeling: "" },
            { id: "p2", name: "做一顿正经的饭", est: 90, spentSec: 105 * 60, done: true, feeling: "比预计久，但值得。" },
          ];
          j.state.summaries[key] = "今天没安排工作，反而过得踏实。";
          j.state.notes[key] = [{ id: "n1", time: "11:20", text: "番茄炖牛腩下次少放盐。" }];
          j.saveNow();
          j.renderAll();
          return key;
        });
        await ctx.page.click('.nav-item[data-goto="review"]');
        ctx.assert.eq(
          await ctx.page.evaluate(
            (k) => document.querySelector('.cal-day[data-date="' + k + '"]').classList.contains("has-data"),
            seeded
          ),
          true,
          "有记录的日子没有小圆点"
        );
        ctx.assert.eq(
          await ctx.page.evaluate(() => document.querySelectorAll(".cal-day.is-today").length),
          1,
          "今天没有单独标记"
        );
        await ctx.page.click('.cal-day[data-date="' + seeded + '"]');
        await ctx.sleep(200);
        const day = await ctx.page.evaluate(() => ({
          text: document.getElementById("dayview").innerText,
          editables: document.getElementById("dayview").querySelectorAll("input, textarea, select").length,
          selected: document.querySelectorAll(".cal-day.is-selected").length,
        }));
        ["逛超市买菜", "48 分钟", "比预计久，但值得。", "2 小时 33 分", "完成 2 件", "今天没安排工作", "番茄炖牛腩"].forEach(
          (word) => ctx.assert.includes(day.text, word, "回看里少了：" + word)
        );
        ctx.assert.eq(day.editables, 0, "过去的日子出现了可以打字的地方");
        ctx.assert.eq(day.selected, 1, "选中的日期不唯一");
        const emptyKey = await ctx.page.evaluate((skip) => {
          const now = new Date();
          for (let d = 1; d <= 28; d++) {
            const k =
              now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
            const el = document.querySelector('.cal-day[data-date="' + k + '"]');
            if (el && k !== skip && !el.classList.contains("is-today")) return k;
          }
          return null;
        }, seeded);
        await ctx.page.click('.cal-day[data-date="' + emptyKey + '"]');
        await ctx.sleep(200);
        ctx.assert.includes(await ctx.page.textContent("#dayview"), "这一天没有留下记录");
        await ctx.page.click(".cal-day.is-today");
        await ctx.sleep(250);
        ctx.assert.includes(await ctx.page.textContent("#dayview"), "今日计划", "点今天没有提示去哪里修改");
      },
    },
    {
      name: "G 备份与恢复（第 34—38 条）",
      async run(ctx) {
        await ctx.page.addInitScript(() => {
          Object.defineProperty(window, "showSaveFilePicker", {
            configurable: true,
            writable: true,
            value: async () => {
              const root = await navigator.storage.getDirectory();
              return root.getFileHandle("验收-备份.json", { create: true });
            },
          });
          Object.defineProperty(window, "showOpenFilePicker", {
            configurable: true,
            writable: true,
            value: async () => {
              const root = await navigator.storage.getDirectory();
              return [await root.getFileHandle("验收-备份.json", { create: true })];
            },
          });
        });
        await wipe(ctx.page, ctx.httpUrl, ctx.httpProbeUrl, false);
        await ctx.page.goto(ctx.httpUrl, { waitUntil: "load" });
        await ctx.page.waitForSelector("#app");
        await ctx.page.waitForSelector("#dialog-backup", { state: "visible", timeout: 4000 });
        ctx.assert.includes(await ctx.page.textContent("#backup-status"), "备份", "第一次打开没有引导设置备份");
        await ctx.page.click('[data-act="backup-choose"]');
        await ctx.sleep(1500);
        ctx.assert.includes(await ctx.page.textContent("#backup-title"), "已自动保存到文件");
        await ctx.page.click('[data-act="backup-close"]');
        await addTask(ctx, "备份里的任务");
        await ctx.sleep(1600);
        const raw = await ctx.page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const fh = await root.getFileHandle("验收-备份.json", { create: true });
          return (await fh.getFile()).text();
        });
        ctx.assert.includes(raw, '"app": "今天"', "备份文件不像纯文本");
        ctx.assert.includes(raw, "备份里的任务", "改动没有写进备份文件");
        await wipe(ctx.page, ctx.httpUrl, ctx.httpProbeUrl);
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await names(ctx.page)).length, 0, "清空数据后还有内容");
        await ctx.page.click("#backup-chip");
        await ctx.page.click('[data-act="backup-restore"]');
        await ctx.page.waitForSelector("#dialog-confirm", { state: "visible", timeout: 4000 });
        ctx.assert.includes(await ctx.page.textContent("#confirm-body"), "覆盖", "没有提示会覆盖");
        await ctx.page.click('[data-act="confirm-ok"]');
        await ctx.sleep(900);
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await names(ctx.page)).join("/"), "备份里的任务", "恢复没有把内容拿回来");
      },
    },
    {
      name: "H 边界与打磨（第 39—40 条，外加跨零点、超长名字、很多任务）",
      async run(ctx) {
        await fresh(ctx);
        await addTask(ctx, "这是一条特别特别特别特别特别特别特别特别特别特别特别特别长的任务名字用来看看排版会不会被撑破", 30);
        await ctx.page.setViewportSize({ width: 320, height: 820 });
        await ctx.sleep(250);
        const narrow = await ctx.page.evaluate(() => ({
          doc: document.documentElement.scrollWidth,
          win: window.innerWidth,
        }));
        ctx.assert.ok(narrow.doc <= narrow.win + 1, "窄窗口出现横向滚动：" + narrow.doc + " / " + narrow.win);
        await ctx.page.setViewportSize({ width: 1180, height: 900 });
        await ctx.sleep(250);
        for (let i = 0; i < 30; i++) {
          await ctx.page.fill("#new-name", "第 " + (i + 1) + " 件事");
          await ctx.page.click('[data-act="add"]');
        }
        await ctx.sleep(700);
        ctx.assert.eq((await names(ctx.page)).length, 31, "加了很多任务之后数量不对");
        const overflow = await ctx.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        ctx.assert.ok(overflow <= 1, "任务很多时出现了横向滚动：" + overflow);
        ctx.assert.includes(await ctx.page.textContent("#plan-sub"), "完成 0 / 31", "顶部汇总没有跟上");
        const before = await ctx.page.evaluate(() => window.__jintian.todayKey());
        // 让计时真的先跑起来（计时器必须在走，跨零点才会被检测到）
        await ctx.page.click(".task:nth-child(1) [data-act='start']");
        await ctx.page.fill("#start-min", "10");
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.sleep(600);
        await ctx.page.evaluate(() => {
          const j = window.__jintian;
          const d = new Date();
          d.setDate(d.getDate() - 1);
          const key =
            d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
          const moving = j.state.tasks[j.todayKey()].shift();
          j.state.tasks[key] = [moving];
          j.state.timer.date = key;
          j.state.timer.taskId = moving.id;
          j.saveNow();
        });
        await ctx.sleep(700);
        const after = await ctx.page.evaluate(() => {
          const d = new Date();
          d.setDate(d.getDate() - 1);
          const key =
            d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
          return { timer: window.__jintian.state.timer, yesterdaySpent: window.__jintian.state.tasks[key][0].spentSec };
        });
        ctx.assert.eq(after.timer, null, "跨零点之后计时没有收走");
        ctx.assert.ok(after.yesterdaySpent > 0, "跨零点收走的计时没有记到昨天");
        ctx.assert.eq(await ctx.page.evaluate(() => window.__jintian.todayKey()), before, "日期本身不该变");
      },
    },
  ],
};
