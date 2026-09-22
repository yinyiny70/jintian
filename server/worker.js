/* ============================================================
   账号与云同步的后端（Cloudflare Worker）

   接口就四个：
     POST /api/register   { username, password }  -> { token }
     POST /api/login      { username, password }  -> { token, data, updatedAt }
     GET  /api/data       （带 token）             -> { data, updatedAt }
     PUT  /api/data       （带 token） { data, baseUpdatedAt } -> { updatedAt }

   存储层被抽成一组函数（store），这样：
     - 线上用 D1（Cloudflare 的数据库）
     - 测试时用内存版，可以在本机把整套流程真跑一遍
   ============================================================ */

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
const PBKDF2_ITERATIONS = 120000;
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

export async function handle(request, store) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
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
  fetch(request, env) {
    return handle(request, makeD1Store(env.DB));
  },
};
