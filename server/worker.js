/* ============================================================
   账号与云同步的后端（Cloudflare Worker）

   接口就四个：
      POST /api/register   { username, password }  -> { token }
      POST /api/login      { username, password }  -> { token, data, updatedAt }
      GET  /api/data       （带 token）             -> { data, updatedAt }
      PUT  /api/data       （带 token） { data, baseUpdatedAt } -> { updatedAt }

    另外还有一个不用登录的「自检」地址，专门用来看配置有没有弄对：
      GET  /            打开网址就是自检页
      GET  /api/health  同一份自检结果（JSON）

   存储层被抽成一组函数（store），这样：
      - 线上用 D1（Cloudflare 的数据库）
      - 测试时用内存版，可以在本机把整套流程真跑一遍
    ============================================================ */

// 每次改动这个文件，就把版本号往后挪一位。
// 自检页上会显示它，用来确认「我改的代码真的部署上去了」。
const BUILD = "2026-09-22.2";

/* ---------- D1 存储实现（故意写在同一个文件里）----------
   这样整个后端只有「一个文件」，可以直接粘进 Cloudflare 后台的在线编辑器，
   不需要在电脑上装任何东西。 */
function makeD1Store(db) {
  return {
    async getUserByName(username) {
      const row = await db
        .prepare("SELECT id, username, salt, hash, iterations FROM users WHERE lower(username) = lower(?)")
        .bind(String(username || ""))
        .first();
      return row || null;
    },
    async getUserById(id) {
      const row = await db
        .prepare("SELECT id, username FROM users WHERE id = ?")
        .bind(Number(id))
        .first();
      return row || null;
    },
    async createUser({ username, salt, hash, iterations }) {
      try {
        const res = await db
          .prepare("INSERT INTO users (username, salt, hash, iterations, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(username, salt, hash, iterations, Date.now())
          .run();
        return res.meta && res.meta.last_row_id ? res.meta.last_row_id : null;
      } catch (err) {
        return null; // 用户名撞了
      }
    },
    async createSession(userId, expiresAt) {
      const token =
        crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      await db
        .prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .bind(token, Number(userId), expiresAt, Date.now())
        .run();
      return token;
    },
    async getSession(token) {
      const row = await db
        .prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?")
        .bind(String(token))
        .first();
      if (!row) return null;
      if (row.expires_at && row.expires_at < Date.now()) return null;
      return { userId: row.user_id, expiresAt: row.expires_at };
    },
    async deleteSession(token) {
      await db.prepare("DELETE FROM sessions WHERE token = ?").bind(String(token)).run();
    },
    async getData(userId) {
      const row = await db
        .prepare("SELECT json, updated_at FROM userdata WHERE user_id = ?")
        .bind(Number(userId))
        .first();
      return row ? { json: row.json, updatedAt: row.updated_at } : null;
    },
    async putData(userId, json, updatedAt) {
      await db
        .prepare(
          "INSERT INTO userdata (user_id, json, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at"
        )
        .bind(Number(userId), json, updatedAt)
        .run();
    },
    async bumpRate(key, windowSeconds) {
      const window = Math.floor(Date.now() / 1000 / windowSeconds);
      const res = await db
        .prepare(
          "INSERT INTO ratelimit (key, window, count) VALUES (?, ?, 1) " +
            "ON CONFLICT(key) DO UPDATE SET count = CASE WHEN ratelimit.window = excluded.window " +
            "THEN ratelimit.count + 1 ELSE 1 END, window = excluded.window " +
            "RETURNING count"
        )
        .bind(String(key), window)
        .first();
      return res ? res.count : 1;
    },
  };
}

const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 登录状态保留 180 天
// 密码加密强度（迭代次数）。
// 这里有两条线都不能越：
//   1. Cloudflare 的平台限制：最多 100000，写多了直接报
//      "Pbkdf2 failed: iteration counts above 100000 are not supported"
//      （第一次部署写的是 120000，注册就卡在这儿。）
//   2. 免费版每个请求只给 10 毫秒 CPU。本机实测（同一套浏览器加密库）：
//      100000 次 ≈ 18.5ms、50000 次 ≈ 9.5ms、20000 次 ≈ 3.7ms、10000 次 ≈ 1.9ms。
//      取 100000 会把 CPU 撑爆，注册照样失败。
// 所以取 20000：够安全，也留足了余量。改大之前先把上面两个数重新量一遍。
const PBKDF2_ITERATIONS = 20000;
const MAX_BODY = 512 * 1024;                    // 单份数据上限 512KB
const AUTH_PER_MINUTE = 20;                     // 每分钟最多几次注册/登录

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS),
  });
}

function bad(message, status) {
  return json({ error: message }, status || 400);
}

function html(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "text/html; charset=utf-8" }, CORS),
  });
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return toHex(arr);
}

async function hashPassword(password, saltHex, iterations) {
  const enc = new TextEncoder();
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256
  );
  return toHex(bits);
}

function validUsername(name) {
  return typeof name === "string" && /^[A-Za-z0-9_-]{3,20}$/.test(name);
}

function validPassword(pw) {
  return typeof pw === "string" && pw.length >= 6 && pw.length <= 72;
}

function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

/* ---------- 自检 ----------
   用途：部署完之后打开网址，让它自己说清楚配置对不对。
   这里所有检查都包在 try 里，就算数据库没绑定也不会把整个服务弄崩。 */

const NEEDED_TABLES = ["users", "sessions", "userdata", "ratelimit"];

function esc(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function healthReport(env) {
  const e = env || {};
  const checks = [];
  const bindNames = Object.keys(e);

  checks.push({
    label: "Worker 本身跑起来了",
    ok: true,
    detail: "版本 " + BUILD,
  });

  const hasDB = !!e.DB;
  checks.push({
    label: "数据库绑定（变量名必须是 DB）",
    ok: hasDB,
    detail: hasDB
      ? "找到 DB 了"
      : "没找到叫 DB 的绑定。当前这个 Worker 看到的绑定是：" +
        (bindNames.length ? bindNames.join("、") : "（一个都没有）"),
  });

  let tables = [];
  if (hasDB) {
    try {
      const res = await e.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      const rows = (res && res.results) || [];
      tables = rows.map((r) => r.name).filter(Boolean);
      const missing = NEEDED_TABLES.filter((t) => tables.indexOf(t) === -1);
      checks.push({
        label: "数据库连得上、表建好了",
        ok: missing.length === 0,
        detail: missing.length
          ? "连接正常，但缺这几张表：" + missing.join("、")
          : "四张表都在：" + NEEDED_TABLES.join("、"),
      });
    } catch (err) {
      checks.push({
        label: "数据库连得上、表建好了",
        ok: false,
        detail: "连数据库时报错：" + (err && err.message ? err.message : String(err)),
      });
    }
  } else {
    checks.push({
      label: "数据库连得上、表建好了",
      ok: false,
      detail: "跳过（上面那条没通过，先修它）",
    });
  }

  const ok = checks.every((c) => c.ok);
  const report = {
    ok: ok,
    service: "jintian-account",
    build: BUILD,
    checks: checks,
    bindingNames: bindNames,
    tables: tables,
    verdict: ok ? "一切正常，可以回 App 里注册或登录了。" : "还差一步，看下面写着「没通过」的那条。",
    fix: ok ? "" : fixHint(checks),
  };
  return report;
}

function fixHint(checks) {
  const dbCheck = checks.filter((c) => c.label.indexOf("数据库绑定") === 0)[0];
  if (dbCheck && !dbCheck.ok) {
    return [
      "在 Cloudflare 里打开这个 Worker → 设置（Settings）→ 绑定（Bindings）→ 添加绑定：",
      "类型选「D1 数据库」，变量名（Variable name）写 DB（大写字母，一个字符都不能差），值选 jintian。",
      "加完之后一定要再点一次「部署 / Deploy」，绑定才会生效。",
    ].join(" ");
  }
  const tableCheck = checks.filter((c) => c.label.indexOf("数据库连得上") === 0)[0];
  if (tableCheck && !tableCheck.ok && tableCheck.detail.indexOf("缺这几张表") >= 0) {
    return "这张数据库里还缺表。回到数据库页面，把建表语句（server/schema.sql）整段粘进查询框执行一次。";
  }
  return "把这一页截图发给 Codex，我来判断。";
}

function healthPage(report) {
  const rows = report.checks
    .map(
      (c) =>
        '<li class="' +
        (c.ok ? "good" : "bad") +
        '"><b>' +
        (c.ok ? "✅ " : "❌ ") +
        esc(c.label) +
        "</b><br><span>" +
        esc(c.detail) +
        "</span></li>"
    )
    .join("");
  return (
    "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    "<title>今天 · 账号服务自检</title>" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<style>" +
    "body{margin:0;padding:40px 20px;background:#efe4cf;color:#3a2f26;" +
    "font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;line-height:1.7}" +
    "main{max-width:680px;margin:0 auto;background:#fffdf8;border-radius:20px;padding:32px;" +
    "box-shadow:0 24px 60px rgba(120,90,50,.18)}" +
    "h1{font-size:22px;margin:0 0 4px}" +
    ".sub{color:#8a7a67;font-size:13px;margin-bottom:20px}" +
    ".verdict{font-size:20px;font-weight:700;margin:18px 0}" +
    ".ok{color:#1f7a4d}.no{color:#b23a25}" +
    "ul{list-style:none;padding:0;margin:0}" +
    "li{padding:14px 16px;border-radius:14px;margin-bottom:10px;background:#f7f1e6}" +
    "li.good{border-left:6px solid #57b98a}" +
    "li.bad{border-left:6px solid #d1503a;background:#fdf1ec}" +
    "li span{color:#6d6154;font-size:14px}" +
    ".fix{margin-top:18px;padding:16px;border-radius:14px;background:#fff6e2;" +
    "border:1px dashed #d8b980;font-size:14px}" +
    "</style></head><body><main>" +
    "<h1>今天 · 账号服务自检</h1>" +
    "<div class=\"sub\">这一页就是后端自己说的话，把整页截图发给 Codex 就行。</div>" +
    "<div class=\"verdict " +
    (report.ok ? "ok" : "no") +
    "\">" +
    esc(report.verdict) +
    "</div>" +
    "<ul>" +
    rows +
    "</ul>" +
    (report.fix ? "<div class=\"fix\">怎么办：" + esc(report.fix) + "</div>" : "") +
    "</main></body></html>"
  );
}

export async function handle(request, store, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // 自检：不用登录，浏览器直接打开这个 Worker 的网址就能看
  if ((path === "/" || path === "/api/health") && request.method === "GET") {
    const report = await healthReport(env);
    if (path === "/" && String(request.headers.get("Accept") || "").indexOf("text/html") >= 0) {
      return html(healthPage(report));
    }
    return json(report, 200);
  }

  if (!path.startsWith("/api/")) {
    return bad("没有这个接口", 404);
  }

  // ---------- 注册 ----------
  if (path === "/api/register" && request.method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    if ((await store.bumpRate("reg:" + ip, 60)) > AUTH_PER_MINUTE) {
      return bad("操作太频繁，歇一会儿再试", 429);
    }
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return bad("请求格式不对");
    }
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!validUsername(username)) return bad("用户名只能用小写字母、数字、下划线或短横线，长度 3–20 位");
    if (!validPassword(password)) return bad("密码至少 6 位");
    if (await store.getUserByName(username)) return bad("这个用户名已经被用了", 409);

    const salt = randomHex(16);
    const hash = await hashPassword(password, salt, PBKDF2_ITERATIONS);
    const userId = await store.createUser({ username, salt, hash, iterations: PBKDF2_ITERATIONS });
    if (!userId) return bad("这个用户名已经被用了", 409);
    const token = await store.createSession(userId, Date.now() + TOKEN_TTL_MS);
    return json({ username, token, updatedAt: 0 });
  }

  // ---------- 登录 ----------
  if (path === "/api/login" && request.method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    if ((await store.bumpRate("login:" + ip, 60)) > AUTH_PER_MINUTE) {
      return bad("操作太频繁，歇一会儿再试", 429);
    }
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return bad("请求格式不对");
    }
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const user = await store.getUserByName(username);
    // 用户名不存在和密码不对，回同一句话（别帮人试探哪些用户名存在）
    if (!user) return bad("用户名或密码不对", 401);
    const hash = await hashPassword(password, user.salt, user.iterations);
    if (hash !== user.hash) return bad("用户名或密码不对", 401);

    const token = await store.createSession(user.id, Date.now() + TOKEN_TTL_MS);
    const saved = await store.getData(user.id);
    return json({
      username: user.username,
      token,
      data: saved ? JSON.parse(saved.json) : null,
      updatedAt: saved ? saved.updatedAt : 0,
    });
  }

  // ---------- 以下都要登录 ----------
  const token = bearer(request);
  const session = token ? await store.getSession(token) : null;
  if (!session) return bad("登录已经过期，请重新登录", 401);

  if (path === "/api/data" && request.method === "GET") {
    const user = await store.getUserById(session.userId);
    const saved = await store.getData(session.userId);
    return json({
      username: user ? user.username : "",
      data: saved ? JSON.parse(saved.json) : null,
      updatedAt: saved ? saved.updatedAt : 0,
    });
  }

  if (path === "/api/data" && request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return bad("请求格式不对");
    }
    if (!body || typeof body.data !== "object" || body.data === null) return bad("没有数据");
    const text = JSON.stringify(body.data);
    if (text.length > MAX_BODY) return bad("数据太大了，存不下", 413);

    const saved = await store.getData(session.userId);
    const serverAt = saved ? saved.updatedAt : 0;
    const baseAt = Number(body.baseUpdatedAt) || 0;
    // 服务器上那份比你以为的新 —— 说明另一处改过，先别覆盖，让前端拉下来
    if (serverAt > baseAt) {
      return json({ conflict: true, data: JSON.parse(saved.json), updatedAt: serverAt }, 409);
    }
    const now = Date.now();
    await store.putData(session.userId, text, now);
    return json({ updatedAt: now });
  }

  return bad("没有这个接口", 404);
}

export default {
  async fetch(request, env) {
    // 外面套一层兜底：万一服务器内部出错，也要回一句能看懂的中文，
    // 而不是让浏览器只看到「连不上服务器」。
    try {
      return await handle(request, env ? makeD1Store(env.DB) : null, env);
    } catch (err) {
      return json(serverErrorBody(err), 500);
    }
  },
};

function serverErrorBody(err) {
  const msg = err && err.message ? err.message : String(err);
  return {
    error: "服务器内部出错：" + msg,
    hint:
      "多半是数据库绑定没弄好、或者绑定没跟着重新部署。打开这个 Worker 的网址，" +
      "首页会显示自检结果，照着上面写的做。",
    build: BUILD,
  };
}
