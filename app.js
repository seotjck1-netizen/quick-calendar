import { parseSchedule } from "./parse.js";
import { AuthError, deleteEvent, getToken, googleEmail, handleRedirect, insertEvent, logout, redirectUri, startLogin } from "./gcal.js";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul";
const KEYS = { apiKey: "qc.geminiKey", clientId: "qc.clientId", draft: "qc.draft", pending: "qc.pending" };

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};

const $ = (sel) => document.querySelector(sel);
const input = $("#input");
const parseBtn = $("#parse");
const addBtn = $("#add");
const review = $("#review");
const cards = $("#cards");
const statusEl = $("#status");
const dialog = $("#settings");

let events = [];

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", isError);
}

// ---- Recurrence in plain Korean ----
const DAY_KO = { MO: "월", TU: "화", WE: "수", TH: "목", FR: "금", SA: "토", SU: "일" };
function describeRule(rule) {
  const p = Object.fromEntries(rule.replace(/^RRULE:/, "").split(";").map((kv) => kv.split("=")));
  const n = Number(p.INTERVAL ?? 1);
  const unit = { DAILY: ["매일", "일"], WEEKLY: ["매주", "주"], MONTHLY: ["매월", "개월"], YEARLY: ["매년", "년"] }[p.FREQ] ?? ["반복", ""];
  let text = n === 1 ? unit[0] : p.FREQ === "WEEKLY" && n === 2 ? "격주" : `${n}${unit[1]}마다`;
  if (p.BYDAY) {
    const days = p.BYDAY.split(",").map((d) => DAY_KO[d.slice(-2)] ?? d);
    text += " " + (days.join("") === "월화수목금" ? "평일" : days.join("·"));
  }
  if (p.COUNT) text += `, ${p.COUNT}회`;
  if (p.UNTIL) text += `, ${p.UNTIL.slice(0, 4)}-${p.UNTIL.slice(4, 6)}-${p.UNTIL.slice(6, 8)}까지`;
  return text;
}

// ---- Review cards ----
function plusHour(time) {
  const [h, m] = time.split(":").map(Number);
  return `${String(Math.min(h + 1, 23)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function renderCards() {
  cards.replaceChildren(...events.map((ev, i) => {
    const li = $("#card-tpl").content.firstElementChild.cloneNode(true);
    li.dataset.index = i;
    for (const el of li.querySelectorAll("[data-field]")) {
      const v = ev[el.dataset.field];
      if (el.type === "checkbox") el.checked = v; else el.value = v;
      el.disabled = Boolean(ev.done);
    }
    li.classList.toggle("all-day", ev.allDay);
    li.classList.toggle("excluded", !ev.include);
    li.classList.toggle("done", Boolean(ev.done));
    li.classList.toggle("failed", Boolean(ev.error));

    if (ev.recurrence) {
      li.querySelector(".repeat").hidden = false;
      li.querySelector(".repeat-text").textContent = describeRule(ev.recurrence);
      li.querySelector("[data-action=clear-repeat]").hidden = Boolean(ev.done);
    }
    if (ev.notes) {
      const notes = li.querySelector(".notes");
      notes.hidden = false;
      notes.textContent = `메모: ${ev.notes}`;
    }
    const result = li.querySelector(".result");
    if (ev.done) {
      result.hidden = false;
      result.className = "result small ok";
      result.innerHTML = `✓ 등록됨 · <a target="_blank" rel="noopener">캘린더에서 보기</a>
        <button type="button" class="link" data-action="undo">취소</button>`;
      result.querySelector("a").href = ev.link;
    } else if (ev.error) {
      result.hidden = false;
      result.className = "result small err";
      result.textContent = `✕ ${ev.error}`;
    }
    return li;
  }));

  const pending = events.filter((e) => e.include && !e.done).length;
  $("#count").textContent = `${events.length}개 중 ${pending}개 선택`;
  addBtn.textContent = pending ? `${pending}개 캘린더에 추가` : "모두 등록됨";
  addBtn.disabled = !pending;
  review.hidden = events.length === 0;
}

function onCardEdit(e) {
  const li = e.target.closest(".card");
  const field = e.target.dataset.field;
  if (!li || !field) return;
  const ev = events[li.dataset.index];
  const prev = { ...ev };
  ev[field] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  ev.error = "";

  if (field === "startDate" && prev.endDate === prev.startDate) ev.endDate = ev.startDate;
  if (field === "startTime" && ev.startTime && (!ev.endTime || ev.endTime <= ev.startTime)) {
    ev.endTime = plusHour(ev.startTime);
    li.querySelector("[data-field=endTime]").value = ev.endTime;
  }
  if (field === "allDay" && !ev.allDay && !ev.startTime) {
    ev.startTime = "09:00";
    ev.endTime = "10:00";
    li.querySelector("[data-field=startTime]").value = ev.startTime;
    li.querySelector("[data-field=endTime]").value = ev.endTime;
  }
  li.classList.toggle("all-day", ev.allDay);
  li.classList.toggle("excluded", !ev.include);
  li.classList.remove("failed");
  if (field === "include") renderCards();
}
cards.addEventListener("change", onCardEdit);
cards.addEventListener("input", (e) => { if (e.target.type === "text") onCardEdit(e); });
cards.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  const ev = events[e.target.closest(".card").dataset.index];
  if (action === "clear-repeat") {
    ev.recurrence = "";
    renderCards();
  } else if (action === "undo") {
    undo(ev, e.target);
  }
});

async function undo(ev, button) {
  const token = getToken();
  if (!token) return setStatus("Google 로그인이 만료되어 취소하지 못했어요. 캘린더 앱에서 지워 주세요.", true);
  button.disabled = true;
  try {
    await deleteEvent(ev.id, token);
    Object.assign(ev, { done: false, include: false, id: undefined, link: undefined });
    renderCards();
    setStatus(`'${ev.title}' 일정을 캘린더에서 지웠어요.`);
  } catch (err) {
    button.disabled = false;
    setStatus(err instanceof AuthError ? "Google 로그인이 만료되어 취소하지 못했어요. 캘린더 앱에서 지워 주세요." : err.message, true);
  }
}

// ---- Parse ----
async function parse() {
  const text = input.value.trim();
  if (!text) return setStatus("일정을 입력해 주세요.", true);
  const apiKey = store.get(KEYS.apiKey);
  if (!apiKey) {
    setStatus("먼저 Gemini API 키를 설정해 주세요.", true);
    return openSettings();
  }
  parseBtn.disabled = true;
  parseBtn.textContent = "해석 중…";
  setStatus("");
  try {
    events = await parseSchedule(text, apiKey, TZ);
    renderCards();
    if (!events.length) setStatus("일정을 찾지 못했어요. 날짜나 시간을 넣어 다시 입력해 주세요.", true);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    parseBtn.disabled = false;
    parseBtn.textContent = "해석하기";
  }
}

// ---- Add to Google Calendar ----
function goLogin() {
  const clientId = store.get(KEYS.clientId);
  if (!clientId) {
    setStatus("먼저 Google OAuth 클라이언트 ID를 설정해 주세요.", true);
    return openSettings();
  }
  store.set(KEYS.pending, events);
  setStatus("Google 로그인으로 이동합니다…");
  startLogin(clientId);
}

function validate(ev) {
  if (!ev.startDate) return "날짜가 비어 있습니다.";
  if (!ev.allDay && !ev.startTime) return "시작 시간이 비어 있습니다.";
  if (!ev.allDay && ev.endTime && ev.endDate === ev.startDate && ev.endTime <= ev.startTime) return "종료 시간이 시작보다 빠릅니다.";
  return "";
}

async function addSelected() {
  const targets = events.filter((e) => e.include && !e.done);
  if (!targets.length) return setStatus("추가할 일정을 선택해 주세요.", true);
  const token = getToken();
  if (!token) return goLogin();

  addBtn.disabled = true;
  addBtn.textContent = "추가 중…";
  for (const ev of targets) {
    ev.error = validate(ev);
    if (ev.error) continue;
    try {
      const created = await insertEvent(ev, token, TZ);
      ev.done = true;
      ev.id = created.id;
      ev.link = created.htmlLink;
    } catch (err) {
      if (err instanceof AuthError) return goLogin();
      ev.error = err.message;
    }
  }
  renderCards();

  const failed = targets.filter((e) => e.error).length;
  if (failed) {
    setStatus(`${targets.length - failed}개 등록, ${failed}개 실패. 고친 뒤 다시 눌러 주세요.`, true);
  } else {
    setStatus(`✓ ${targets.length}개 일정을 등록했어요.`);
    input.value = "";
    store.remove(KEYS.draft);
  }
}

// Replaces the input with the clipboard and parses it right away (e.g. a message copied from KakaoTalk).
const pasteBtn = $("#paste");
if (!navigator.clipboard?.readText) pasteBtn.hidden = true;
pasteBtn.addEventListener("click", async () => {
  let text;
  try {
    text = (await navigator.clipboard.readText()).trim();
  } catch {
    return setStatus("클립보드를 읽지 못했어요. 입력칸을 길게 눌러 붙여넣어 주세요.", true);
  }
  if (!text) return setStatus("클립보드가 비어 있어요.", true);
  input.value = text;
  store.set(KEYS.draft, text);
  parse();
});

parseBtn.addEventListener("click", parse);
addBtn.addEventListener("click", addSelected);
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) parse(); });
input.addEventListener("input", () => store.set(KEYS.draft, input.value));

// ---- Settings ----
function openSettings() {
  $("#api-key").value = store.get(KEYS.apiKey) ?? "";
  $("#client-id").value = store.get(KEYS.clientId) ?? "";
  $("#redirect-uri").textContent = redirectUri();
  $("#google-state").textContent = getToken() ? "Google 연결됨" : "Google 미연결";
  if (googleEmail()) $("#google-state").textContent += ` · ${googleEmail()}`;
  $("#settings-error").hidden = true;
  dialog.showModal();
}
$("#open-settings").addEventListener("click", openSettings);

// Catches the mistakes that cause invalid_client / "API key not valid": the two fields swapped,
// or the client secret pasted along with the client ID.
const CLIENT_ID_RE = /\d+-[a-z0-9]+\.apps\.googleusercontent\.com/i;
function checkSettings() {
  const keyEl = $("#api-key");
  const idEl = $("#client-id");
  const key = keyEl.value.trim();
  const id = idEl.value.trim();
  if (CLIENT_ID_RE.test(key) || /^(AIza|AQ\.)/.test(id)) return "두 칸의 값이 서로 바뀐 것 같아요. 위에는 Gemini 키, 아래에는 클라이언트 ID를 넣어 주세요.";
  if (/^GOCSPX-/.test(key) || /^GOCSPX-/.test(id)) return "GOCSPX-로 시작하는 값(클라이언트 보안 비밀번호)은 넣지 않아요.";
  if (key && !/^(AIza|AQ\.)\S+$/.test(key)) return "Gemini API 키는 AIza 또는 AQ.로 시작해요. aistudio.google.com/apikey에서 복사해 주세요.";
  if (id) {
    const match = id.match(CLIENT_ID_RE);
    if (!match) return "클라이언트 ID는 ….apps.googleusercontent.com 으로 끝나야 해요.";
    idEl.value = match[0];
  }
  keyEl.value = key;
  return "";
}
$("#save-settings").addEventListener("click", (e) => {
  const error = checkSettings();
  if (!error) return;
  e.preventDefault();
  $("#settings-error").textContent = error;
  $("#settings-error").hidden = false;
});
dialog.addEventListener("close", () => {
  if (dialog.returnValue !== "save") return;
  store.set(KEYS.apiKey, $("#api-key").value.trim());
  store.set(KEYS.clientId, $("#client-id").value.trim());
  setStatus("설정을 저장했어요.");
});
$("#logout").addEventListener("click", () => {
  logout();
  $("#google-state").textContent = "Google 미연결";
});

// ---- Startup ----
input.value = store.get(KEYS.draft) ?? "";

const auth = handleRedirect();
if (auth?.error) {
  setStatus(auth.error === "access_denied" ? "Google 권한 요청이 거부되었습니다." : `Google 로그인 실패: ${auth.error}`, true);
}
const pending = store.get(KEYS.pending);
if (pending?.length) {
  store.remove(KEYS.pending);
  events = pending;
  renderCards();
  if (auth?.ok) addSelected();
}
if (!store.get(KEYS.apiKey) && !pending) setStatus("오른쪽 위 ⚙︎에서 API 키와 클라이언트 ID를 먼저 설정해 주세요.");

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
