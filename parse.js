// Turns free-form text into event objects via the Claude Messages API.
// The prompt and JSON schema live in request-template.json, shared with the iPhone shortcut.

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
  const template = await loadTemplate();
  const body = structuredClone(template);
  body.messages[0].content = body.messages[0].content
    .replace("{{NOW}}", () => describeNow(new Date(), timeZone))
    .replace("{{TEXT}}", () => text);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message ?? res.statusText;
    if (res.status === 401) throw new Error("Claude API 키가 올바르지 않습니다. 설정에서 확인해 주세요.");
    throw new Error(`Claude API 오류 (${res.status}): ${msg}`);
  }
  if (data.stop_reason === "refusal") throw new Error("이 입력은 해석할 수 없습니다. 문장을 바꿔 다시 시도해 주세요.");
  if (data.stop_reason === "max_tokens") throw new Error("입력이 너무 깁니다. 나눠서 입력해 주세요.");

  const textBlock = data.content.findLast((b) => b.type === "text");
  if (!textBlock) throw new Error("응답에 결과가 없습니다. 다시 시도해 주세요.");
  return JSON.parse(textBlock.text).events.map(toDraft);
}
