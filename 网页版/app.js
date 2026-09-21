"use strict";

(function () {
  var STORE_KEY = "jintian.v1";
  var DATA_VERSION = 1;
  var WEEK = "日一二三四五六";

  // 这一行决定了"这是谁在用"：
  //   本机版（双击 index.html 打开，或者放在本机地址上）→ 完整体验，
  //     第一次会引导你把数据备份到一个文件里。
  //   网页版（放在别人的服务器上、用域名访问）→ 陌生访客友好：
  //     不再一上来就弹窗要你选文件，改成首页一行说明。
  //   功能本身两边完全一样。
  var IS_WEB =
    /^https?:$/.test(location.protocol) &&
    !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);

  /* ============================================================
   * 工具
   * ========================================================== */

  function pad2(n) { return String(n).padStart(2, "0"); }

  function ymd(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  function todayKey() { return ymd(new Date()); }

  function parseKey(key) {
    var p = String(key).split("-");
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function dateLabel(key) {
    var d = parseKey(key);
    return d.getMonth() + 1 + "月" + d.getDate() + "日 星期" + WEEK[d.getDay()];
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtMinutes(totalMin) {
    var m = Math.max(0, Math.round(totalMin));
    if (m < 60) return m + " 分钟";
    var h = Math.floor(m / 60);
    var r = m % 60;
    return r === 0 ? h + " 小时" : h + " 小时 " + r + " 分";
  }

  function fmtSecondsAsMinutes(sec) { return fmtMinutes(Math.round(sec / 60)); }

  function fmtClock(sec) {
    var s = Math.max(0, Math.ceil(sec));
    return pad2(Math.floor(s / 60)) + ":" + pad2(s % 60);
  }

  function uid() {
    return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function $(id) { return document.getElementById(id); }

  function setText(id, text) {
    var el = $(id);
    if (el) el.textContent = text;
  }

  /* ============================================================
   * 数据
   * ========================================================== */

  function blankState() {
    return {
      version: DATA_VERSION,
      tasks: {},
      summaries: {},
      notes: {},
      timer: null,
      settings: {
        backupFile: "",
        backupAt: null,
        backupAsked: false,
        lastSummaryAt: null
      }
    };
  }

  var state = blankState();
  var storageBroken = false;

  function load() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORE_KEY);
    } catch (err) {
      storageBroken = true;
      return;
    }
    if (!raw) return;
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn("本地数据读不出来，已用空白数据启动。原始内容保留在 " + STORE_KEY + "。");
      return;
    }
    var before = JSON.stringify(parsed);
    state = migrate(parsed);
    // 老版本或字段不全的数据，读完立刻按当前格式写回去，免得每次打开都要再迁一次
    if (JSON.stringify(state) !== before) saveNow();
  }

  function migrate(data) {
    var next = blankState();
    if (!data || typeof data !== "object") return next;
    next.version = DATA_VERSION;
    if (data.tasks && typeof data.tasks === "object") next.tasks = data.tasks;
    if (data.summaries && typeof data.summaries === "object") next.summaries = data.summaries;
    if (data.notes && typeof data.notes === "object") next.notes = data.notes;
    if (data.timer && typeof data.timer === "object") next.timer = data.timer;
    if (data.settings && typeof data.settings === "object") {
      next.settings.backupFile = data.settings.backupFile || "";
      next.settings.backupAt = data.settings.backupAt || null;
      next.settings.backupAsked = !!data.settings.backupAsked;
      next.settings.lastSummaryAt = data.settings.lastSummaryAt || null;
    }
    Object.keys(next.tasks).forEach(function (date) {
      if (!Array.isArray(next.tasks[date])) next.tasks[date] = [];
      next.tasks[date] = next.tasks[date].filter(function (t) { return t && typeof t.name === "string"; });
    });
    // 顺手把以前留下的空白日期清掉
    pruneEmptyDays(next);
    return next;
  }

  var saveHandle = null;

  function saveNow(options) {
    clearTimeout(saveHandle);
    saveHandle = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (err) {
      storageBroken = true;
    }
    if (!options || !options.skipBackup) scheduleBackup();
  }

  function saveSoon() {
    clearTimeout(saveHandle);
    saveHandle = setTimeout(saveNow, 300);
  }

  /* ============================================================
   * 当天数据的小工具
   * ========================================================== */

  function tasksOf(date) {
    if (!state.tasks[date]) state.tasks[date] = [];
    return state.tasks[date];
  }

  function notesOf(date) {
    if (!state.notes[date]) state.notes[date] = [];
    return state.notes[date];
  }

  // 只读版本：没有记录的日期就是空的，绝不因为「看了一眼」就凭空建出一条记录。
  // 下面所有「显示」的地方都必须用这两个，只有真正写入时才用上面那两个。
  function readTasks(date) { return state.tasks[date] || []; }
  function readNotes(date) { return state.notes[date] || []; }

  function summaryOf(date) { return state.summaries[date] || ""; }

  function spentSecondsOf(date) {
    return readTasks(date).reduce(function (sum, t) { return sum + (Number(t.spentSec) || 0); }, 0);
  }

  function dayHasContent(date) {
    return (
      readTasks(date).length > 0 ||
      readNotes(date).length > 0 ||
      summaryOf(date).trim().length > 0
    );
  }

  function taskById(date, id) {
    var list = readTasks(date);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  // 把「空白的日期」清掉：这种记录没有任何信息，留着只会让数据文件变脏。
  function pruneEmptyDays(target) {
    var data = target || state;
    Object.keys(data.tasks).forEach(function (d) {
      if (!Array.isArray(data.tasks[d]) || data.tasks[d].length === 0) delete data.tasks[d];
    });
    Object.keys(data.notes).forEach(function (d) {
      if (!Array.isArray(data.notes[d]) || data.notes[d].length === 0) delete data.notes[d];
    });
    Object.keys(data.summaries).forEach(function (d) {
      if (!String(data.summaries[d] || "").trim()) delete data.summaries[d];
    });
  }

  /* ============================================================
   * 页面切换
   * ========================================================== */

  function goTo(page) {
    var app = $("app");
    if (!app) return;
    app.dataset.page = page;
    Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (btn) {
      btn.classList.toggle("is-active", btn.dataset.goto === page);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".page"), function (section) {
      section.hidden = section.dataset.page !== page;
    });
  }

  function renderDateLabels() {
    var key = todayKey();
    setText("today-label", dateLabel(key));
    setText("notes-sub", dateLabel(key) + " · 今天留下的文字");
  }

  /* ============================================================
   * 今日计划
   * ========================================================== */

  var editingId = null;
  var dragId = null;

  function addTask(name, estMinutes) {
    var name2 = String(name || "").trim();
    if (!name2) return null;
    var est = Math.max(1, Math.min(600, Math.round(Number(estMinutes) || 30)));
    var task = { id: uid(), name: name2, est: est, spentSec: 0, done: false, feeling: "" };
    tasksOf(todayKey()).push(task);
    saveSoon();
    renderPlan();
    return task;
  }

  function renderPlan() {
      var key = todayKey();
      var list = readTasks(key);
    var done = list.filter(function (t) { return t.done; }).length;
    setText("plan-sub", dateLabel(key) + " · 完成 " + done + " / " + list.length);

    var host = $("tasks");
    if (!list.length) {
      host.innerHTML = '<li class="empty">今天还没有安排。在上面加一件想做的事。</li>';
      return;
    }
    host.innerHTML = list
      .map(function (t) {
        var isRunning = !!state.timer && state.timer.taskId === t.id;
        var minutes = Math.round((Number(t.spentSec) || 0) / 60);
        var meta = ["预估 " + fmtMinutes(t.est)];
        if (minutes > 0) meta.push("实际 " + fmtMinutes(minutes) + (minutes > t.est ? "（超了）" : ""));
        if (isRunning) meta.push(state.timer.paused ? "已暂停" : "计时中");

        var nameHtml =
          editingId === t.id
            ? '<input type="text" class="input name-input" data-name-input="' + t.id + '" value="' + esc(t.name) + '" aria-label="任务名称">'
            : '<div class="task-name">' + esc(t.name) + "</div>";

        var actions =
          '<button type="button" class="icon-btn" data-act="edit" aria-label="编辑任务"><svg class="ic"><use href="#i-edit"/></svg></button>' +
          '<button type="button" class="icon-btn" data-act="del" aria-label="删除任务"><svg class="ic"><use href="#i-trash"/></svg></button>';
        if (!t.done) {
          actions += isRunning
            ? '<button type="button" class="btn tiny" data-act="pause">' + (state.timer.paused ? "继续" : "暂停") + "</button>"
            : '<button type="button" class="btn tiny primary" data-act="start">开始</button>';
        }

        return (
          '<li class="task' + (t.done ? " is-done" : "") + (isRunning ? " is-running" : "") + '" data-id="' + t.id + '" draggable="true">' +
          '<button type="button" class="grip" data-act="grip" aria-label="拖动排序"><svg class="ic"><use href="#i-grip"/></svg></button>' +
          '<input type="checkbox" class="task-check"' + (t.done ? " checked" : "") + ' aria-label="完成 ' + esc(t.name) + '">' +
          '<div class="task-body">' + nameHtml +
          '<div class="task-meta" id="task-meta-' + t.id + '">' + esc(meta.join(" · ")) + "</div></div>" +
          '<div class="task-actions">' + actions + "</div></li>"
        );
      })
      .join("");
  }

  /* ============================================================
   * 计时与响铃
   * ========================================================== */

  var BELL_MS = 10000;   // 响铃持续时长
  var TICK_MS = 250;
  var bellTimer = null;
  var tickTimer = null;
  var audioCtx = null;

  // bell：正在响；waiting：响铃框还开着、在等用户处理
  var ringState = { bell: false, waiting: false, taskId: null };

  function timerRemainingSec() {
    var t = state.timer;
    if (!t) return 0;
    if (t.paused) return Math.max(0, Number(t.remainingSec) || 0);
    return Math.max(0, (Number(t.endsAt) - Date.now()) / 1000);
  }

  function isRinging() { return ringState.bell; }

  /* ---------- 提示音 ---------- */

  function ensureAudio() {
    if (audioCtx) return audioCtx;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    } catch (err) {
      audioCtx = null;
    }
    return audioCtx;
  }

  function chime(ctx) {
    var now = ctx.currentTime;
    [880, 1320].forEach(function (freq, i) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      var t0 = now + i * 0.16;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.5);
    });
  }

  function startBell() {
    stopBell();
    ringState.bell = true;
    var ctx = ensureAudio();
    var until = Date.now() + BELL_MS;
    function once() {
      if (!ringState.bell) return;
      if (ctx) {
        try {
          if (ctx.state === "suspended") ctx.resume();
          chime(ctx);
        } catch (err) { /* 没声音也不影响提醒 */ }
      }
      if (Date.now() >= until) { stopBell(); return; }
      bellTimer = setTimeout(once, 1300);
    }
    once();
  }

  function stopBell() {
    ringState.bell = false;
    if (bellTimer) clearTimeout(bellTimer);
    bellTimer = null;
  }

  /* ---------- 计时过程 ---------- */

  function startTimer(taskId, minutes) {
    var sec = Math.max(60, Math.round(Number(minutes) * 60));
    state.timer = {
      date: todayKey(),
      taskId: taskId,
      totalSec: sec,
      endsAt: Date.now() + sec * 1000,
      remainingSec: sec,
      paused: false
    };
    saveNow();
    renderAll();
    ensureTick();
  }

  function pauseTimer() {
    var t = state.timer;
    if (!t || t.paused) return;
    t.remainingSec = timerRemainingSec();
    t.paused = true;
    saveNow();
    renderAll();
  }

  function resumeTimer() {
    var t = state.timer;
    if (!t || !t.paused) return;
    t.endsAt = Date.now() + (Number(t.remainingSec) || 0) * 1000;
    t.paused = false;
    saveNow();
    renderAll();
  }

  function recordUsed(seconds) {
    var t = state.timer;
    if (!t) return null;
    var task = taskById(t.date, t.taskId);
    var used = Math.max(0, Math.round(seconds));
    if (task && used > 0) task.spentSec = (Number(task.spentSec) || 0) + used;
    return task;
  }

  function clearTimer() {
    stopBell();
    state.timer = null;
    ringState.waiting = false;
    ringState.taskId = null;
    saveNow();
  }

  function ring() {
    var t = state.timer;
    if (!t) return;
    t.remainingSec = 0;
    ringState.waiting = true;
    ringState.taskId = t.taskId;
    startBell();
    openRingDialog();
    saveNow();
    renderAll();
  }

  function tick() {
    var t = state.timer;
    if (!t) return;
    if (ringState.waiting) return;   // 响铃框还开着，等用户处理
    if (t.date !== todayKey()) {
      recordUsed(t.totalSec - timerRemainingSec());
      clearTimer();
      renderAll();
      return;
    }
    var rem = timerRemainingSec();
    if (!t.paused && rem <= 0) {
      ring();
      return;
    }
    paintTimer(rem);
  }

  function ensureTick() {
    if (tickTimer) return;
    tickTimer = setInterval(tick, TICK_MS);
  }

  /* ---------- 界面刷新 ---------- */

  function paintTimer(rem) {
    var t = state.timer;
    if (!t) return;
    var total = Number(t.totalSec) || 1;
    setText("home-time", fmtClock(rem));
    setText("timerbar-time", fmtClock(rem));
    var bar = $("home-bar");
    if (bar) bar.style.width = (100 * (1 - rem / total)).toFixed(1) + "%";
    var meta = $("task-meta-" + t.taskId);
    if (meta) {
      var task = taskById(t.date, t.taskId);
      var minutes = Math.round((Number(task && task.spentSec) || 0) / 60);
      var parts = ["预估 " + fmtMinutes(task ? task.est : 0)];
      if (minutes > 0) parts.push("实际 " + fmtMinutes(minutes));
      parts.push(t.paused ? "已暂停 " + fmtClock(rem) : "计时中 " + fmtClock(rem));
      meta.textContent = parts.join(" · ");
    }
  }

  function renderHome() {
    var t = state.timer;
    $("home-idle").hidden = !!t;
    $("home-running").hidden = !t;
    var notice = $("web-notice");
    if (notice) notice.hidden = !IS_WEB;
    if (t) {
      var task = taskById(t.date, t.taskId);
      setText("home-task", task ? task.name : "（任务已删除）");
      paintTimer(timerRemainingSec());
    }
    setText("home-total", fmtSecondsAsMinutes(spentSecondsOf(todayKey())));
  }

  function renderTimerBar() {
    var bar = $("timerbar");
    if (!bar) return;
    bar.hidden = !state.timer;
    if (!state.timer) return;
    var task = taskById(state.timer.date, state.timer.taskId);
    setText("timerbar-task", task ? task.name : "（任务已删除）");
    setText("bar-pause", state.timer.paused ? "继续" : "暂停");
    bar.classList.toggle("is-paused", !!state.timer.paused);
    paintTimer(timerRemainingSec());
  }

  /* ============================================================
   * 备份与恢复
   * ========================================================== */

  var BACKUP_DB = "jintian";
  var BACKUP_STORE = "handles";
  var BACKUP_KEY = "backup";
  var BACKUP_DELAY = 800;

  var backupHandle = null;
  var backupTimer = null;
  var backupFailed = false;

  function openBackupDb() {
    return new Promise(function (resolve, reject) {
      var req;
      try {
        req = indexedDB.open(BACKUP_DB, 1);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(BACKUP_STORE)) {
          req.result.createObjectStore(BACKUP_STORE);
        }
      };
      req.onerror = function () { reject(req.error); };
      req.onsuccess = function () { resolve(req.result); };
    });
  }

  function idbPut(store, key, value) {
    return openBackupDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function idbGet(store, key) {
    return openBackupDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, "readonly");
        var req = tx.objectStore(store).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbDelete(store, key) {
    return openBackupDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function backupPayload() {
    return {
      app: "今天",
      version: DATA_VERSION,
      savedAt: new Date().toISOString(),
      data: state
    };
  }

  function ensurePermission(handle) {
    if (!handle || typeof handle.queryPermission !== "function") return Promise.resolve(true);
    var opts = { mode: "readwrite" };
    return handle.queryPermission(opts).then(function (status) {
      if (status === "granted") return true;
      return handle.requestPermission(opts).then(function (next) {
        return next === "granted";
      }).catch(function () { return false; });
    }).catch(function () { return false; });
  }

  function writeBackup() {
    clearTimeout(backupTimer);
    backupTimer = null;
    if (!backupHandle) return Promise.resolve({ ok: false, reason: "nohandle" });
    return ensurePermission(backupHandle).then(function (granted) {
      if (!granted) {
        backupFailed = true;
        renderBackupChip();
        return { ok: false, reason: "permission" };
      }
      return backupHandle
        .createWritable()
        .then(function (writable) {
          return writable.write(JSON.stringify(backupPayload(), null, 2)).then(function () {
            return writable.close();
          });
        })
        .then(function () {
          backupFailed = false;
          state.settings.backupAt = new Date().toISOString();
          saveNow({ skipBackup: true });
          renderBackupChip();
          return { ok: true };
        })
        .catch(function (err) {
          backupFailed = true;
          renderBackupChip();
          return { ok: false, reason: String(err && err.message ? err.message : err) };
        });
    });
  }

  function scheduleBackup() {
    if (!backupHandle) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(function () { writeBackup(); }, BACKUP_DELAY);
  }

  function renderBackupChip() {
    var chip = $("backup-chip");
    if (!chip) return;
      var nameEl = $("backup-title");
      var subEl = $("backup-sub");
      if (!backupHandle) {
        if (IS_WEB) {
          nameEl.textContent = "数据存在这个浏览器里";
          subEl.textContent = "点这里可存成文件";
        } else {
          nameEl.textContent = "还没有设置备份";
          subEl.textContent = "点这里设置";
        }
        return;
      }
    if (backupFailed) {
      nameEl.textContent = "上次备份没成功";
      subEl.textContent = "点这里看看";
      return;
    }
    nameEl.textContent = "已自动保存到文件";
    subEl.textContent = (backupHandle.name || "备份文件") + " · " + clockOf(state.settings.backupAt);
  }

  function renderBackupDialog() {
    var status;
    if (!backupHandle) {
      status = "还没有设置备份文件。设置一次之后，改动都会自动写进去。";
      $("backup-choose").textContent = "选择备份文件的位置";
    } else {
      status =
        "备份文件：" + (backupHandle.name || "（已选）") +
        "\n最后一次写入：" + (state.settings.backupAt ? new Date(state.settings.backupAt).toLocaleString() : "还没写过");
      $("backup-choose").textContent = "换一个备份文件";
    }
    if (backupFailed) status += "\n上一次写入没有成功，可能需要在弹出的提示里再允许一次。";
    $("backup-status").textContent = status;
    $("backup-note").textContent = "浏览器出于安全考虑，偶尔会要你再确认一次「允许写这个文件」，这是正常的。";
  }

  function pickSaveFile() {
    if (typeof window.showSaveFilePicker !== "function") {
      return Promise.reject(new Error("这个浏览器不支持直接写文件"));
    }
    return window.showSaveFilePicker({
      suggestedName: "今天备份.json",
      types: [{ description: "备份文件", accept: { "application/json": [".json"] } }]
    });
  }

  function pickOpenFile() {
    if (typeof window.showOpenFilePicker !== "function") {
      return Promise.reject(new Error("这个浏览器不支持选择文件"));
    }
    return window.showOpenFilePicker({
      types: [{ description: "备份文件", accept: { "application/json": [".json"] } }]
    });
  }

  function setBackupHandle(handle) {
    backupHandle = handle;
    state.settings.backupFile = handle && handle.name ? handle.name : "";
    backupFailed = false;
    return idbPut(BACKUP_STORE, BACKUP_KEY, handle).catch(function () { return false; });
  }

  function parseBackup(text) {
    var parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.data && typeof parsed.data === "object") {
      return parsed.data;
    }
    if (parsed && typeof parsed === "object" && (parsed.tasks || parsed.summaries || parsed.notes)) {
      return parsed;
    }
    throw new Error("这个文件里没有能认出来的数据");
  }

  function applyRestore(data) {
    state = migrate(data);
    saveNow({ skipBackup: true });
    renderAll();
    if (backupHandle) writeBackup();
  }

  /* ============================================================
   * 备忘录
   * ========================================================== */

  function clockOf(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function renderSummarySaved() {
    var at = state.settings.lastSummaryAt;
    if (!at) { setText("summary-saved", ""); return; }
    var sameDay = ymd(new Date(at)) === todayKey();
    setText("summary-saved", sameDay ? "已自动保存 · " + clockOf(at) : "已自动保存");
  }

  function renderQuickList() {
    var list = readNotes(todayKey());
    var host = $("quick-list");
    if (!list.length) {
      host.innerHTML = '<li class="empty">今天还没有随手记。</li>';
      return;
    }
    host.innerHTML = list
      .map(function (n) {
        return (
          '<li class="quick-item" data-note-id="' + n.id + '">' +
          '<span class="quick-time">' + esc(n.time) + "</span>" +
          '<span class="quick-text">' + esc(n.text) + "</span>" +
          '<button type="button" class="icon-btn" data-act="quick-del" aria-label="删除这条随手记">' +
          '<svg class="ic"><use href="#i-x"/></svg></button></li>'
        );
      })
      .join("");
  }

  function renderFeels() {
    var list = readTasks(todayKey()).filter(function (t) {
      return (Number(t.spentSec) || 0) > 0;
    });
    var host = $("feel-list");
    if (!list.length) {
      host.innerHTML = '<li class="empty">今天还没有计过时的事。</li>';
      return;
    }
    host.innerHTML = list
      .map(function (t) {
        return (
          '<li class="feel-item">' +
          '<div class="feel-head"><span class="feel-name">' + esc(t.name) + "</span>" +
          '<span class="feel-meta">' + fmtSecondsAsMinutes(t.spentSec) + "</span></div>" +
          '<textarea class="textarea" rows="2" data-feel="' + t.id + '" ' +
          'placeholder="这件事做起来感觉怎么样？">' + esc(t.feeling) + "</textarea></li>"
        );
      })
      .join("");
  }

  function renderNotes() {
    var date = todayKey();
    var box = $("summary");
    if (document.activeElement !== box) box.value = summaryOf(date);
    renderSummarySaved();
    renderQuickList();
    renderFeels();
  }

  function addQuickNote(text) {
    var value = String(text || "").trim();
    if (!value) return null;
    var now = new Date();
    var note = { id: uid(), time: pad2(now.getHours()) + ":" + pad2(now.getMinutes()), text: value };
    notesOf(todayKey()).push(note);
    saveSoon();
    renderQuickList();
    return note;
  }

  /* ============================================================
   * 回看
   * ========================================================== */

  var selectedDate = null;

  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  function renderCalendar() {
    var today = todayKey();
    var t = parseKey(today);
    var year = t.getFullYear();
    var month = t.getMonth();
    setText("cal-month", year + " 年 " + (month + 1) + " 月");

    // 周一作为第一列
    var firstWeekday = new Date(year, month, 1).getDay();
    var pad = (firstWeekday + 6) % 7;
    var html = "";
    for (var i = 0; i < pad; i++) html += '<span class="cal-pad"></span>';
    var total = daysInMonth(year, month);
    for (var d = 1; d <= total; d++) {
      var iso = year + "-" + pad2(month + 1) + "-" + pad2(d);
      var cls = "cal-day";
      if (dayHasContent(iso)) cls += " has-data";
      if (iso === today) cls += " is-today";
      if (iso === selectedDate) cls += " is-selected";
      html +=
        '<button type="button" class="' + cls + '" data-date="' + iso + '" aria-label="' +
        (month + 1) + "月" + d + "日" + '">' + d + "</button>";
    }
    $("cal-grid").innerHTML = html;
  }

  function dayTaskRows(list) {
    if (!list.length) return '<li class="dayview-empty">这一天没有记下任何事。</li>';
    return list
      .map(function (t) {
        var spent = Number(t.spentSec) || 0;
        return (
          "<li><div class=\"dayview-row\">" +
          '<span class="dayview-tick" aria-hidden="true">' + (t.done ? "✓" : "·") + "</span>" +
          '<span class="dayview-name' + (t.done ? "" : " is-undone") + '">' + esc(t.name) + "</span>" +
          '<span class="dayview-time">' + (spent > 0 ? fmtSecondsAsMinutes(spent) : "没有计时") + "</span>" +
          "</div>" +
          (t.feeling ? '<div class="dayview-feel">' + esc(t.feeling) + "</div>" : "") +
          "</li>"
        );
      })
      .join("");
  }

  function dayNoteRows(list) {
    if (!list.length) return '<p class="dayview-empty">这一天没有随手记。</p>';
    return (
      '<ul class="dayview-list">' +
      list
        .map(function (n) {
          return (
            '<li><div class="dayview-row"><span class="dayview-time">' + esc(n.time) + "</span>" +
            '<span class="dayview-name">' + esc(n.text) + "</span></div></li>"
          );
        })
        .join("") +
      "</ul>"
    );
  }

  function renderDayView() {
    var date = selectedDate || todayKey();
    var host = $("dayview");
    var isToday = date === todayKey();
    var tasks = readTasks(date);
    var notes = readNotes(date);
    var summary = summaryOf(date);

    if (!isToday && !dayHasContent(date)) {
      host.innerHTML =
        '<div class="dayview-head"><span class="dayview-date">' + esc(dateLabel(date)) + "</span></div>" +
        '<p class="dayview-empty">这一天没有留下记录。</p>';
      return;
    }

    var done = tasks.filter(function (t) { return t.done; }).length;
    var head =
      '<div class="dayview-head"><span class="dayview-date">' + esc(dateLabel(date)) + "</span>" +
      '<span class="dayview-stat">专注 ' + fmtSecondsAsMinutes(spentSecondsOf(date)) +
      " · 完成 " + done + " 件</span></div>";

    var hint = isToday
      ? '<p class="dayview-hint">今天的任务在「今日计划」里改，文字在「备忘录」里写。</p>'
      : "";

    host.innerHTML =
      head +
      hint +
      '<div><h3 class="dayview-h3">做的事</h3><ul class="dayview-list">' + dayTaskRows(tasks) + "</ul></div>" +
      '<div><h3 class="dayview-h3">当天的总结</h3>' +
      (summary.trim()
        ? '<p class="dayview-text">' + esc(summary) + "</p>"
        : '<p class="dayview-empty">这一天没有总结。</p>') +
      "</div>" +
      '<div><h3 class="dayview-h3">随手记</h3>' + dayNoteRows(notes) + "</div>";
  }

  function renderReview() {
    if (!selectedDate) selectedDate = todayKey();
    renderCalendar();
    renderDayView();
  }

  function renderAll() {
    renderDateLabels();
    renderPlan();
    renderHome();
    renderTimerBar();
    renderNotes();
    renderReview();
    renderBackupChip();
  }

  /* ============================================================
   * 弹框
   * ========================================================== */

  var confirmAction = null;

  function closeDialogs() {
    $("overlay").hidden = true;
    ["dialog-start", "dialog-ring", "dialog-backup", "dialog-confirm"].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = true;
    });
    confirmAction = null;
  }

  function openDialog(id) {
    $("overlay").hidden = false;
    ["dialog-start", "dialog-ring", "dialog-backup", "dialog-confirm"].forEach(function (other) {
      var el = $(other);
      if (el) el.hidden = other !== id;
    });
  }

  function openStartDialog(taskId) {
    var task = taskById(todayKey(), taskId);
    if (!task) return;
    pendingStartTaskId = taskId;
    setText("start-task", task.name);
    $("start-min").value = task.est;
    openDialog("dialog-start");
    $("start-min").focus();
    $("start-min").select();
  }

  function openRingDialog() {
    var t = state.timer;
    var task = t ? taskById(t.date, t.taskId) : null;
    setText("ring-name", task ? task.name : "（任务已删除）");
    setText("ring-sub", "这次计时 " + fmtSecondsAsMinutes(t ? t.totalSec : 0));
    $("ring-step1").hidden = false;
    $("ring-step2").hidden = true;
    openDialog("dialog-ring");
  }

  function openConfirm(title, body, okLabel, action) {
    setText("confirm-title", title);
    setText("confirm-body", body);
    setText("confirm-ok", okLabel || "确定");
    confirmAction = action;
    openDialog("dialog-confirm");
  }

  var pendingStartTaskId = null;

  /* ============================================================
   * 事件
   * ========================================================== */

  function bindEvents() {
    document.addEventListener("click", function (event) {
      // 用户第一次点页面时，把提示音的通道打开（浏览器要求先有交互才允许出声）
      var ctx = ensureAudio();
      if (ctx && ctx.state === "suspended") {
        try { ctx.resume(); } catch (err) { /* 忽略 */ }
      }
      var goto = event.target.closest("[data-goto]");
      if (goto) {
        goTo(goto.dataset.goto);
        return;
      }
      var dayCell = event.target.closest(".cal-day");
      if (dayCell) {
        selectedDate = dayCell.dataset.date;
        renderReview();
        return;
      }
      var btn = event.target.closest("[data-act]");
      if (!btn) return;
      var act = btn.dataset.act;
      var taskEl = btn.closest(".task");
      var id = taskEl ? taskEl.dataset.id : null;

      if (act === "add") {
        var nameEl = $("new-name");
        var created = addTask(nameEl.value, $("new-est").value);
        if (created) {
          nameEl.value = "";
          nameEl.focus();
        } else {
          nameEl.focus();
        }
        return;
      }
      if (act === "start") {
        if (state.timer && state.timer.taskId !== id) {
          var runningTask = taskById(state.timer.date, state.timer.taskId);
          openConfirm(
            "还有一件事在计时",
            "现在还在给「" + (runningTask ? runningTask.name : "某个任务") + "」计时。要先结束它吗？",
            "结束并开始新的",
            function () {
              recordUsed(state.timer.totalSec - timerRemainingSec());
              clearTimer();
              renderAll();
              openStartDialog(id);
            }
          );
          return;
        }
        if (state.timer && state.timer.taskId === id) return;
        openStartDialog(id);
        return;
      }
      if (act === "start-cancel") { closeDialogs(); return; }
      if (act === "start-confirm") {
        var minutes = Math.max(1, Math.min(600, Number($("start-min").value) || 25));
        var targetId = pendingStartTaskId;
        closeDialogs();
        startTimer(targetId, minutes);
        return;
      }
      if (act === "pause" || act === "bar-pause") {
        if (!state.timer) return;
        if (state.timer.paused) resumeTimer();
        else pauseTimer();
        return;
      }
      if (act === "bar-stop") {
        if (!state.timer) return;
        recordUsed(state.timer.totalSec - timerRemainingSec());
        clearTimer();
        renderAll();
        return;
      }
      if (act === "ring-done") {
        $("ring-step1").hidden = true;
        $("ring-step2").hidden = false;
        $("ring-feeling").focus();
        return;
      }
      if (act === "ring-back") {
        $("ring-step1").hidden = false;
        $("ring-step2").hidden = true;
        return;
      }
      if (act === "ring-extend") {
        var t = state.timer;
        if (!t) { closeDialogs(); return; }
        var extra = Math.max(1, Math.min(600, Number($("ring-extra").value) || 10));
        var taskId = t.taskId;
        var elapsed = t.totalSec - timerRemainingSec();
        recordUsed(elapsed);
        stopBell();
        state.timer = null;
        closeDialogs();
        startTimer(taskId, extra);
        return;
      }
      if (act === "ring-stop") {
        var t2 = state.timer;
        if (t2) recordUsed(t2.totalSec - timerRemainingSec());
        clearTimer();
        closeDialogs();
        renderAll();
        return;
      }
      if (act === "ring-finish") {
        var t3 = state.timer;
        if (t3) {
          var doneTask = recordUsed(t3.totalSec - timerRemainingSec());
          if (doneTask) {
            doneTask.done = true;
            doneTask.feeling = $("ring-feeling").value.trim();
          }
          $("ring-feeling").value = "";
        }
        clearTimer();
        closeDialogs();
        renderAll();
        return;
      }
      if (act === "confirm-cancel") { closeDialogs(); return; }
      if (act === "confirm-ok") {
        var run = confirmAction;
        closeDialogs();
        if (run) run();
        return;
      }
      if (act === "backup-open") {
        renderBackupDialog();
        openDialog("dialog-backup");
        return;
      }
      if (act === "backup-close" || act === "backup-later") {
        state.settings.backupAsked = true;
        saveNow({ skipBackup: true });
        closeDialogs();
        return;
      }
      if (act === "backup-choose") {
        pickSaveFile()
          .then(function (handle) {
            return setBackupHandle(handle).then(function () { return writeBackup(); });
          })
          .then(function () {
            state.settings.backupAsked = true;
            saveNow({ skipBackup: true });
            renderBackupDialog();
            renderBackupChip();
          })
          .catch(function (err) {
            setText("backup-status", "没有设置成功：" + (err && err.message ? err.message : String(err)));
          });
        return;
      }
      if (act === "backup-now") {
        writeBackup().then(function (result) {
          renderBackupDialog();
          if (!result.ok && result.reason === "nohandle") {
            setText("backup-status", "还没有设置备份文件，先点上面那一项选一个位置。");
          }
        });
        return;
      }
      if (act === "backup-restore") {
        pickOpenFile()
          .then(function (handles) { return handles[0].getFile(); })
          .then(function (file) { return file.text(); })
          .then(function (text) {
            var data = parseBackup(text);
            closeDialogs();
            openConfirm(
              "从文件恢复",
              "这会用文件里的内容覆盖当前的全部数据，而且没法撤销。确定吗？",
              "覆盖并恢复",
              function () {
                applyRestore(data);
              }
            );
          })
          .catch(function (err) {
            setText(
              "backup-status",
              "没能从文件里读出数据：" + (err && err.message ? err.message : String(err))
            );
          });
        return;
      }
      if (act === "del") {
        var list = readTasks(todayKey());
        var idx = list.findIndex(function (t) { return t.id === id; });
        if (idx >= 0) list.splice(idx, 1);
        saveSoon();
        renderAll();
        return;
      }
      if (act === "quick-add") {
        var quickEl = $("quick-input");
        var note = addQuickNote(quickEl.value);
        if (note) quickEl.value = "";
        quickEl.focus();
        return;
      }
      if (act === "quick-del") {
        var noteEl = btn.closest(".quick-item");
        var noteId = noteEl ? noteEl.dataset.noteId : null;
        var notes = readNotes(todayKey());
        var nIdx = notes.findIndex(function (n) { return n.id === noteId; });
        if (nIdx >= 0) notes.splice(nIdx, 1);
        saveSoon();
        renderQuickList();
        return;
      }
      if (act === "edit") {
        editingId = id;
        renderPlan();
        var input = document.querySelector("[data-name-input]");
        if (input) { input.focus(); input.select(); }
        return;
      }
    });

    document.addEventListener("change", function (event) {
      if (!event.target.classList.contains("task-check")) return;
      var taskEl = event.target.closest(".task");
      var task = taskById(todayKey(), taskEl.dataset.id);
      if (!task) return;
      task.done = event.target.checked;
      saveSoon();
      renderAll();
    });

    document.addEventListener("keydown", function (event) {
      var target = event.target;
      if (target.matches("[data-name-input]") && event.key === "Enter") {
        event.preventDefault();
        target.blur();
        return;
      }
      if (target.id === "new-name" && event.key === "Enter") {
        event.preventDefault();
        var addBtn = document.querySelector('[data-act="add"]');
        if (addBtn) addBtn.click();
        return;
      }
      if (target.id === "quick-input" && event.key === "Enter") {
        event.preventDefault();
        var quickBtn = document.querySelector('[data-act="quick-add"]');
        if (quickBtn) quickBtn.click();
      }
    });

    document.addEventListener("input", function (event) {
      var target = event.target;
      if (target.id === "summary") {
        state.summaries[todayKey()] = target.value;
        state.settings.lastSummaryAt = new Date().toISOString();
        saveSoon();
        renderSummarySaved();
        return;
      }
      if (target.matches("[data-feel]")) {
        var task = taskById(todayKey(), target.dataset.feel);
        if (task) {
          task.feeling = target.value;
          saveSoon();
        }
      }
    });

    document.addEventListener("focusout", function (event) {
      if (!event.target.matches("[data-name-input]")) return;
      var task = taskById(todayKey(), event.target.dataset.nameInput);
      var value = event.target.value.trim();
      if (task && value) task.name = value;
      editingId = null;
      saveSoon();
      renderPlan();
    });

    var tasksHost = $("tasks");
    tasksHost.addEventListener("dragstart", function (event) {
      var taskEl = event.target.closest(".task");
      if (!taskEl) return;
      dragId = taskEl.dataset.id;
      taskEl.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        try { event.dataTransfer.setData("text/plain", dragId); } catch (err) {}
      }
    });
    tasksHost.addEventListener("dragover", function (event) {
      event.preventDefault();
      var taskEl = event.target.closest(".task");
      Array.prototype.forEach.call(tasksHost.querySelectorAll(".is-drop"), function (el) {
        el.classList.remove("is-drop");
      });
      if (taskEl && taskEl.dataset.id !== dragId) taskEl.classList.add("is-drop");
    });
    tasksHost.addEventListener("drop", function (event) {
      event.preventDefault();
      var taskEl = event.target.closest(".task");
      if (!taskEl || !dragId) return;
      moveTask(dragId, taskEl.dataset.id);
      dragId = null;
    });
    tasksHost.addEventListener("dragend", function () {
      dragId = null;
      Array.prototype.forEach.call(tasksHost.querySelectorAll(".is-drop, .is-dragging"), function (el) {
        el.classList.remove("is-drop");
        el.classList.remove("is-dragging");
      });
    });
  }

  function moveTask(fromId, toId) {
    var list = readTasks(todayKey());
    var from = -1;
    var to = -1;
    list.forEach(function (t, i) {
      if (t.id === fromId) from = i;
      if (t.id === toId) to = i;
    });
    if (from < 0 || to < 0 || from === to) return;
    var moved = list.splice(from, 1)[0];
    list.splice(to, 0, moved);
    saveSoon();
    renderPlan();
  }

  /* ============================================================
   * 启动
   * ========================================================== */

  function init() {
    load();
    bindEvents();
    renderAll();
    goTo("home");
    if (state.timer) {
      ensureTick();
      // 关掉页面或电脑睡着的这段时间里已经过了结束时刻 → 一打开就补响
      if (!state.timer.paused && timerRemainingSec() <= 0) ring();
    }
    window.addEventListener("beforeunload", function () { saveNow(); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "hidden") return;
      saveNow({ skipBackup: true });
      if (backupHandle) writeBackup();
    });
    // 找回上次选过的备份文件；第一次用时引导设置一次
    idbGet(BACKUP_STORE, BACKUP_KEY)
      .then(function (handle) {
        if (handle) {
          backupHandle = handle;
          state.settings.backupFile = handle.name || state.settings.backupFile || "";
          renderBackupChip();
          return writeBackup();
        }
          renderBackupChip();
          // 网页版不主动弹这个窗：陌生访客一进来就被要求"选一个文件"会吓到人。
          // 想要备份的人可以自己点左下角那条。
          if (!state.settings.backupAsked && !IS_WEB) {
            state.settings.backupAsked = true;
          saveNow({ skipBackup: true });
          renderBackupDialog();
          openDialog("dialog-backup");
        }
        return null;
      })
      .catch(function () { renderBackupChip(); });
  }

  window.__jintian = {
    get state() { return state; },
    get version() { return DATA_VERSION; },
    storeKey: STORE_KEY,
    todayKey: todayKey,
    dateLabel: dateLabel,
    fmtMinutes: fmtMinutes,
    blankState: blankState,
    migrate: migrate,
    saveNow: saveNow,
    load: load,
    renderAll: renderAll,
    goTo: goTo,
    startTimer: startTimer,
    timerRemainingSec: timerRemainingSec,
    isRinging: function () { return isRinging(); },
    isWaiting: function () { return ringState.waiting; },
    bellMs: BELL_MS,
    isWeb: function () { return IS_WEB; },
    backupKeys: { db: BACKUP_DB, store: BACKUP_STORE, key: BACKUP_KEY },
    backupNow: function () { return writeBackup(); }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
