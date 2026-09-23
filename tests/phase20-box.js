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

async function placeItem(page, id) {
  await card(page, id).click();
  await page.waitForTimeout(150);
}

// 点一次"抽一个"，把抽到的名字带回来，再把照片窗口收好
async function drawOnce(page) {
  await page.click("#box-open");
  await page.waitForSelector("#dialog-photo", { state: "visible" });
  const name = (await page.textContent("#photo-name")).trim();
  const word = (await page.textContent("#photo-word")).trim();
  const src = await page.getAttribute("#photo-img", "src");
  // 收好按钮在开奖动画里是慢慢浮出来的，这里不等动画，直接点（force）
  await page.click('[data-act="photo-close"]', { force: true });
  await page.waitForSelector("#dialog-photo", { state: "hidden" });
  return { name: name, word: word, src: src };
}

module.exports = {
  phase: 20,
  title: "第五版 · 朋友摆件与盲盒礼物",
  tests: [
    {
      name: "朋友摆件和线条摆件一样能换、能摆，加起来最多同时摆 3 个",
      async run(ctx) {
        await openShop(ctx.page);
        await givePoints(ctx.page, 400);
        for (const id of ["orn-plant", "fr-1", "fr-2"]) {
          await buyItem(ctx.page, id);
          await placeItem(ctx.page, id);
        }
        await ctx.page.click('.nav-item[data-goto="home"]');
        ctx.assert.eq(await ctx.page.isVisible("#home-sill"), true, "摆了摆件，首页角落却没有");
        ctx.assert.eq(await ctx.page.$$eval("#home-sill img", (els) => els.length), 2, "朋友摆件没有摆上去");
        ctx.assert.eq(
          await ctx.page.$$eval("#home-sill .ic", (els) => els.length),
          1,
          "线条摆件没有摆上去"
        );

        // 第 4 个：位置满了
        await ctx.page.click("#shop-chip");
        await ctx.page.waitForSelector('.page[data-page="shop"]', { state: "visible" });
        await buyItem(ctx.page, "fr-3");
        const third = await card(ctx.page, "fr-3").evaluate((el) => ({
          state: el.querySelector(".item-state").textContent.trim(),
          locked: el.classList.contains("is-locked"),
        }));
        ctx.assert.eq(third.state, "位置满了", "第 4 个摆件没被挡住：" + third.state);
        ctx.assert.eq(third.locked, true, "第 4 个摆件居然还能点");
      },
    },
    {
      name: "首页角落的摆件确实变大了（你说的那个「太小了」）",
      async run(ctx) {
        await openShop(ctx.page);
        await givePoints(ctx.page, 400);
        await buyItem(ctx.page, "orn-cat");
        await placeItem(ctx.page, "orn-cat");
        await buyItem(ctx.page, "fr-4");
        await placeItem(ctx.page, "fr-4");
        await ctx.page.click('.nav-item[data-goto="home"]');
        const size = await ctx.page.evaluate(() => {
          const icon = document.querySelector("#home-sill .ic");
          const img = document.querySelector("#home-sill img");
          const box = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0);
          return { icon: box(icon), img: box(img) };
        });
        ctx.assert.ok(size.icon >= 44, "线条摆件还是很小：" + size.icon + " 像素");
        ctx.assert.ok(size.img >= 44, "图片摆件很小：" + size.img + " 像素");
      },
    },
    {
      name: "盲盒：分不够抽不了，会写清还差多少",
      async run(ctx) {
        await openShop(ctx.page);
        const total = await ctx.page.evaluate(() => window.__jintian.boxTotal());
        ctx.assert.ok(total >= 1, "盲盒里一张照片都没有");
        ctx.assert.eq(await ctx.page.$$eval(".gift-slot", (els) => els.length), total, "礼物柜格子数和照片数对不上");
        ctx.assert.eq(
          await ctx.page.$$eval(".gift-slot.is-locked", (els) => els.length),
          total,
          "一张都没抽，应该全是问号"
        );
        ctx.assert.eq(await ctx.page.isDisabled("#box-open"), true, "0 分居然能抽");
        ctx.assert.includes(await ctx.page.textContent("#box-open"), "还差", "没写清还差多少分");

        await givePoints(ctx.page, 99);
        ctx.assert.eq(await ctx.page.isDisabled("#box-open"), true, "99 分也能抽？");
        ctx.assert.includes(await ctx.page.textContent("#box-open"), "还差 1 分", "差多少分写得不对");

        await givePoints(ctx.page, 100);
        ctx.assert.eq(await ctx.page.isDisabled("#box-open"), false, "100 分了还是不能抽");
        ctx.assert.includes(await ctx.page.textContent("#box-open"), "抽一个", "按钮文案不对");
      },
    },
    {
      name: "盲盒：一直抽到集齐，张张不重复，扣分正好对上",
      async run(ctx) {
        await openShop(ctx.page);
        await givePoints(ctx.page, 900);
        const total = await ctx.page.evaluate(() => window.__jintian.boxTotal());
        const names = [];
        for (let i = 0; i < total; i++) {
          const got = await drawOnce(ctx.page);
          ctx.assert.ok(got.name.length > 0, "第 " + (i + 1) + " 次抽到的照片没名字");
          ctx.assert.ok(got.word.length > 0, "第 " + (i + 1) + " 次抽到的照片没寄语");
          ctx.assert.includes(got.src, "assets/box/", "照片路径不对：" + got.src);
          names.push(got.name);
        }
        ctx.assert.eq(new Set(names).size, total, "抽了 " + total + " 次，出现了重复：" + names.join(" / "));
        ctx.assert.eq(
          (await ctx.page.textContent("#shop-balance")).trim(),
          String(900 - 100 * total),
          "扣分不对（应该扣 " + 100 * total + "）"
        );

        // 集齐之后
        ctx.assert.eq(await ctx.page.isDisabled("#box-open"), true, "集齐了还能继续抽");
        ctx.assert.includes(await ctx.page.textContent("#box-open"), "全部集齐", "集齐后按钮文案不对");
        ctx.assert.eq(
          await ctx.page.$$eval(".gift-slot.is-locked", (els) => els.length),
          0,
          "集齐了还有问号格子"
        );
        const again = await ctx.page.evaluate(() => window.__jintian.openBox());
        ctx.assert.eq(again, null, "集齐之后还能抽出东西");
      },
    },
    {
      name: "抽到时有开奖动画（盒子 → 弹开 → 照片飞入），点已经抽到的照片时不放动画",
      async run(ctx) {
        await openShop(ctx.page);
        await givePoints(ctx.page, 200);

        await ctx.page.click("#box-open");
        await ctx.page.waitForSelector("#dialog-photo", { state: "visible" });
        const fresh = await ctx.page.evaluate(() => {
          const cs = (sel) => getComputedStyle(document.querySelector(sel));
          return {
            flagged: document.querySelector("#dialog-photo").classList.contains("is-fresh"),
            box: cs(".reveal-box").display,
            flash: cs(".reveal-flash").display,
            ring: cs(".reveal-ring").display,
            spark: cs(".spark").display,
            kicker: cs(".photo-kicker").display,
            photoAnim: cs(".photo-frame").animationName,
            photoDelay: parseFloat(cs(".photo-frame").animationDelay) || 0,
          };
        });
        ctx.assert.eq(fresh.flagged, true, "抽到的时候没有挂开奖的标记");
        ctx.assert.ok(fresh.box !== "none", "抽到时没有先出现礼物盒");
        ctx.assert.ok(fresh.flash !== "none", "开盒时没有那一下闪光");
        ctx.assert.ok(fresh.ring !== "none", "开盒时没有金色光环");
        ctx.assert.ok(fresh.spark !== "none", "开盒时没有飞散的光点");
        ctx.assert.ok(fresh.kicker !== "none", "没有「恭喜抽到」那行字");
        ctx.assert.includes(fresh.photoAnim, "photo-in", "照片没有飞入动画：" + fresh.photoAnim);
        ctx.assert.ok(fresh.photoDelay >= 1, "照片出现得太早，没有先开盒的过程：" + fresh.photoDelay);

        // 收好，再点礼物柜里那张已经抽到的
        await ctx.page.click('[data-act="photo-close"]', { force: true });
        await ctx.page.waitForSelector("#dialog-photo", { state: "hidden" });
        await ctx.page.click(".gift-slot.is-open");
        await ctx.page.waitForSelector("#dialog-photo", { state: "visible" });
        const again = await ctx.page.evaluate(() => {
          const cs = (sel) => getComputedStyle(document.querySelector(sel));
          return {
            flagged: document.querySelector("#dialog-photo").classList.contains("is-fresh"),
            box: cs(".reveal-box").display,
            photoAnim: cs(".photo-frame").animationName,
            photoOpacity: cs(".photo-frame").opacity,
          };
        });
        ctx.assert.eq(again.flagged, false, "看已经抽到的照片时不该放开奖动画");
        ctx.assert.eq(again.box, "none", "看已经抽到的照片时不该出现礼物盒");
        ctx.assert.eq(again.photoAnim, "none", "看已经抽到的照片时照片不该再飞一次");
        ctx.assert.eq(again.photoOpacity, "1", "照片应该马上就能看到");
        await ctx.page.click('[data-act="photo-close"]');
      },
    },
    {
      name: "礼物柜：点开一张能看大图，名字和寄语都在；关掉重开收集还在",
      async run(ctx) {
        await openShop(ctx.page);
        await givePoints(ctx.page, 300);
        const got = await drawOnce(ctx.page);

        // 礼物柜里应该出现一张照片
        ctx.assert.eq(await ctx.page.$$eval(".gift-slot.is-open", (els) => els.length), 1, "抽到了却没进礼物柜");
        await ctx.page.click('.gift-slot.is-open');
        await ctx.page.waitForSelector("#dialog-photo", { state: "visible" });
        ctx.assert.eq((await ctx.page.textContent("#photo-name")).trim(), got.name, "大图上的名字对不上");
        ctx.assert.includes(await ctx.page.textContent("#photo-word"), got.word.slice(0, 6), "寄语没显示出来");
        const shown = await ctx.page.$eval("#photo-img", (el) => ({
          src: el.getAttribute("src"),
          w: Math.round(el.getBoundingClientRect().width),
        }));
        ctx.assert.includes(shown.src, "assets/box/", "大图路径不对");
        ctx.assert.ok(shown.w >= 200, "大图显示得太小：" + shown.w);
        await ctx.page.click('[data-act="photo-close"]');

        // 关掉重开
        await ctx.page.reload({ waitUntil: "load" });
        await ctx.page.click("#shop-chip");
        await ctx.page.waitForSelector('.page[data-page="shop"]', { state: "visible" });
        ctx.assert.eq(await ctx.page.$$eval(".gift-slot.is-open", (els) => els.length), 1, "刷新之后收集没了");
        ctx.assert.eq((await ctx.page.textContent("#shop-balance")).trim(), "200", "刷新之后分数不对");
      },
    },
  ],
};
