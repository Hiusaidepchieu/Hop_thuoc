// =====================================================
// Dashboard cap thuoc (ban v5) - Firebase Realtime Database
// ESP32 (smart_lock_v5) ghi:
//   /sensor_data/timestamp, detected     - gio + cam bien
//   /medicine/tray1..3                   - trang thai khay (OPEN/CLOSE)
//   /history/<key>  {name,result,tray,time}  - MOI LAN QUET MAT / BAO THUC
// Web ghi:
//   /control/servo1..3                   - nut Mo/Dong
//   /alarms  "HH:MM,khay;HH:MM,khay"     - lich hen (khay = all|1|2|3), ESP32 doc va keu coi
// =====================================================

const firebaseConfig = {
  apiKey: "AIzaSyDMltX6AMupq4DDQqwUPxVEtbySY7c9Mew",
  databaseURL: "https://pbl3-b2afb-default-rtdb.firebaseio.com",
  projectId: "pbl3-b2afb"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// *** SUA O DAY ***
// Khoa = ten trong PERSON_NAME cua ESP32 (viet thuong) = phan truoc dau "_" cua ten file anh trong known/
const PERSON_INFO = {
  hung: { name: "Trần Phạm Ngọc Hiếu", tray: 1, color: "4f46e5" },
  lan:  { name: "Người dùng 2",         tray: 2, color: "0ea5e9" },
  minh: { name: "Người dùng 3",         tray: 3, color: "10b981" }
};

const OFFLINE_AFTER_MS = 20000;
const MAX_ALARMS = 10;

// ---------------- Trang thai ----------------
let fbConnected = false;
let deviceOnline = false;
let lastTs = null;
let lastTsChange = 0;
let deviceTs = "";           // timestamp moi nhat tu ESP32
let history = [];            // [{key,name,result,tray,time}] tang dan theo thoi gian
let historyReady = false;
let lastHistoryKey = null;
let alarmRaw = "";

const $ = (id) => document.getElementById(id);

// ---------------- Tien ich ----------------
function parseTs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s || "");
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
function fmtFull(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s || "");
  return m ? `${m[4]}:${m[5]}:${m[6]}  ·  ${m[3]}/${m[2]}/${m[1]}` : "--:--:--";
}
function fmtShort(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s || "");
  return m ? `${m[4]}:${m[5]} · ${m[3]}/${m[2]}` : "—";
}
function avatarUrl(name, color) {
  return "https://ui-avatars.com/api/?name=" + encodeURIComponent(name) +
         "&background=" + color + "&color=fff&size=160&bold=true";
}
function todayStr() {
  if (deviceTs) return deviceTs.slice(0, 10);
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Chuan hoa 1 dong lich su thanh thong tin hien thi
function describe(h) {
  const key = String(h.name || "").toLowerCase();
  const info = PERSON_INFO[key];
  if (h.result === "OK") {
    return {
      title: info ? info.name : (h.name || "?"),
      avatar: avatarUrl(info ? info.name : (h.name || "?"), info ? info.color : "0D8ABC"),
      badge: "Đã mở Ngăn " + h.tray, cls: "ok", icon: "fa-door-open"
    };
  }
  if (h.result === "UNASSIGNED") {
    return {
      title: info ? info.name : (h.name || "?"),
      avatar: avatarUrl(info ? info.name : (h.name || "?"), "f59e0b"),
      badge: "Chưa gán ngăn", cls: "warn", icon: "fa-circle-question"
    };
  }
  if (h.result === "ALARM") {
    return {
      title: "Báo thức uống thuốc",
      avatar: avatarUrl("⏰", "6366f1"),
      badge: Number(h.tray) === 0 ? "Tất cả các ngăn" : "Ngăn " + h.tray,
      cls: "info", icon: "fa-bell"
    };
  }
  return {
    title: "Người lạ / không nhận ra",
    avatar: avatarUrl("?", "ef4444"),
    badge: "Từ chối", cls: "bad", icon: "fa-ban"
  };
}

// ---------------- Toast ----------------
function toast(title, text, cls) {
  const box = $("toast-box");
  const el = document.createElement("div");
  el.className = "toast-item " + (cls || "ok");
  const t = document.createElement("div"); t.className = "toast-title"; t.textContent = title;
  const p = document.createElement("div"); p.className = "toast-text"; p.textContent = text;
  el.appendChild(t); el.appendChild(p);
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400);
  }, 6000);
}

// ---------------- Ket noi ----------------
function renderConnection() {
  const el = $("connection-status");
  let text, cls;
  if (!fbConnected)        { text = "Mất kết nối Firebase"; cls = "bad"; }
  else if (!deviceOnline)  { text = "ESP32 ngoại tuyến";    cls = "warn"; }
  else                     { text = "Thiết bị đang hoạt động"; cls = "ok"; }
  el.className = "status-pill " + cls;
  $("connection-text").textContent = text;
}

db.ref(".info/connected").on("value", (snap) => {
  fbConnected = snap.val() === true;
  renderConnection();
});

setInterval(() => {
  if (lastTsChange) {
    const online = Date.now() - lastTsChange < OFFLINE_AFTER_MS;
    if (online !== deviceOnline) { deviceOnline = online; renderConnection(); }
  }
}, 3000);

// ---------------- Cam bien + gio ----------------
db.ref("sensor_data").on("value", (snap) => {
  const s = snap.val() || {};
  deviceTs = s.timestamp || deviceTs;
  $("rtc-time").textContent = fmtFull(s.timestamp);

  const pir = $("pir-status");
  if (s.detected === true) { pir.textContent = "Có người / vật phía trước"; pir.className = "sensor on"; }
  else                     { pir.textContent = "Không có người / vật";        pir.className = "sensor"; }

  if (s.timestamp !== lastTs) {
    lastTs = s.timestamp;
    lastTsChange = Date.now();
    if (!deviceOnline) { deviceOnline = true; renderConnection(); }
  }
  renderStats();
});

// ---------------- Khay thuoc ----------------
db.ref("medicine").on("value", (snap) => {
  const m = snap.val() || {};
  for (let i = 1; i <= 3; i++) {
    const open = String(m["tray" + i] || "CLOSE").toUpperCase() === "OPEN";
    const st = $("tray-state-" + i);
    st.textContent = open ? "ĐANG MỞ" : "ĐANG ĐÓNG";
    st.className = "tray-state " + (open ? "open" : "closed");
  }
});

function controlServo(n, state) {
  db.ref("control/servo" + n).set(state).catch((e) => alert("Gửi lệnh thất bại: " + e.message));
}

// ---------------- Lich su quet ----------------
db.ref("history").limitToLast(60).on("value", (snap) => {
  const val = snap.val() || {};
  history = Object.keys(val).sort().map((k) => Object.assign({ key: k }, val[k]));

  const newest = history.length ? history[history.length - 1] : null;
  if (historyReady && newest && newest.key !== lastHistoryKey) {
    const d = describe(newest);
    if (newest.result === "OK")          toast("Xin chào " + d.title, "Đã mở Ngăn " + newest.tray + " · " + fmtShort(newest.time), "ok");
    else if (newest.result === "ALARM")  toast("Đến giờ uống thuốc", d.badge + " · " + fmtShort(newest.time), "info");
    else if (newest.result === "UNASSIGNED") toast(d.title, "Nhận ra khuôn mặt nhưng chưa gán ngăn", "warn");
    else                                 toast("Không nhận ra khuôn mặt", fmtShort(newest.time), "bad");
  }
  lastHistoryKey = newest ? newest.key : null;
  historyReady = true;

  renderHero();
  renderPeople();
  renderHistory();
  renderStats();
});

function renderHero() {
  const faceEntries = history.filter((h) => h.result !== "ALARM");
  const h = faceEntries.length ? faceEntries[faceEntries.length - 1] : null;
  const avatar = $("hero-avatar"), name = $("hero-name"), badge = $("hero-badge");
  const time = $("hero-time"), tray = $("hero-tray");

  if (!h) {
    avatar.src = avatarUrl("?", "94a3b8");
    name.textContent = "Chưa có lượt quét nào";
    badge.className = "pill gray"; badge.innerHTML = '<i class="fas fa-hourglass-half"></i> Đang chờ';
    time.textContent = "—"; tray.textContent = "—";
    return;
  }
  const d = describe(h);
  avatar.src = d.avatar;
  name.textContent = d.title;
  badge.className = "pill " + d.cls;
  badge.innerHTML = '<i class="fas ' + d.icon + '"></i> ' + d.badge;
  time.textContent = fmtFull(h.time);
  tray.textContent = h.result === "OK" ? "Ngăn " + h.tray : "—";
}

function renderPeople() {
  const wrap = $("people");
  wrap.innerHTML = "";
  const today = todayStr();
  const now = parseTs(deviceTs);

  Object.keys(PERSON_INFO).forEach((key) => {
    const info = PERSON_INFO[key];
    const mine = history.filter((h) => h.result === "OK" && String(h.name).toLowerCase() === key);
    const last = mine.length ? mine[mine.length - 1] : null;
    const todayCount = mine.filter((h) => String(h.time).startsWith(today)).length;

    let live = false;
    if (last && now) {
      const t = parseTs(last.time);
      live = t && Math.abs(now - t) <= 20000;
    }

    const card = document.createElement("div");
    card.className = "person-card" + (live ? " live" : "");

    const img = document.createElement("img");
    img.src = avatarUrl(info.name, info.color);
    img.alt = info.name;

    const nm = document.createElement("div"); nm.className = "person-name"; nm.textContent = info.name;
    const chip = document.createElement("div"); chip.className = "person-chip";
    chip.textContent = "Ngăn " + info.tray + " · Servo " + info.tray;
    const lastEl = document.createElement("div"); lastEl.className = "person-meta";
    lastEl.textContent = last ? "Gần nhất: " + fmtShort(last.time) : "Chưa quét lần nào";
    const cnt = document.createElement("div"); cnt.className = "person-count";
    cnt.textContent = todayCount + " lượt hôm nay";

    card.appendChild(img); card.appendChild(nm); card.appendChild(chip);
    card.appendChild(lastEl); card.appendChild(cnt);
    wrap.appendChild(card);
  });
}

function renderHistory() {
  const box = $("history");
  box.innerHTML = "";
  if (history.length === 0) {
    const e = document.createElement("div");
    e.className = "empty"; e.textContent = "Chưa có lượt quét nào. Hãy bấm nút trên thiết bị để quét khuôn mặt.";
    box.appendChild(e);
    return;
  }
  history.slice().reverse().forEach((h) => {
    const d = describe(h);
    const row = document.createElement("div");
    row.className = "hist-item";

    const img = document.createElement("img"); img.src = d.avatar; img.alt = "";
    const mid = document.createElement("div"); mid.className = "hist-mid";
    const t = document.createElement("div"); t.className = "hist-name"; t.textContent = d.title;
    const s = document.createElement("div"); s.className = "hist-time"; s.textContent = fmtFull(h.time);
    mid.appendChild(t); mid.appendChild(s);

    const b = document.createElement("span");
    b.className = "pill " + d.cls;
    b.innerHTML = '<i class="fas ' + d.icon + '"></i> ';
    b.appendChild(document.createTextNode(d.badge));

    row.appendChild(img); row.appendChild(mid); row.appendChild(b);
    box.appendChild(row);
  });
}

function renderStats() {
  const today = todayStr();
  const todays = history.filter((h) => h.result !== "ALARM" && String(h.time).startsWith(today));
  $("stat-total").textContent  = todays.length;
  $("stat-ok").textContent     = todays.filter((h) => h.result === "OK").length;
  $("stat-denied").textContent = todays.filter((h) => h.result !== "OK").length;
}

// ---------------- Hen gio ----------------
function parseAlarms(str) {
  return String(str || "").split(";").filter(Boolean).map((x) => {
    const p = x.split(",");
    return { time: p[0], tray: p[1] || "all" };
  });
}
function serializeAlarms(list) {
  list.sort((a, b) => a.time.localeCompare(b.time));
  return list.map((a) => a.time + "," + a.tray).join(";");
}

db.ref("alarms").on("value", (snap) => {
  alarmRaw = snap.val() || "";
  renderAlarms();
});

function renderAlarms() {
  const box = $("alarm-list");
  box.innerHTML = "";
  const list = parseAlarms(alarmRaw).sort((a, b) => a.time.localeCompare(b.time));
  if (list.length === 0) {
    const e = document.createElement("div"); e.className = "empty"; e.textContent = "Chưa có lịch hẹn nào.";
    box.appendChild(e);
    return;
  }
  list.forEach((a) => {
    const chip = document.createElement("div"); chip.className = "alarm-chip";
    const t = document.createElement("span"); t.className = "alarm-time"; t.textContent = a.time;
    const tr = document.createElement("span"); tr.className = "alarm-tray";
    tr.textContent = a.tray === "all" ? "Tất cả các ngăn" : "Ngăn " + a.tray;
    const del = document.createElement("button"); del.className = "alarm-del"; del.title = "Xóa";
    del.innerHTML = '<i class="fas fa-xmark"></i>';
    del.onclick = () => deleteAlarm(a.time, a.tray);
    chip.appendChild(t); chip.appendChild(tr); chip.appendChild(del);
    box.appendChild(chip);
  });
}

function setAlarm() {
  const time = $("alarm-time").value;
  const tray = $("alarm-compartment").value;
  if (!time) { alert("Vui lòng chọn giờ."); return; }
  db.ref("alarms").transaction((cur) => {
    const list = parseAlarms(cur);
    if (list.some((a) => a.time === time && a.tray === tray)) return cur;   // da co
    if (list.length >= MAX_ALARMS) return;                                  // huy
    list.push({ time: time, tray: tray });
    return serializeAlarms(list);
  }, (err, committed) => {
    if (err) alert("Lưu lịch thất bại: " + err.message);
    else if (!committed) alert("Không thể thêm (đã đủ " + MAX_ALARMS + " lịch).");
    else { $("alarm-time").value = ""; toast("Đã đặt lịch", time + " · " + (tray === "all" ? "tất cả ngăn" : "Ngăn " + tray), "info"); }
  });
}

function deleteAlarm(time, tray) {
  db.ref("alarms").transaction((cur) => {
    const list = parseAlarms(cur).filter((a) => !(a.time === time && a.tray === tray));
    return list.length ? serializeAlarms(list) : null;
  });
}
