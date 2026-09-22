/* ============================================================
   内存版存储 —— 只在测试里用。
   它和 store-d1.js 实现同一组函数，所以可以拿它在本机把
   注册 / 登录 / 取数据 / 存数据整套流程真跑一遍。
   ============================================================ */

export function makeMemoryStore() {
  const users = new Map();      // username(lower) -> user
  const byId = new Map();       // id -> user
  const sessions = new Map();   // token -> { userId, expiresAt }
  const data = new Map();       // userId -> { json, updatedAt }
  const rates = new Map();      // key -> { window, count }
  let nextId = 1;

  return {
    async getUserByName(username) {
      return users.get(String(username || "").toLowerCase()) || null;
    },
    async getUserById(id) {
      return byId.get(Number(id)) || null;
    },
    async createUser({ username, salt, hash, iterations }) {
      const key = String(username).toLowerCase();
      if (users.has(key)) return null;
      const user = { id: nextId++, username, salt, hash, iterations };
      users.set(key, user);
      byId.set(user.id, user);
      return user.id;
    },
    async createSession(userId, expiresAt) {
      const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessions.set(token, { userId: Number(userId), expiresAt });
      return token;
    },
    async getSession(token) {
      const s = sessions.get(token);
      if (!s) return null;
      if (s.expiresAt && s.expiresAt < Date.now()) {
        sessions.delete(token);
        return null;
      }
      return s;
    },
    async deleteSession(token) {
      sessions.delete(token);
    },
    async getData(userId) {
      return data.get(Number(userId)) || null;
    },
    async putData(userId, json, updatedAt) {
      data.set(Number(userId), { json, updatedAt });
    },
    async bumpRate(key, windowSeconds) {
      const window = Math.floor(Date.now() / 1000 / windowSeconds);
      const hit = rates.get(key);
      if (!hit || hit.window !== window) {
        rates.set(key, { window, count: 1 });
        return 1;
      }
      hit.count += 1;
      return hit.count;
    },
  };
}
