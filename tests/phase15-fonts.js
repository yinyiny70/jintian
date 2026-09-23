"use strict";
const h = require("./helper");

// 在页面里把"第 N 条金句"显示出来。
// 金句是按"10 分钟一个时段"选的，所以给它一个落在那个时段里的时间戳就行，
// 用不着改系统时间、也不用等 10 分钟。
async function showQuoteAt(page, index) {
  return page.evaluate((idx) => {
    const j = window.__jintian;
    const real = Date.now;
    Date.now = () => idx * j.quoteSlotMs + j.quoteSlotMs / 2;
    try {
      j.renderQuote(true);
    } finally {
      Date.now = real;
    }
    const el = document.querySelector("#home-quote");
    const wrap = document.querySelector("#home-quote-wrap");
    return {
      kind: wrap.getAttribute("data-kind"),
      cls: el.className,
      family: getComputedStyle(el).fontFamily,
      size: getComputedStyle(el).fontSize,
      text: el.textContent,
    };
  }, index);
}

// 直接问浏览器："这段字到底是用哪个字体画出来的"
// （只看 CSS 里写了什么不够，字体没装的话浏览器会悄悄换一个）
async function usedFonts(page, selector) {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("DOM.enable");
    await client.send("CSS.enable");
    const doc = await client.send("DOM.getDocument", { depth: 1 });
    const found = await client.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: selector,
    });
    const res = await client.send("CSS.getPlatformFontsForNode", { nodeId: found.nodeId });
    return (res.fonts || []).map((f) => f.familyName);
  } finally {
    await client.detach().catch(() => {});
  }
}

function indexOfKind(page, kind) {
  return page.evaluate((k) => {
    const list = window.JINTIAN_QUOTES || [];
    for (let i = 0; i < list.length; i++) if (list[i].k === k) return i;
    return -1;
  }, kind);
}

module.exports = {
  phase: 15,
  title: "第四版 · 金句分三种字体",
  tests: [
    {
      name: "三种内容三种字：古诗用行楷、歌词用楷体、名言保持原样（浏览器真的在用它）",
      async run(ctx) {
        await h.openApp(ctx.page);
        const cases = [
          // 同一个字体，CSS 里写中文名、浏览器有时报英文名，两种都算对
          { k: "gu", label: "古诗", wantKind: "poem", fonts: ["华文行楷", "STXingkai"] },
          { k: "ge", label: "歌词", wantKind: "lyric", fonts: ["楷体", "KaiTi", "STKaiti"] },
          { k: "ming", label: "名言", wantKind: "saying", fonts: [] },
        ];
        for (const c of cases) {
          const idx = await indexOfKind(ctx.page, c.k);
          ctx.assert.ok(idx >= 0, "金句库里找不到「" + c.label + "」这一类");
          const info = await showQuoteAt(ctx.page, idx);
          ctx.assert.eq(info.kind, c.wantKind, c.label + " 的分类没挂上（data-kind=" + info.kind + "）");
          ctx.assert.includes(info.cls, "is-" + c.wantKind, c.label + " 的样式类没挂上：" + info.cls);
          const hit = (text) => c.fonts.some((f) => text.indexOf(f) >= 0);
          if (c.fonts.length) {
            ctx.assert.ok(
              hit(info.family),
              c.label + " 的字体族里没有 " + c.fonts.join(" 或 ") + "：" + info.family
            );
          } else {
            ctx.assert.ok(!hit(info.family), "名言不该用艺术字体：" + info.family);
          }

          const used = await usedFonts(ctx.page, "#home-quote");
          const usedText = used.join("/");
          if (c.fonts.length) {
            ctx.assert.ok(
              hit(usedText),
              c.label + " 实际是用「" + usedText + "」画的，不是 " + c.fonts.join(" 或 ")
            );
          } else {
            ctx.assert.ok(
              !hit(usedText),
              "名言实际用了艺术字体：" + usedText
            );
          }
        }
      },
    },
    {
      name: "金句库里的每一条都套对了字体（逐条过一遍，不留漏网的）",
      async run(ctx) {
        await h.openApp(ctx.page);
        const res = await ctx.page.evaluate(() => {
          const j = window.__jintian;
          const list = window.JINTIAN_QUOTES || [];
          const real = Date.now;
          const bad = [];
          const counts = { gu: 0, ge: 0, ming: 0, other: 0 };
          const want = { gu: ["poem", "行楷"], ge: ["lyric", "楷体"], ming: ["saying", ""] };
          for (let i = 0; i < list.length; i++) {
            Date.now = () => i * j.quoteSlotMs + 1;
            j.renderQuote(true);
            const el = document.querySelector("#home-quote");
            const wrap = document.querySelector("#home-quote-wrap");
            const fam = getComputedStyle(el).fontFamily;
            const pair = want[list[i].k];
            if (!pair) {
              counts.other += 1;
              bad.push({ 第几条: i, 问题: "分类不认识：" + list[i].k });
              continue;
            }
            counts[list[i].k] += 1;
            if (wrap.getAttribute("data-kind") !== pair[0]) {
              bad.push({ 第几条: i, 问题: "分类没挂上：" + wrap.getAttribute("data-kind") });
            }
            if (pair[1] && fam.indexOf(pair[1]) < 0) {
              bad.push({ 第几条: i, 问题: "字体不对：" + fam });
            }
            if (!pair[1] && (fam.indexOf("行楷") >= 0 || fam.indexOf("KaiTi") >= 0)) {
              bad.push({ 第几条: i, 问题: "名言用了艺术字体：" + fam });
            }
          }
          Date.now = real;
          return { total: list.length, counts: counts, bad: bad.slice(0, 5) };
        });
        ctx.assert.ok(res.total >= 100, "金句库太小了：" + res.total);
        ctx.assert.ok(res.counts.gu > 0 && res.counts.ge > 0 && res.counts.ming > 0, "三种分类不齐：" + JSON.stringify(res.counts));
        ctx.assert.eq(res.counts.other, 0, "有认不出的分类");
        ctx.assert.eq(res.bad.length, 0, "有金句没套对字体：" + JSON.stringify(res.bad));
      },
    },
    {
      name: "字号变大了也不会撑破：最窄的窗口下三种金句都不出现横向滚动条",
      async run(ctx) {
        await ctx.page.setViewportSize({ width: 320, height: 820 });
        try {
          await h.openApp(ctx.page);
          for (const k of ["gu", "ge", "ming"]) {
            const idx = await indexOfKind(ctx.page, k);
            await showQuoteAt(ctx.page, idx);
            const box = await ctx.page.evaluate(() => ({
              scroll: document.documentElement.scrollWidth,
              client: document.documentElement.clientWidth,
            }));
            ctx.assert.ok(
              box.scroll <= box.client + 1,
              k + " 这一类的金句把页面撑出了横向滚动条：" + JSON.stringify(box)
            );
          }
        } finally {
          await ctx.page.setViewportSize({ width: 1180, height: 900 });
        }
      },
    },
  ],
};
