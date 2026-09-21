"use strict";

const fs = require("node:fs");
const path = require("node:path");
const h = require("./helper");

const PROBE = h.toFileUrl(path.join(h.FIXTURES, "probe.html"));
const KEY = "going-probe-key";
const VALUE = "存住了-2026-09-21";

async function open(page, url) {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__probe, null, { timeout: 5000 });
}

module.exports = {
  phase: 0,
  title: "技术验证",
  tests: [
    {
      name: "T1 本地网页能把数据存进浏览器，刷新后还在",
      async run({ page, assert }) {
        await open(page, PROBE);
        const put = await page.evaluate(([k, v]) => window.__probe.localSet(k, v), [KEY, VALUE]);
        assert.ok(put.ok, "写入失败：" + JSON.stringify(put));
        await page.reload({ waitUntil: "load" });
        await page.waitForFunction(() => !!window.__probe);
        const got = await page.evaluate((k) => window.__probe.localGet(k), KEY);
        assert.ok(got.ok, "读取失败：" + JSON.stringify(got));
        assert.eq(got.value, VALUE, "刷新后读到的内容不对");
      },
    },
    {
      name: "T2 本地网页能用 IndexedDB（用于保存备份文件的位置）",
      async run({ page, assert }) {
        await open(page, PROBE);
        const put = await page.evaluate(() => window.__probe.idbPut("probe-db", "greet", "你好"));
        assert.ok(put.ok, "IndexedDB 写入失败：" + JSON.stringify(put));
        await page.reload({ waitUntil: "load" });
        await page.waitForFunction(() => !!window.__probe);
        const got = await page.evaluate(() => window.__probe.idbGet("probe-db", "greet"));
        assert.ok(got.ok, "IndexedDB 读取失败：" + JSON.stringify(got));
        assert.eq(got.value, "你好", "刷新后 IndexedDB 里的内容不对");
      },
    },
    {
      name: "T3 本地网页具备写文件的能力（自动备份的前提）",
      async run({ page, assert }) {
        await open(page, PROBE);
        const info = await page.evaluate(() => window.__probe.info());
        assert.eq(info.secure, true, "这个页面不是安全上下文，浏览器的存储能力会被限制");
        if (info.savePicker !== "function") {
          throw new Error(
            "这个环境没有 showSaveFilePicker，自动写备份文件做不了，需要改用「手动导出」方案（要先跟用户确认）"
          );
        }
        assert.ok(info.openPicker === "function", "缺少 showOpenFilePicker，从文件恢复会做不了");
      },
    },
    {
      name: "T4 时间基准可信：页面在后台时 Date.now 仍按真实时间走",
      async run({ page, assert, context, sleep }) {
        await open(page, PROBE);
        await page.evaluate(() => {
          window.__t0 = Date.now();
        });
        const other = await context.newPage();
        await other.goto("about:blank");
        await other.bringToFront();
        await sleep(1500);
        const measured = await page.evaluate(() => Date.now() - window.__t0);
        await other.close();
        assert.near(measured, 1500, 400, "后台页面的时间基准不准，倒计时会失真");
      },
    },
    {
      name: "T5 把页面换到别的文件夹，数据仍在（决定代码文件能不能随便挪）",
      async run({ page, assert }) {
        const moved = path.join(h.FIXTURES, "moved");
        fs.mkdirSync(moved, { recursive: true });
        const target = path.join(moved, "probe.html");
        fs.copyFileSync(path.join(h.FIXTURES, "probe.html"), target);
        try {
          await open(page, h.toFileUrl(target));
          const got = await page.evaluate((k) => window.__probe.localGet(k), KEY);
          assert.ok(got.ok, "读取失败：" + JSON.stringify(got));
          assert.eq(got.value, VALUE, "换了文件夹就读不到原来存的数据了");
        } finally {
          fs.rmSync(moved, { recursive: true, force: true });
        }
      },
    },
  ],
};
