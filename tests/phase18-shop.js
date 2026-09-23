"use strict";
const h = require("./helper");

async function openShop(page) {
  await h.freshState(page);
  await page.click("#shop-chip");
  await page.waitForSelector('.page[data-page="shop"]', { state: "visible" });
}

// 测试用：直接给点分（真实赚分那条路在第 17 阶段已经一条条测过了）
async function givePoints(page, value) {
  await page.evaluate((v) => {
    const j = window.__jintian;
    j.state.points.balance = v;
    j.state.points.earned = Math.max(j.state.points.earned, v);
    j.saveNow();
    j.renderAll();
  }, value);
}

function itemsOf(page) {
  return page.$$eval(".item", (els) =>
    els.map((e) => ({
      id: e.dataset.item,
      name: e.querySelector(".item-name").textContent.trim(),
      price: e.querySelector(".item-price").textContent.trim(),
      state: e.querySelector(".item-state").textContent.trim(),
      locked: e.classList.contains("is-locked"),
      owned: e.classList.contains("is-owned"),
    }))
  );
}

module.exports = {
  phase: 18,
  title: "第四版 · 小铺货架与兑换",
  tests: [
    {
      name: "货架分四类，一共 23 件，每件都标着分数",
      async run(ctx) {
        await openShop(ctx.page);
        ctx.assert.eq(await ctx.page.$$eval(".shelf", (els) => els.length), 4, "货架不是四类");
        const items = await itemsOf(ctx.page);
        ctx.assert.eq(items.length, 23, "东西的数量不对：" + items.length);
        const kinds = await ctx.page.$$eval(".shelf-name", (els) => els.map((e) => e.textContent.trim()));
        ctx.assert.eq(kinds.join("/"), "角落摆件/主题配色/金句底纹/金句花边", "四类货架的顺序或名字不对");

        const bad = items.filter((it) => !it.name || !/\d+/.test(it.price));
        ctx.assert.eq(bad.length, 0, "有东西没写名字或分数：" + JSON.stringify(bad.slice(0, 3)));

        // 一分没有的时候：全都换不了，而且告诉你还差多少
        const locked = items.filter((it) => it.locked);
        ctx.assert.eq(locked.length, 23, "没分的时候居然有东西可以换");
        const noHint = items.filter((it) => it.state.indexOf("还差") < 0);
        ctx.assert.eq(noHint.length, 0, "没写清还差多少分：" + JSON.stringify(noHint.slice(0, 3)));

        // 全部换完要多少分：8×30 + 6×80 + 5×25 + 4×25 = 945
        const total = items.reduce((sum, it) => sum + (parseInt(it.price.replace(/\D/g, ""), 10) || 0), 0);
        ctx.assert.eq(total, 945, "全部换完要的分数变了：" + total);
      },
    },
    {
      name: "分不够的时候换不了，分够了才能换（并且真的扣分）",
      async run(ctx) {
        await openShop(ctx.page);
        await givePoints(ctx.page, 29);
        let items = await itemsOf(ctx.page);
        let plant = items.filter((it) => it.id === "orn-plant")[0];
        ctx.assert.eq(plant.locked, true, "29 分居然能换 30 分的摆件");
        ctx.assert.includes(plant.state, "还差 1 分", "差多少分写得不对：" + plant.state);

        await givePoints(ctx.page, 30);
        items = await itemsOf(ctx.page);
        plant = items.filter((it) => it.id === "orn-plant")[0];
        ctx.assert.eq(plant.locked, false, "30 分了还是换不了");
        ctx.assert.eq(plant.state, "换下来", "该能换的时候没提示能换");

        await ctx.page.click('.item[data-item="orn-plant"]');
        await ctx.page.waitForFunction(
          () => document.querySelector("#shop-balance").textContent.trim() === "0",
          null,
          { timeout: 5000 }
        );
        items = await itemsOf(ctx.page);
        plant = items.filter((it) => it.id === "orn-plant")[0];
        ctx.assert.eq(plant.owned, true, "换完了却没记下来");
        // 换到手之后，按钮就变成"摆出来"（摆件）/"用这个"（主题等）
        ctx.assert.eq(plant.state, "摆出来", "换完了没给下一步的提示：" + plant.state);
      },
    },
    {
      name: "换到手的永久归你：关掉重开还在，再点也不会重复扣分",
      async run(ctx) {
        await openShop(ctx.page);
        await givePoints(ctx.page, 100);
        await ctx.page.click('.item[data-item="th-zhu"]'); // 朱砂，80 分
        await ctx.page.waitForFunction(
          () => document.querySelector("#shop-balance").textContent.trim() === "20",
          null,
          { timeout: 5000 }
        );

        // 再点一次（按钮已经是"已经换到了"，应该点不动）
        const again = await ctx.page.evaluate(() => {
          document.querySelector('.item[data-item="th-zhu"]').click();
          return window.__jintian.pointsStatus().balance;
        });
        ctx.assert.eq(again, 20, "重复点又扣了一次分");

        // 关掉重开
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click("#shop-chip");
        await ctx.page.waitForSelector('.page[data-page="shop"]', { state: "visible" });
        ctx.assert.eq((await ctx.page.textContent("#shop-balance")).trim(), "20", "刷新之后分数不对");
        const items = await itemsOf(ctx.page);
        const zhu = items.filter((it) => it.id === "th-zhu")[0];
        ctx.assert.eq(zhu.owned, true, "刷新之后换到的东西没了");
        ctx.assert.ok(
          zhu.state === "正在用" || zhu.state === "用这个",
          "刷新之后状态不对：" + zhu.state
        );
      },
    },
    {
      name: "换到的东西会算进「已收 N / 总数」，四类各自算各自的",
      async run(ctx) {
        await openShop(ctx.page);
        await givePoints(ctx.page, 200);
        await ctx.page.click('.item[data-item="orn-cat"]');
        await ctx.page.click('.item[data-item="pa-xuan"]');
        const hints = await ctx.page.$$eval(".shelf-hint", (els) => els.map((e) => e.textContent.replace(/\s+/g, "")));
        ctx.assert.includes(hints[0], "已收1/8", "摆件那一栏的计数不对：" + hints[0]);
        ctx.assert.includes(hints[2], "已收1/5", "底纹那一栏的计数不对：" + hints[2]);
        ctx.assert.includes(hints[1], "已收0/6", "主题那一栏的计数不对：" + hints[1]);
        ctx.assert.includes(hints[3], "已收0/4", "花边那一栏的计数不对：" + hints[3]);
      },
    },
    {
      name: "六套主题的小样各自长得不一样（底色和主色条都能看出来）",
      async run(ctx) {
        await openShop(ctx.page);
        const all = await ctx.page.$$eval(".item .swatch", (els) =>
          els.map((e) => {
            const cs = getComputedStyle(e);
            return {
              cls: e.className,
              bg: cs.backgroundColor,
              bar: getComputedStyle(e, "::after").backgroundColor,
            };
          })
        );
        const themes = all.filter((x) => x.cls.indexOf("th-") >= 0);
        ctx.assert.eq(themes.length, 6, "主题小样不是 6 个");
        const bgs = Array.from(new Set(themes.map((t) => t.bg)));
        const bars = Array.from(new Set(themes.map((t) => t.bar)));
        ctx.assert.eq(bgs.length, 6, "六套主题的底色看起来是一样的：" + JSON.stringify(bgs));
        ctx.assert.eq(bars.length, 6, "六套主题的主色条看起来是一样的：" + JSON.stringify(bars));
        const transparent = themes.filter((t) => t.bar === "rgba(0, 0, 0, 0)");
        ctx.assert.eq(transparent.length, 0, "有主题小样底下那条主色没画出来");
      },
    },
  ],
};
