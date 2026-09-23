"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const h = require("./helper");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

// 建表语句里应该有的四张表
const TABLES = ["users", "sessions", "userdata", "ratelimit"];

async function loadWorker() {
  return import(pathToFileURL(path.join(h.ROOT, "server", "worker.js")).href);
}

// 一个「假装成 Cloudflare D1」的东西。
// 它不判断 SQL 对不对，只把后端问的问题记下来、按形状回答，
// 这样可以验证「走 D1 这条路」的代码至少能一路走完、不自己崩掉。
function fakeD1(options) {
  const opts = options || {};
  const tables = opts.tables || [];
  const fail = opts.fail || "";
  const seen = [];
  return {
    seen,
    prepare(sql) {
      seen.push(String(sql));
      if (fail) throw new Error(fail);
      const stmt = {
        bind() {
          return stmt;
        },
        async first() {
          return null;
        },
        async run() {
          return { meta: { last_row_id: 1 } };
        },
        async all() {
          if (/sqlite_master/i.test(sql)) {
            return { results: tables.map((name) => ({ name: name })) };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
  };
}

// 起一个「和线上一样」的小服务：请求原样交给 Worker 的真实入口（default.fetch），
// 只是把「环境变量」换成我们指定的，好模拟各种配置情况。
async function startWorkerServer(env) {
  const worker = await loadWorker();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (req.url === "/" || req.url.indexOf("/api/") === 0) {
      const request = new Request("http://127.0.0.1" + req.url, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" || !body.length ? undefined : body,
      });
      const response = await worker.default.fetch(request, env);
      const headers = {};
      response.headers.forEach((v, k) => {
        headers[k] = v;
      });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    // 剩下的当静态文件发（App 的页面、脚本、样式）
    const name = decodeURIComponent(req.url.split("?")[0]).replace(/^\//, "") || "index.html";
    // 和 phase13 一样：测试里把云端地址换成「当前网址」，
    // 免得测试跑去访问 config.js 里填的线上服务器。
    if (name === "config.js") {
      res.writeHead(200, { "Content-Type": MIME[".js"] });
      res.end("window.JINTIAN_CONFIG = {};");
      return;
    }
    const file = path.join(h.ROOT, name);
    if (!file.startsWith(h.ROOT)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: "http://127.0.0.1:" + server.address().port };
}

async function getHealth(base) {
  const res = await fetch(base + "/api/health");
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
}

async function register(base, username, password) {
  const res = await fetch(base + "/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: username, password: password }),
  });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
}

// 打开 App 并停在"账号"那个小窗上
async function openAccountDialog(page, base) {
  await page.goto(base + "/index.html", { waitUntil: "load" });
  await page.evaluate(() => localStorage.clear());
  await page.goto(base + "/index.html", { waitUntil: "load" });
  await page.waitForSelector("#app");
  await h.dismissBackupPrompt(page);
  await page.click("#account-chip");
  await page.waitForSelector("#dialog-account", { state: "visible" });
}

async function waitForAccountMessage(page, needle) {
  await page.waitForFunction(
    (text) => {
      const el = document.querySelector("#account-msg");
      return el && el.textContent.indexOf(text) >= 0;
    },
    needle,
    { timeout: 6000 }
  );
}

module.exports = {
  phase: 14,
  title: "第三版 · 后端自检与错误兜底",
  tests: [
    {
      name: "自检：一切正常时，打开那个网址就直接告诉你「可以注册了」",
      async run(ctx) {
        const srv = await startWorkerServer({ DB: fakeD1({ tables: TABLES }) });
        try {
          const health = await getHealth(srv.base);
          ctx.assert.eq(health.status, 200, "自检接口没通");
          ctx.assert.eq(health.body.ok, true, "自检说没通过");
          ctx.assert.includes(health.body.verdict, "一切正常", "结论没写「一切正常」");
          ctx.assert.includes(JSON.stringify(health.body.tables), "userdata", "没列出数据库里的表");

          // 用真浏览器打开，确认人看到的是一个能看懂的中文页面
          await ctx.page.goto(srv.base + "/", { waitUntil: "load" });
          const text = await ctx.page.evaluate(() => document.body.innerText);
          ctx.assert.includes(text, "一切正常", "浏览器打开没看到「一切正常」");
          ctx.assert.includes(text, "users", "自检页没列出表名");
          ctx.assert.notIncludes(text, "undefined", "自检页上出现了 undefined");
        } finally {
          srv.server.close();
        }
      },
    },
    {
      name: "自检：数据库绑定没配好时，直接说清「要加一条叫 DB 的绑定，加完重新部署」",
      async run(ctx) {
        const srv = await startWorkerServer({});
        try {
          const health = await getHealth(srv.base);
          ctx.assert.eq(health.status, 200, "自检接口自己崩了");
          ctx.assert.eq(health.body.ok, false, "明明没绑定却说一切正常");
          ctx.assert.includes(
            JSON.stringify(health.body.checks),
            "没找到叫 DB 的绑定",
            "没有指出缺 DB 绑定"
          );
          ctx.assert.includes(health.body.fix, "DB", "没有告诉人变量名要写 DB");
          ctx.assert.includes(health.body.fix, "部署", "没有提醒「加完要重新部署」");

          await ctx.page.goto(srv.base + "/", { waitUntil: "load" });
          const text = await ctx.page.evaluate(() => document.body.innerText);
          ctx.assert.includes(text, "❌", "自检页没标出没通过的那条");
          ctx.assert.includes(text, "DB", "自检页没提到 DB");
          ctx.assert.includes(text, "部署", "自检页没提重新部署");
        } finally {
          srv.server.close();
        }
      },
    },
    {
      name: "自检：表没建全时，会点名说缺哪几张表",
      async run(ctx) {
        const srv = await startWorkerServer({ DB: fakeD1({ tables: ["users"] }) });
        try {
          const health = await getHealth(srv.base);
          ctx.assert.eq(health.body.ok, false, "缺表却说一切正常");
          const text = JSON.stringify(health.body.checks);
          ctx.assert.includes(text, "sessions", "没点出缺的表名");
          ctx.assert.includes(text, "userdata", "没点出缺的表名");
        } finally {
          srv.server.close();
        }
      },
    },
    {
      name: "自检：数据库连不上时它自己不会崩，会把原始报错带出来",
      async run(ctx) {
        const srv = await startWorkerServer({ DB: fakeD1({ fail: "D1_ERROR: 连接被拒绝" }) });
        try {
          const health = await getHealth(srv.base);
          ctx.assert.eq(health.status, 200, "自检接口自己崩了");
          ctx.assert.eq(health.body.ok, false, "连不上数据库却说一切正常");
          ctx.assert.includes(
            JSON.stringify(health.body.checks),
            "D1_ERROR",
            "没有把原始报错带出来"
          );
        } finally {
          srv.server.close();
        }
      },
    },
    {
      name: "绑定没配好时，注册不再只说「连不上服务器」，而是回一句读得懂的中文",
      async run(ctx) {
        const srv = await startWorkerServer({});
        try {
          const res = await register(srv.base, "yinyin", "abc12345");
          ctx.assert.eq(res.status, 500, "应该回一个能读到的错误状态");
          ctx.assert.eq(
            res.headers.get("access-control-allow-origin"),
            "*",
            "少了跨域许可，浏览器就只能显示「连不上服务器」"
          );
          ctx.assert.includes(res.body.error, "服务器内部出错", "没有回可读的错误说明");
          ctx.assert.includes(res.body.hint, "绑定", "没有提示去检查绑定");
          ctx.assert.notIncludes(
            JSON.stringify(res.body),
            "Failed to fetch",
            "回的还是那句看不懂的英文"
          );
        } finally {
          srv.server.close();
        }
      },
    },
    {
      // Cloudflare 对密码加密有一条硬限制：PBKDF2 的迭代次数上限是 100000。
      // 第一次部署时我们写的是 120000，点注册就直接报
      //   Pbkdf2 failed: iteration counts above 100000 are not supported (requested 120000)
      // 这条测试把那个限制搬过来，跑一遍真实的注册流程，防止再写回去。
      name: "密码加密的参数没超过云端上限（把 Cloudflare 的限制搬过来跑一遍）",
      async run(ctx) {
        const worker = await loadWorker();
        const memory = await import(
          pathToFileURL(path.join(h.ROOT, "server", "store-memory.js")).href
        );

        const src = fs.readFileSync(path.join(h.ROOT, "server", "worker.js"), "utf8");
        const m = src.match(/const PBKDF2_ITERATIONS\s*=\s*([0-9_]+)/);
        ctx.assert.ok(m, "找不到 PBKDF2_ITERATIONS");
        const iterations = Number(String(m[1]).replace(/_/g, ""));
        // 上限 100000 是 Cloudflare 的硬规定；20000 是留出 CPU 余量之后的实际取值
        // （本机实测：100000 次约 18.5ms，而免费版每个请求只给 10ms CPU）。
        ctx.assert.ok(
          iterations <= 100000,
          "迭代次数 " + iterations + " 超过云端上限 100000，注册会直接报错"
        );
        ctx.assert.ok(
          iterations <= 20000,
          "迭代次数 " + iterations + " 太高，会撞上免费版 10 毫秒的 CPU 上限（改大前先重新量过耗时）"
        );
        ctx.assert.ok(iterations >= 1000, "迭代次数太低，密码保护不够：" + iterations);

        const real = globalThis.crypto;
        const swap = (value) =>
          Object.defineProperty(globalThis, "crypto", {
            value: value,
            configurable: true,
            writable: true,
          });
        const limited = {
          getRandomValues: (arr) => real.getRandomValues(arr),
          randomUUID: () => real.randomUUID(),
          subtle: {
            importKey: (...args) => real.subtle.importKey(...args),
            deriveBits: (alg, key, len) => {
              if (alg && alg.iterations > 100000) {
                return Promise.reject(
                  new Error(
                    "Pbkdf2 failed: iteration counts above 100000 are not supported (requested " +
                      alg.iterations +
                      ")."
                  )
                );
              }
              return real.subtle.deriveBits(alg, key, len);
            },
          },
        };

        try {
          swap(limited);
          const store = memory.makeMemoryStore();
          const res = await worker.handle(
            new Request("http://127.0.0.1/api/register", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ username: "going", password: "abc12345" }),
            }),
            store,
            {}
          );
          const body = await res.json();
          ctx.assert.eq(res.status, 200, "在云端的限制下注册还是失败：" + JSON.stringify(body));
          ctx.assert.ok(body.token, "没有发登录凭证");

          // 反证：这个「假平台」确实会拦下 120000，说明上面那条不是白过的
          const key = await real.subtle.importKey(
            "raw",
            new TextEncoder().encode("x"),
            "PBKDF2",
            false,
            ["deriveBits"]
          );
          let blocked = false;
          try {
            await limited.subtle.deriveBits(
              { name: "PBKDF2", salt: new Uint8Array(16), iterations: 120000, hash: "SHA-256" },
              key,
              256
            );
          } catch (err) {
            blocked = true;
          }
          ctx.assert.ok(blocked, "这个「假平台」没拦住 120000，测试本身不成立");
        } finally {
          swap(real);
        }
      },
    },
    {
      name: "绑定配好之后，注册这条路是通的（真入口 + 假 D1，看看 D1 那层有没有别的毛病）",
      async run(ctx) {
        const d1 = fakeD1({ tables: TABLES });
        const srv = await startWorkerServer({ DB: d1 });
        try {
          const res = await register(srv.base, "yinyin", "abc12345");
          ctx.assert.eq(res.status, 200, "绑定配好了注册还是不通：" + JSON.stringify(res.body));
          ctx.assert.eq(res.body.username, "yinyin", "回的账号名不对");
          ctx.assert.ok(res.body.token, "没有发登录凭证");
          const sql = d1.seen.join("\n");
          ctx.assert.includes(sql, "INSERT INTO users", "没有真的往 users 表里写");
          ctx.assert.includes(sql, "INSERT INTO sessions", "没有真的往 sessions 表里写");
        } finally {
          srv.server.close();
        }
      },
    },
    {
      // 之前所有失败都被报成"连不上服务器"，没法判断到底是网络的问题还是页面的问题。
      // 现在请求没通时，会把底层那句英文一起说出来。
      name: "请求根本没通时，提示里会带上真正的原因",
      async run(ctx) {
        const srv = await startWorkerServer({});
        try {
          await openAccountDialog(ctx.page, srv.base);
          await ctx.page.evaluate(() => {
            window.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
          });
          await ctx.page.fill("#account-name", "yinyin");
          await ctx.page.fill("#account-pass", "abc12345");
          await ctx.page.click('[data-act="account-register"]');
          await waitForAccountMessage(ctx.page, "Failed to fetch");
          const msg = await ctx.page.textContent("#account-msg");
          ctx.assert.includes(msg, "连不上服务器", "没有说清是连不上");
          ctx.assert.includes(msg, "Failed to fetch", "没有把底层原因带出来");
        } finally {
          srv.server.close();
        }
      },
    },
    {
      // 反过来：服务器明明回话了，只是页面自己处理时出错，绝不能报成"连不上服务器"。
      // 这个坑真的踩过——会把人带去查网络，白折腾半天。
      name: "服务器回话了、只是页面自己出错时，不会误报成「连不上服务器」",
      async run(ctx) {
        const srv = await startWorkerServer({});
        try {
          await openAccountDialog(ctx.page, srv.base);
          await ctx.page.click('[data-act="account-close"]');
          // 本机先有记录，"注册成功"之后才会走到"要不要传上去"那一步
          await h.addTask(ctx.page, "本机的一件事", 20);
          await ctx.page.click("#account-chip");
          await ctx.page.waitForSelector("#dialog-account", { state: "visible" });
          await ctx.page.evaluate(() => {
            window.fetch = async () =>
              new Response(JSON.stringify({ username: "tester", token: "tk", updatedAt: 0 }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            // 故意让页面在处理回话时出错（相当于页面自己有毛病）
            const real = document.getElementById.bind(document);
            document.getElementById = function (id) {
              if (id === "confirm-title") throw new Error("页面故意出错");
              return real(id);
            };
          });
          await ctx.page.fill("#account-name", "tester");
          await ctx.page.fill("#account-pass", "abc12345");
          await ctx.page.click('[data-act="account-register"]');
          await waitForAccountMessage(ctx.page, "服务器回话了");
          const msg = await ctx.page.textContent("#account-msg");
          ctx.assert.notIncludes(msg, "连不上服务器", "把页面自己的毛病误报成了连不上服务器");
          ctx.assert.includes(msg, "页面故意出错", "没有把真正的原因说出来");
        } finally {
          srv.server.close();
        }
      },
    },
    {
      // 出问题时要靠这个诊断页定位，所以它本身不能是坏的。
      name: "诊断页在本机服务器上跑一遍：每一项都应该通过",
      async run(ctx) {
        const srv = await startWorkerServer({ DB: fakeD1({ tables: TABLES }) });
        try {
          // 诊断页会拿百度当"对照实验"，本机测试不该真去访问外网，
          // 所以把那个对照网址换成这台测试服务器上的一个小文件。
          await ctx.page.goto(
            srv.base +
              "/账号连接诊断.html?control=" +
              encodeURIComponent(srv.base + "/favicon.svg"),
            { waitUntil: "load" }
          );
          await ctx.page.click("#run");
          await ctx.page.waitForFunction(
            () => {
              const t = document.querySelector("#report");
              return t && t.value.indexOf("总评") >= 0;
            },
            null,
            { timeout: 20000 }
          );
          const report = await ctx.page.inputValue("#report");
          ctx.assert.includes(report, "每一项都通过了", "诊断页报了问题：\n" + report);
          ctx.assert.includes(report, "[通过] 真的注册一个账号", "注册那一项没通过");
          ctx.assert.eq(await ctx.page.$$eval("li.bad", (els) => els.length), 0, "有没通过的项");
        } finally {
          srv.server.close();
        }
      },
    },
    {
      // 这一条是给「测试自己」把关的。
      // 项目里的 config.js 填着真实的 Cloudflare 网址，那是给本机版 App 用的。
      // 如果测试里原样加载它，App 就会跑去连线上服务器 —— 测试会变成看运气，
      // 还会在 config.js 被改过之后莫名其妙地挂掉。所以测试里必须换成「当前网址」。
      name: "测试是自成一体：App 在测试服务器上注册，落到的是这台服务器，不是线上",
      async run(ctx) {
        const d1 = fakeD1({ tables: TABLES });
        const srv = await startWorkerServer({ DB: d1 });
        try {
          await ctx.page.goto(srv.base + "/index.html", { waitUntil: "load" });
          await ctx.page.evaluate(() => localStorage.clear());
          await ctx.page.goto(srv.base + "/index.html", { waitUntil: "load" });
          await ctx.page.waitForSelector("#app");
          await h.dismissBackupPrompt(ctx.page);

          await ctx.page.click("#account-chip");
          await ctx.page.waitForSelector("#dialog-account", { state: "visible" });
          await ctx.page.fill("#account-name", "benchuser");
          await ctx.page.fill("#account-pass", "abc12345");
          await ctx.page.click('[data-act="account-register"]');

          let hit = false;
          for (let i = 0; i < 60 && !hit; i++) {
            hit = d1.seen.join("\n").indexOf("INSERT INTO users") >= 0;
            if (!hit) await ctx.sleep(100);
          }
          ctx.assert.ok(
            hit,
            "App 的注册请求没有打到这台测试服务器上 —— 多半是 config.js 把地址指到线上去了"
          );
          await ctx.page.waitForFunction(
            () => {
              const el = document.querySelector("#account-chip-title");
              return el && el.textContent.trim() === "benchuser";
            },
            null,
            { timeout: 8000 }
          );
        } finally {
          srv.server.close();
        }
      },
    },
  ],
};
