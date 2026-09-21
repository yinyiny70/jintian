"use strict";

const h = require("./helper");
const path = require("node:path");

const DB = "jintian";
const FILE_PROBE = h.toFileUrl(path.join(h.FIXTURES, "probe.html"));

// 浏览器弹出的「选保存位置 / 选文件」窗口没法自动点。所以把这两个入口替换成
// 浏览器自己的文件系统里的一张真实文件——除了这两个系统弹窗，写入、读取、
// 恢复全都是真实代码路径。
async function stubPickers(page, saveName, openName) {
  await page.addInitScript(
    ([save, open]) => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        writable: true,
        value: async () => {
          const root = await navigator.storage.getDirectory();
          return root.getFileHandle(save, { create: true });
        },
      });
      Object.defineProperty(window, "showOpenFilePicker", {
        configurable: true,
        writable: true,
        value: async () => {
          const root = await navigator.storage.getDirectory();
          return [await root.getFileHandle(open, { create: true })];
        },
      });
    },
    [saveName, openName]
  );
}

// 顺序很重要：必须先离开 App 页面再清存储。否则 App 在离开页面时会把内存里的
// 数据写回存储，把刚清掉的东西又变回来。
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

async function readBackup(page, name) {
  return page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(n, { create: true });
    return (await handle.getFile()).text();
  }, name);
}

async function writeBackupFile(page, name, text) {
  await page.evaluate(
    async ([n, t]) => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(n, { create: true });
      const writable = await handle.createWritable();
      await writable.write(t);
      await writable.close();
    },
    [name, text]
  );
}

async function addTask(ctx, name) {
  await ctx.page.click('.nav-item[data-goto="plan"]');
  await ctx.page.fill("#new-name", name);
  await ctx.page.click('[data-act="add"]');
}

async function taskNames(page) {
  return page.$$eval(".task-name", (els) => els.map((e) => e.textContent.trim()));
}

const SAVE_NAME = "备份测试-甲.json";
const SAVE_NAME_2 = "备份测试-乙.json";
const OPEN_NAME = "恢复用-备份.json";

module.exports = {
  phase: 8,
  title: "备份与恢复",
  tests: [
    {
      name: "第一次打开会引导设置备份文件的位置，可以「先不设置」跳过，之后不再纠缠",
      async run(ctx) {
        await wipe(ctx.page, ctx.appUrl, FILE_PROBE, false);
        await ctx.page.goto(ctx.appUrl, { waitUntil: "load" });
        await ctx.page.waitForSelector("#app");
        await ctx.page.waitForSelector("#dialog-backup", { state: "visible", timeout: 4000 });
        ctx.assert.includes(await ctx.page.textContent("#backup-status"), "备份", "引导语里没提到备份");
        await ctx.page.click('[data-act="backup-later"]');
        ctx.assert.eq(await ctx.page.isVisible("#dialog-backup"), false, "点了「先不设置」弹框没关");

        await h.openApp(ctx.page, ctx.appUrl);
        const again = await ctx.page
          .waitForSelector("#dialog-backup", { state: "visible", timeout: 1200 })
          .catch(() => null);
        ctx.assert.eq(again, null, "跳过之后每次打开还在纠缠");
      },
    },
    {
      name: "选好备份文件后状态条会显示，改动之后文件里真的有新内容",
      async run(ctx) {
        await stubPickers(ctx.page, SAVE_NAME, OPEN_NAME);
        await wipe(ctx.page, ctx.httpUrl, ctx.httpProbeUrl);
        await addTask(ctx, "写季度总结");
        await ctx.sleep(1200);

        await ctx.page.click("#backup-chip");
        await ctx.page.click('[data-act="backup-choose"]');
        await ctx.sleep(1500);

        ctx.assert.includes(await ctx.page.textContent("#backup-title"), "已自动保存到文件", "状态条没有变成已保存");
        ctx.assert.includes(await ctx.page.textContent("#backup-sub"), SAVE_NAME, "状态条没有显示文件名");
        ctx.assert.ok(/· \d\d:\d\d/.test(await ctx.page.textContent("#backup-sub")), "状态条没有显示写入时间");
        await ctx.page.click('[data-act="backup-close"]');

        let raw = await readBackup(ctx.page, SAVE_NAME);
        ctx.assert.ok(raw.length > 0, "备份文件是空的");
        const parsed = JSON.parse(raw);
        ctx.assert.ok(parsed.data && parsed.data.tasks, "备份文件的结构不对");
        ctx.assert.includes(JSON.stringify(parsed), "写季度总结", "刚加的任务没有写进备份文件");

        await addTask(ctx, "出门散步");
        await ctx.sleep(1700);
        raw = await readBackup(ctx.page, SAVE_NAME);
        ctx.assert.includes(raw, "出门散步", "改了数据之后备份文件没有跟着更新");
      },
    },
    {
      name: "关掉页面再打开，备份位置还在，不用重新选",
      async run(ctx) {
        await stubPickers(ctx.page, SAVE_NAME, OPEN_NAME);
        await wipe(ctx.page, ctx.httpUrl, ctx.httpProbeUrl);
        await ctx.page.click("#backup-chip");
        await ctx.page.click('[data-act="backup-choose"]');
        await ctx.sleep(1500);
        await ctx.page.click('[data-act="backup-close"]');

        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.waitForSelector("#app");
        await ctx.sleep(1300);
        ctx.assert.includes(
          await ctx.page.textContent("#backup-title"),
          "已自动保存到文件",
          "重新打开后备份位置丢了"
        );
        ctx.assert.includes(await ctx.page.textContent("#backup-sub"), SAVE_NAME);
      },
    },
    {
      name: "备份文件是能用记事本看懂的纯文本",
      async run(ctx) {
        await stubPickers(ctx.page, SAVE_NAME, OPEN_NAME);
        await wipe(ctx.page, ctx.httpUrl, ctx.httpProbeUrl);
        await addTask(ctx, "读 30 页书");
        await ctx.sleep(1200);
        await ctx.page.click("#backup-chip");
        await ctx.page.click('[data-act="backup-choose"]');
        await ctx.sleep(1500);

        const raw = await readBackup(ctx.page, SAVE_NAME);
        ctx.assert.ok(raw.indexOf("\n") > -1, "备份文件不是格式化的文本");
        ctx.assert.includes(raw, '"app": "今天"', "备份文件里没有标识");
        ctx.assert.includes(raw, "读 30 页书", "备份文件里看不到任务名");
        ctx.assert.includes(raw, "version", "备份文件里没有版本号");
      },
    },
    {
      name: "从文件恢复：先确认再覆盖，点取消不会动现有数据",
      async run(ctx) {
        await stubPickers(ctx.page, SAVE_NAME, OPEN_NAME);
        await wipe(ctx.page, ctx.httpUrl, ctx.httpProbeUrl);

        const today = await ctx.page.evaluate(() => window.__jintian.todayKey());
        const payload = {
          app: "今天",
          version: 1,
          savedAt: new Date().toISOString(),
          data: {
            version: 1,
            tasks: {
              [today]: [
                { id: "r1", name: "从备份里回来的任务", est: 30, spentSec: 20 * 60, done: true, feeling: "" },
              ],
            },
            summaries: { [today]: "这是备份里的总结。" },
            notes: { [today]: [{ id: "rn1", time: "10:00", text: "备份里的随手记。" }] },
            timer: null,
            settings: {},
          },
        };
        await writeBackupFile(ctx.page, OPEN_NAME, JSON.stringify(payload, null, 2));
        await addTask(ctx, "现在这条不能被冲掉");
        await ctx.sleep(600);

        await ctx.page.click("#backup-chip");
        await ctx.page.click('[data-act="backup-restore"]');
        await ctx.page.waitForSelector("#dialog-confirm", { state: "visible", timeout: 4000 });
        ctx.assert.includes(await ctx.page.textContent("#confirm-body"), "覆盖", "没有提示会覆盖数据");
        await ctx.page.click('[data-act="confirm-cancel"]');
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await taskNames(ctx.page)).join("/"), "现在这条不能被冲掉", "点了取消却把数据改了");

        await ctx.page.click("#backup-chip");
        await ctx.page.click('[data-act="backup-restore"]');
        await ctx.page.waitForSelector("#dialog-confirm", { state: "visible", timeout: 4000 });
        await ctx.page.click('[data-act="confirm-ok"]');
        await ctx.sleep(900);
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await taskNames(ctx.page)).join("/"), "从备份里回来的任务", "恢复后任务不对");
        await ctx.page.click('.nav-item[data-goto="notes"]');
        ctx.assert.includes(await ctx.page.inputValue("#summary"), "这是备份里的总结", "恢复后总结没回来");
        ctx.assert.includes(await ctx.page.textContent("#quick-list"), "备份里的随手记", "恢复后随手记没回来");
      },
    },
    {
      name: "可以换一个备份文件位置，之后写进新文件",
      async run(ctx) {
        await stubPickers(ctx.page, SAVE_NAME, OPEN_NAME);
        await wipe(ctx.page, ctx.httpUrl, ctx.httpProbeUrl);
        await addTask(ctx, "第一条");
        await ctx.sleep(600);
        await ctx.page.click("#backup-chip");
        await ctx.page.click('[data-act="backup-choose"]');
        await ctx.sleep(1500);
        ctx.assert.includes(await ctx.page.textContent("#backup-sub"), SAVE_NAME);
        ctx.assert.includes(await ctx.page.textContent("#backup-choose"), "换一个备份文件", "按钮文字没跟着变");

        await ctx.page.evaluate((name) => {
          Object.defineProperty(window, "showSaveFilePicker", {
            configurable: true,
            writable: true,
            value: async () => {
              const root = await navigator.storage.getDirectory();
              return root.getFileHandle(name, { create: true });
            },
          });
        }, SAVE_NAME_2);
        await ctx.page.click('[data-act="backup-choose"]');
        await ctx.sleep(1500);
        ctx.assert.includes(await ctx.page.textContent("#backup-sub"), SAVE_NAME_2, "换位置后状态条没变");
        const raw = await readBackup(ctx.page, SAVE_NAME_2);
        ctx.assert.includes(raw, "第一条", "换位置后没有写到新文件");
      },
    },
    {
      name: "备份文件读不出来时，给出提示且不动现有数据",
      async run(ctx) {
        await stubPickers(ctx.page, SAVE_NAME, OPEN_NAME);
        await wipe(ctx.page, ctx.httpUrl, ctx.httpProbeUrl);
        await addTask(ctx, "保住这条");
        await ctx.sleep(600);
        await writeBackupFile(ctx.page, OPEN_NAME, "{这不是合法的备份");

        await ctx.page.click("#backup-chip");
        await ctx.page.click('[data-act="backup-restore"]');
        await ctx.sleep(1200);
        ctx.assert.eq(await ctx.page.isVisible("#dialog-confirm"), false, "坏文件不该进到确认那一步");
        ctx.assert.includes(await ctx.page.textContent("#backup-status"), "没能", "没有给出读不出来的提示");
        await ctx.page.click('[data-act="backup-close"]');
        await ctx.page.click('.nav-item[data-goto="plan"]');
        ctx.assert.eq((await taskNames(ctx.page)).join("/"), "保住这条", "读坏文件把现有数据搞没了");
      },
    },
  ],
};
