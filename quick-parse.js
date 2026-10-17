// Instant on-device parsing for the common one-line cases ("내일 오후 3시 치과", "10/24 엄마 생신",
// "매주 월수금 아침 7시 수영"). A line it isn't sure about is left for Gemini, so a wrong guess
// costs a round trip instead of a wrong event.

const DAY = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const RRDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MARK = "(오전|오후|아침|저녁|밤|새벽|낮)?";
const CLOCK = "(\\d{1,2})\\s*(?:시(?!간)\\s*(반|(\\d{1,2})\\s*분)?|:(\\d{2}))";
const TIME_RANGE_RE = new RegExp(`${MARK}\\s*${CLOCK}\\s*(?:부터|~|-|–)\\s*${MARK}\\s*${CLOCK}\\s*(?:까지)?`);
const TIME_RE = new RegExp(`${MARK}\\s*${CLOCK}`);
const ANY_TIME_RE = /\d{1,2}\s*시(?!간)|\d{1,2}:\d{2}/;
// Words that mean the line needs more than this parser understands.
const UNSURE_RE = /까지|부터|동안|마다|매주|매일|격주|매월|매달|매년|번째|\d+\s*(번|회)|주말|월말|연말|초에|중순|쯤|자정|그리고|또는|및|이랑\s*\d/;
const FILLER = new Set(["에", "에는", "엔", "은", "는", "을", "를", "의", ",", "-", "~", "·"]);

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const validDate = (y, m, d) => {
  const date = new Date(y, m, d);
  return date.getMonth() === m && date.getDate() === d ? date : null;
};

function to24(mark, h, min, pmHint) {
  if (h > 24 || min > 59) return null;
  if (mark === "오후" || mark === "저녁" || mark === "밤") h = h < 12 ? h + 12 : h;
  else if (mark === "낮") h = h <= 5 ? h + 12 : h;
  else if (mark === "오전" || mark === "아침" || mark === "새벽") h = h === 12 ? 0 : h;
  else if (pmHint !== undefined) h = pmHint && h < 12 ? h + 12 : h;
  else if (h >= 1 && h <= 7) h += 12; // a bare "3시" is an afternoon appointment
  return h === 24 ? null : h * 60 + min;
}

const clockMinutes = (half, mins, colon) => (half === "반" ? 30 : Number(mins ?? colon ?? 0));

function parseLine(line, now) {
  if (line.length > 60) return null;
  let s = ` ${line} `;
  const cut = (re) => {
    const m = s.match(re);
    if (m) s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length);
    return m;
  };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  let date = null;
  let recurrence = "";
  let m;

  // Repetition: only the plain forms; anything else is left to the model.
  if ((m = cut(/매일(마다)?/))) {
    recurrence = "RRULE:FREQ=DAILY";
  } else if ((m = cut(/(매주\s*)?평일(마다)?/))) {
    recurrence = "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
    date = [0, 1, 2, 3].map((n) => addDays(today, n)).find((d) => d.getDay() % 6 !== 0);
  } else if ((m = cut(/매주\s*([월화수목금토일](?:\s*[,·]?\s*[월화수목금토일])*)\s*(?:요일|욜)?(?:마다)?(?=\s)/))) {
    const days = [...new Set([...m[1].replace(/[\s,·]/g, "")].map((c) => DAY[c]))];
    recurrence = `RRULE:FREQ=WEEKLY;BYDAY=${days.map((d) => RRDAY[d]).join(",")}`;
    date = [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(today, n)).find((d) => days.includes(d.getDay()));
  }

  // Dates: at most one per line.
  const upcoming = (month, day) => {
    const d = validDate(today.getFullYear(), month, day);
    return d && d < today ? validDate(today.getFullYear() + 1, month, day) : d;
  };
  const DATES = [
    [/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/, (x) => validDate(+x[1], x[2] - 1, +x[3])],
    [/(\d{1,2})\s*월\s*(\d{1,2})\s*일/, (x) => upcoming(x[1] - 1, +x[2])],
    [/(?<![\d:])(\d{1,2})\s*[/.]\s*(\d{1,2})(?![\d:])/, (x) => upcoming(x[1] - 1, +x[2])],
    [/오늘|금일/, () => today],
    [/내일/, () => addDays(today, 1)],
    [/모레/, () => addDays(today, 2)],
    [/글피/, () => addDays(today, 3)],
    [/(이번\s*주|다다음\s*주|다음\s*주|담주)?\s*([월화수목금토일])\s*(?:요일|욜)/, (x) => {
      const target = DAY[x[2]];
      if (!x[1]) return [0, 1, 2, 3, 4, 5, 6].map((n) => addDays(today, n)).find((d) => d.getDay() === target);
      const weeks = /다다음/.test(x[1]) ? 2 : /다음|담/.test(x[1]) ? 1 : 0;
      const monday = addDays(today, -((today.getDay() + 6) % 7));
      return addDays(monday, weeks * 7 + ((target + 6) % 7));
    }],
    [/(?<![\d./월])(\d{1,2})\s*일(?![간동])/, (x) => {
      const d = validDate(today.getFullYear(), today.getMonth(), +x[1]);
      return d && d < today ? validDate(today.getFullYear(), today.getMonth() + 1, +x[1]) : d;
    }],
  ];
  for (const [re, resolve] of DATES) {
    if (!(m = cut(re))) continue;
    if (date && !recurrence) return null; // two dates on one line
    if (recurrence) return null; // "매주 ... 10/24" and the like
    date = resolve(m);
    if (!date) return null;
  }
  if (DATES.some(([re]) => re.test(s))) return null;

  // Times.
  let start = null;
  let end = null;
  let duration = 60;
  if ((m = cut(/(\d+)\s*시간\s*(반)?/))) duration = Number(m[1]) * 60 + (m[2] ? 30 : 0);
  if ((m = cut(TIME_RANGE_RE))) {
    start = to24(m[1], Number(m[2]), clockMinutes(m[3], m[4], m[5]));
    if (start === null) return null;
    end = to24(m[6], Number(m[7]), clockMinutes(m[8], m[9], m[10]), m[6] ? undefined : start >= 12 * 60);
    if (end === null) return null;
    if (end <= start && end < 12 * 60) end += 12 * 60;
    if (end <= start) return null;
  } else if ((m = cut(TIME_RE))) {
    start = to24(m[1], Number(m[2]), clockMinutes(m[3], m[4], m[5]));
    if (start === null) return null;
  } else if ((m = s.match(/정오/))) {
    cut(/정오/);
    start = 12 * 60;
  } else if (/점심/.test(s)) {
    start = 12 * 60;
  } else if (/저녁/.test(s)) {
    start = 19 * 60;
  }
  if (ANY_TIME_RE.test(s)) return null; // a second time on the line
  if (start !== null && end === null) end = start + duration;

  // Place: "X에서", or a station name.
  let location = "";
  if ((m = cut(/(\S+?)\s*에서(?=\s)/))) location = m[1];
  else if ((m = cut(/(?<=\s)(\S{2,}역)(?=\s)/))) location = m[1];

  if (UNSURE_RE.test(s)) return null;
  if (!date && start === null && !recurrence) return null;

  if (!date) date = start !== null && start <= nowMinutes ? addDays(today, 1) : today;

  const title = s
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .join(" ")
    .replace(/^[,.\-~·\s]+|[,.\-~·\s]+$/g, "");

  const timeOf = (mins) => `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
  const allDay = start === null;
  return {
    include: true,
    title: title || "(제목 없음)",
    allDay,
    startDate: ymd(date),
    startTime: allDay ? "" : timeOf(start),
    endDate: allDay ? ymd(date) : ymd(addDays(date, Math.floor(end / (24 * 60)))),
    endTime: allDay ? "" : timeOf(end),
    location,
    recurrence,
    notes: "",
    quick: true,
  };
}

// Splits the input into lines parsed here and lines left for the model.
export function quickParse(text, now = new Date()) {
  const events = [];
  const rest = [];
  for (const line of text.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
    const ev = parseLine(line, now);
    if (ev) events.push(ev);
    else rest.push(line);
  }
  return { events, rest };
}
