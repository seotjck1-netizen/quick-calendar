// Turns free-form text into event objects via the Gemini API (free tier).
// The request body (prompt, JSON schema, thinking level) lives in request-template.json,
// shared with the iPhone shortcut. Keep GEMINI_MODEL in sync with SHORTCUT.md.

const GEMINI_MODEL = "gemini-3.8-flash";

// Free-tier models are often overloaded (503) or briefly rate-limited (429).
// Retry after a pause, switching to Flash-Lite, which has its own capacity and quota.
const ATTEMPTS = [
  { model: GEMINI_MODEL, delay: 0 },
  { model: "gemini-3.5-flash-lite", delay: 1000 },
  { model: GEMINI_MODEL, delay: 3000 },
];
const RETRYABLE = new Set([429, 500, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const WEEK_LABELS = ["이번주", "다음주", "다다음주"];

const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Current time plus a date table up to the end of the week after next,
// so the model looks up "다음주 화요일" instead of doing date arithmetic.
function describeNow(now, timeZone) {
  const lines = [`${ymd(now)} (${WEEKDAYS[now.getDay()]}) ${pad(now.getHours())}:${pad(now.getMinutes())}, 시간대 ${timeZone}`, "", "날짜표:"];
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const lastDay = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 20);
  for (let d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); d <= lastDay; d.setDate(d.getDate() + 1)) {
    const week = WEEK_LABELS[Math.floor(Math.round((d - monday) / 86400000) / 7)];
    const today = ymd(d) === ymd(now) ? " · 오늘" : "";
    lines.push(`${ymd(d)} (${WEEKDAYS[d.getDay()]}) ${week}${today}`);
  }
  return lines.join("\n");
}

let templatePromise;
function loadTemplate() {
  templatePromise ??= fetch("request-template.json").then((r) => {
    if (!r.ok) throw new Error("request-template.json을 불러오지 못했습니다.");
    return r.json();
  });
  return templatePromise;
}

const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/;

function toDraft(raw) {
  const s = DATETIME_RE.exec(raw.start) ?? [];
  const e = DATETIME_RE.exec(raw.end) ?? [];
  return {
    include: true,
    title: raw.title.trim() || "(제목 없음)",
    allDay: raw.all_day || !s[2],
    startDate: s[1] ?? "",
    startTime: s[2] ?? "",
    endDate: e[1] ?? s[1] ?? "",
    endTime: e[2] ?? "",
    location: raw.location.trim(),
    recurrence: raw.recurrence.trim().startsWith("RRULE:") ? raw.recurrence.trim() : "",
    notes: raw.notes.trim(),
  };
}

export async function parseSchedule(text, apiKey, timeZone) {
  const body = structuredClone(await loadTemplate());
  const prompt = body.contents[0].parts[0];
  prompt.text = prompt.text
    .replace("{{NOW}}", () => describeNow(new Date(), timeZone))
    .replace("{{TEXT}}", () => text);

  let res, data;
  for (const { model, delay } of ATTEMPTS) {
    await sleep(delay);
    // The thinking level in the template is set for GEMINI_MODEL; let other models use their default.
    const attemptBody = model === GEMINI_MODEL ? body : { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: undefined } };
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(attemptBody),
      });
    } catch {
      throw new Error("Gemini에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
    }
    data = await res.json().catch(() => null);
    if (!RETRYABLE.has(res.status)) break;
  }
  if (!res.ok) {
    const msg = data?.error?.message ?? res.statusText;
    if (res.status === 401 || res.status === 403 || /API key/i.test(msg)) {
      throw new Error("Gemini API 키가 올바르지 않습니다. 설정에서 확인해 주세요.");
    }
    if (res.status === 429) throw new Error("Gemini 무료 사용 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.");
    if (res.status >= 500) throw new Error("Gemini 서버가 붐벼요. 잠시 후 다시 시도해 주세요.");
    throw new Error(`Gemini API 오류 (${res.status}): ${msg}`);
  }
  if (data.promptFeedback?.blockReason) throw new Error("이 입력은 해석할 수 없습니다. 문장을 바꿔 다시 시도해 주세요.");
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS") throw new Error("입력이 너무 깁니다. 나눠서 입력해 주세요.");

  const output = (candidate?.content?.parts ?? []).filter((p) => p.text && !p.thought).map((p) => p.text).join("");
  if (!output) throw new Error("응답에 결과가 없습니다. 다시 시도해 주세요.");
  return JSON.parse(output).events.map(toDraft);
}
