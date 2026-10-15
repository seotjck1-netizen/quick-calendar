// Google sign-in (OAuth 2.0 implicit flow via full-page redirect) and Calendar API calls.
// A redirect is used instead of a popup because popups are unreliable in iOS home-screen apps.

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TOKEN_KEY = "qc.googleToken";
const STATE_KEY = "qc.oauthState";

export class AuthError extends Error {}

const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};

// Must match an "Authorized redirect URI" in the Google Cloud OAuth client exactly.
export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, "");
}

export function getToken() {
  const t = store.get(TOKEN_KEY);
  return t && t.expiresAt > Date.now() + 60_000 ? t.accessToken : null;
}

export function startLogin(clientId) {
  const state = crypto.randomUUID();
  store.set(STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: SCOPE,
    include_granted_scopes: "true",
    state,
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

// Call once on page load. Returns null when the URL holds no OAuth response.
export function handleRedirect() {
  if (!location.hash.includes("access_token") && !location.hash.includes("error=")) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);

  const expected = store.get(STATE_KEY);
  store.remove(STATE_KEY);
  if (params.get("error")) return { error: params.get("error") };
  if (!expected || params.get("state") !== expected) return { error: "state_mismatch" };

  store.set(TOKEN_KEY, {
    accessToken: params.get("access_token"),
    expiresAt: Date.now() + Number(params.get("expires_in") ?? 3600) * 1000,
  });
  return { ok: true };
}

export function logout() {
  const token = getToken();
  store.remove(TOKEN_KEY);
  if (token) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
}

function nextDay(date) {
  const [y, m, d] = date.split("-").map(Number);
  const n = new Date(y, m - 1, d + 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

export function toGoogleEvent(ev, timeZone) {
  const body = { summary: ev.title };
  if (ev.allDay) {
    // Google's all-day end date is exclusive.
    body.start = { date: ev.startDate };
    body.end = { date: nextDay(ev.endDate || ev.startDate) };
  } else {
    body.start = { dateTime: `${ev.startDate}T${ev.startTime}:00`, timeZone };
    body.end = { dateTime: `${ev.endDate || ev.startDate}T${ev.endTime || ev.startTime}:00`, timeZone };
  }
  if (ev.location) body.location = ev.location;
  if (ev.notes) body.description = ev.notes;
  if (ev.recurrence) {
    // UNTIL must be a UTC date-time when the event has a time of day.
    body.recurrence = [ev.allDay ? ev.recurrence : ev.recurrence.replace(/UNTIL=(\d{8})(?![T\d])/, "UNTIL=$1T235959Z")];
  }
  return body;
}

export async function insertEvent(ev, token, timeZone) {
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(toGoogleEvent(ev, timeZone)),
  });
  if (res.status === 401) throw new AuthError("Google 로그인이 만료되었습니다.");
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? `Google Calendar 오류 (${res.status})`);
  return data;
}
