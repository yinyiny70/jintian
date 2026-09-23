"use strict";
const h = require("./helper");

async function openShop(page) {
  await h.freshState(page);
  await page.click("#shop-chip");
  await page.waitForSelector('.page[data-page="shop"]', { state: "visible" });
}

async function givePoints(page, value) {
  await page.evaluate((v) => {
    const j = window.__jintian;
    j.state.points.balance = v;
    j.state.points.earned = Math.max(j.state.points.earned, v);
    j.saveNow();
    j.renderAll();
  }, value);
}

function card(page, id) {
  return page.locator('.item[data-item="' + id + '"]');
}

// 换下来（已经有的就跳过），等它真的变成"已换到手"
async function buyItem(page, id) {
  const el = card(page, id);
  if (await el.evaluate((n) => n.classList.contains("is-owned"))) return;
  await el.click();
  await page.waitForFunction(
    (itemId) => {
      const node = document.querySelector('.item[data-item="' + itemId + '"]');
      return node && node.classList.contains("is-owned");
    },
    id,
    { timeout: 5000 }
  );
}

// 再点一下就用上了（摆件是「摆出来」，主题/底纹/花边是「用这个」）
async function toggleUse(page, id) {
  await card(page, id).click();
  await page.waitForTimeout(150);
}

async function buyAndUse(page, id) {
  await buyItem(page, id);
  await toggleUse(page, id);
}

function goHome(page) {
  return page.click('.nav-item[data-goto="home"]');
}

module.exports = {
  phase: 19,
  title: "第四版 · 装饰真正用上",
  tests: [
    {
      name: "摆件：摆在首页角落，最多 3 个，多了会挡住并说清原因",
      async run(ctx) {
        await openShop(ctx.page);
        await givePoints(ctx.page, 300);
        for (const id of ["orn-plant", "orn-books", "orn-pen"]) {
          await buyAndUse(ctx.page, id);
        }
        await goHome(ctx.page);
        ctx.assert.eq(await ctx.page.isVisible("#home-sill"), true, "摆了摆件，首页角落却没有");
        ctx.assert.eq(await ctx.page.$$eval("#home-sill .ic", (els) => els.length), 3, "角落里的摆件数量不对");

        // 第 4 个：位置满了
        await ctx.page.click("#shop-chip");
        await ctx.page.waitForSelector('.page[data-page="shop"]', { state: "visible" });
        // 第 4 个只换、先不摆——位置上已经满了
        await buyItem(ctx.page, "orn-cat");
        const cat = await card(ctx.page, "orn-cat").evaluate((el) => ({
          state: el.querySelector(".item-state").textContent.trim(),
          locked: el.classList.contains("is-locked"),
        }));
        ctx.assert.eq(cat.state, "位置满了", "第 4 个摆件没有被挡住：" + cat.state);
        ctx.assert.eq(cat.locked, true, "第 4 个摆件居然还能点");

        // 收起来一个，就能摆新的了
        await card(ctx.page, "orn-plant").click();
        await ctx.page.waitForTimeout(150);
        await card(ctx.page, "orn-cat").click();
        await ctx.page.waitForTimeout(150);
        await goHome(ctx.page);
        const sill = await ctx.page.$$eval("#home-sill .ic use", (els) =>
          els.map((e) => e.getAttribute("href"))
        );
        ctx.assert.eq(sill.length, 3, "换了一轮之后角落数量不对");
        ctx.assert.notIncludes(sill.join("/"), "i-orn-plant", "收起来的摆件还摆在上面");
        ctx.assert.includes(sill.join("/"), "i-orn-cat", "新摆的没上去");

        // 关掉重开，摆的东西还在
        await ctx.page.reload({ waitUntil: "load" });
        await goHome(ctx.page);
        ctx.assert.eq(await ctx.page.$$eval("#home-sill .ic", (els) => els.length), 3, "刷新之后摆件没了");
      },
    },
    {
      name: "计时开始后，首页角落的摆件跟着退场（首页只留倒计时）",
      async run(ctx) {
        await openShop(ctx.page);
        await givePoints(ctx.page, 100);
        await buyAndUse(ctx.page, "orn-cup");
        await ctx.page.click('.nav-item[data-goto="plan"]');
        await h.addTask(ctx.page, "写点东西", 25);
        await ctx.page.click('.task [data-act="start"]');
        await ctx.page.waitForSelector("#dialog-start", { state: "visible" });
        await ctx.page.click('[data-act="start-confirm"]');
        await ctx.page.waitForTimeout(400);
        await goHome(ctx.page);
        ctx.assert.eq(await ctx.page.isVisible("#home-sill"), false, "在计时，角落还摆着东西");

        await ctx.page.click('[data-act="home-stop"]');
        await ctx.page.waitForTimeout(400);
        ctx.assert.eq(await ctx.page.isVisible("#home-sill"), true, "计时结束了，摆件没回来");
      },
    },
    {
      name: "主题：换了之后整页的底色和主色真的跟着变",
      async run(ctx) {
        await openShop(ctx.page);
        const before = await ctx.page.evaluate(() => {
          const cs = getComputedStyle(document.documentElement);
          return {
            bg: cs.getPropertyValue("--bg").trim(),
            accent: cs.getPropertyValue("--accent").trim(),
            body: getComputedStyle(document.body).backgroundColor,
          };
        });
        await givePoints(ctx.page, 100);
        await buyAndUse(ctx.page, "th-zhu");
        const after = await ctx.page.evaluate(() => {
          const cs = getComputedStyle(document.documentElement);
          return {
            classes: document.documentElement.className,
            bg: cs.getPropertyValue("--bg").trim(),
            accent: cs.getPropertyValue("--accent").trim(),
            body: getComputedStyle(document.body).backgroundColor,
          };
        });
        ctx.assert.includes(after.classes, "th-zhu", "主题类没挂到根上：" + after.classes);
        ctx.assert.ok(after.bg !== before.bg, "换了主题，底色没变");
        ctx.assert.ok(after.accent !== before.accent, "换了主题，主色没变");
        ctx.assert.ok(after.body !== before.body, "换了主题，页面背景色没变");

        // 再点一下收起来，回到默认
        await buyAndUse(ctx.page, "th-zhu");
        const back = await ctx.page.evaluate(() => ({
          classes: document.documentElement.className,
          bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
        }));
        ctx.assert.notIncludes(back.classes, "th-zhu", "点了「正在用」没有收起来");
        ctx.assert.eq(back.bg, before.bg, "收起来之后没有回到默认配色");
      },
    },
    {
      name: "金句的底纹和花边：能同时用，也能各自收起来",
      async run(ctx) {
        await openShop(ctx.page);
        await givePoints(ctx.page, 200);
        await buyAndUse(ctx.page, "pa-xuan");
        await buyAndUse(ctx.page, "fr-vine");
        await goHome(ctx.page);

        let info = await ctx.page.evaluate(() => {
          const el = document.querySelector("#home-quote-wrap");
          const cs = getComputedStyle(el);
          return {
            cls: el.className,
            bg: cs.backgroundColor,
            padding: cs.paddingTop,
          };
        });
        ctx.assert.includes(info.cls, "pa-xuan", "底纹类没挂上：" + info.cls);
        ctx.assert.includes(info.cls, "fr-vine", "花边类没挂上：" + info.cls);
        ctx.assert.ok(info.bg !== "rgba(0, 0, 0, 0)", "底纹没有铺上（背景还是透明的）");
        ctx.assert.ok(parseInt(info.padding, 10) >= 16, "铺了纸却没有留出边距：" + info.padding);

        // 收掉底纹，花边还在
        await ctx.page.click("#shop-chip");
        await ctx.page.waitForSelector('.page[data-page="shop"]', { state: "visible" });
        await buyAndUse(ctx.page, "pa-xuan");
        await goHome(ctx.page);
        info = await ctx.page.evaluate(() => {
          const el = document.querySelector("#home-quote-wrap");
          return { cls: el.className, bg: getComputedStyle(el).backgroundColor };
        });
        ctx.assert.notIncludes(info.cls, "pa-xuan", "底纹没有收起来");
        ctx.assert.includes(info.cls, "fr-vine", "收底纹的时候把花边也弄没了");
        ctx.assert.eq(info.bg, "rgba(0, 0, 0, 0)", "底纹收起来了，纸还在");

        // 关掉重开，花边还在
        await ctx.page.reload({ waitUntil: "load" });
        await goHome(ctx.page);
        ctx.assert.includes(
          await ctx.page.getAttribute("#home-quote-wrap", "class"),
          "fr-vine",
          "刷新之后花边没了"
        );
      },
    },
  ],
};
