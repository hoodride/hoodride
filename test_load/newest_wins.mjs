// Real-websocket check of NEWEST WINS against a running server, with a client
// that IGNORES "session_moved" (a hacked or outdated app). Proves the SERVER
// closes the old socket on its own, and measures how fast.
//
// Run: node test_load/newest_wins.mjs   (server on :4000, dev_login enabled)

const BASE = "http://127.0.0.1:4000";
const WS = "ws://127.0.0.1:4000/socket/websocket?vsn=2.0.0";

let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const fail = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};

async function login(name) {
  const r = await fetch(`${BASE}/api/dev_login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agree_terms: true, name }),
  });
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const me = (await (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json()).user;
  return { cookie, me };
}

async function token(cookie) {
  return (await (await fetch(`${BASE}/api/socket_token`, { headers: { cookie } })).json()).token;
}

// a minimal Phoenix v2 client that records everything and never reacts to
// session_moved (so any close must come from the server)
// `params`: the session stamp params (Hoodride.SessionStamp) — none = an old app
function client(tok, params = {}) {
  const extra = Object.entries(params)
    .map(([k, v]) => `&${k}=${encodeURIComponent(v)}`)
    .join("");
  const ws = new WebSocket(`${WS}&token=${encodeURIComponent(tok)}${extra}`);
  const c = { ws, events: [], replies: new Map(), closedAt: null, ref: 0 };
  c.opened = new Promise((res) => (ws.onopen = res));
  ws.onclose = () => (c.closedAt = performance.now());
  ws.onmessage = (e) => {
    const [, ref, topic, event, payload] = JSON.parse(e.data);
    c.events.push({ t: performance.now(), topic, event, payload });
    if (event === "phx_reply" && c.replies.has(ref)) c.replies.get(ref)(payload);
  };
  c.push = (topic, event, payload, joinRef = "1") =>
    new Promise((res, rej) => {
      const ref = String(++c.ref);
      c.replies.set(ref, res);
      ws.send(JSON.stringify([joinRef, ref, topic, event, payload]));
      setTimeout(() => rej(new Error(`no reply to ${event}`)), 3000);
    });
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("newest-wins, real websockets, old client ignores session_moved:\n");
  const { cookie, me } = await login(`NW-${Date.now()}`);
  const topic = `user:${me.id}`;

  const A = client(await token(cookie));
  await A.opened;
  const ja = await A.push(topic, "phx_join", {});
  ja.status === "ok" ? ok("session A connected and joined") : fail("A join");

  const B = client(await token(cookie));
  await B.opened;
  const jb = await B.push(topic, "phx_join", {});
  const tJoinB = performance.now();
  jb.status === "ok" ? ok("session B (same account) connected and joined") : fail("B join");

  // give the server up to 2s; A deliberately does nothing
  for (let i = 0; i < 40 && A.closedAt === null; i++) await sleep(50);

  const moved = A.events.find((e) => e.event === "session_moved");
  moved ? ok("A was told session_moved") : fail("A never received session_moved");

  if (A.closedAt !== null) {
    ok(`server closed A's socket on its own — ${(A.closedAt - tJoinB).toFixed(1)} ms after B joined`);
  } else {
    fail("A's socket is still open 2s later — the server did not close it");
  }

  if (moved && A.closedAt !== null && moved.t <= A.closedAt) {
    ok("the session_moved message arrived BEFORE the close");
  } else if (moved) {
    fail("close happened before session_moved was delivered");
  }

  // B must be alive and fully usable
  const r = await B.push(topic, "cancel_request", {});
  r.status === "ok" ? ok("B still connected and answering") : fail("B not answering");
  B.ws.readyState === WebSocket.OPEN ? ok("B's socket still open") : fail("B's socket closed");

  // ---- ONE SOCKET PER ACCOUNT, at connect: a socket can connect and never
  // join anything. Those used to escape newest wins (it acted only on a user
  // channel join) and piled up without limit. Now every connect replaces the
  // account's older sockets: a real tab (user channel) by the hand-over, an
  // idle one by a plain close; and a socket that never joins its user
  // channel is closed after the join deadline (10 s).
  console.log("\none socket per account (idle sockets, hand-over, join deadline):\n");
  const tB = performance.now();
  const I1 = client(await token(cookie));
  await I1.opened;
  for (let i = 0; i < 40 && B.closedAt === null; i++) await sleep(50);
  B.events.find((e) => e.event === "session_moved")
    ? ok("a new CONNECT (no join yet) hands the real tab B over: session_moved")
    : fail("B was not told session_moved by a new connect");
  B.closedAt !== null
    ? ok(`B's socket closed ${(B.closedAt - tB).toFixed(1)} ms after the new connect`)
    : fail("B's socket still open after a newer connect");

  const I2 = client(await token(cookie));
  await I2.opened;
  for (let i = 0; i < 40 && I1.closedAt === null; i++) await sleep(50);
  I1.closedAt !== null
    ? ok("an IDLE socket (never joined anything) is closed by the next connect")
    : fail("idle socket I1 survived a newer connect — idle sockets pile up");
  I1.events.length === 0
    ? ok("...with a plain close (it had no channel to tell)")
    : fail(`I1 received ${I1.events.map((e) => e.event)}`);

  // the join deadline: I2 never joins its user channel
  const t0 = performance.now();
  for (let i = 0; i < 260 && I2.closedAt === null; i++) await sleep(50);
  if (I2.closedAt === null) fail("a socket that never joined its user channel is still open after 13 s");
  else {
    const s = (I2.closedAt - t0) / 1000;
    s > 8 && s < 12
      ? ok(`a socket that never joins its user channel is closed by the join deadline (${s.toFixed(1)} s)`)
      : fail(`I2 closed at ${s.toFixed(1)} s, not at the ~10 s deadline`);
  }

  // a socket that DOES join stays past the deadline
  const J = client(await token(cookie));
  await J.opened;
  (await J.push(topic, "phx_join", {})).status === "ok" ? ok("socket J joined its user channel") : fail("J join");
  await sleep(11000);
  J.ws.readyState === WebSocket.OPEN
    ? ok("...and is still open after the deadline")
    : fail("J was closed although it joined its user channel");
  J.ws.close();

  // the connect budget: a connect loop is refused after its burst
  let refused = 0;
  for (let i = 0; i < 30; i++) {
    const L = client(await token(cookie));
    const r = await Promise.race([L.opened.then(() => "open"), new Promise((res) => (L.ws.onerror = () => res("refused")))]);
    if (r === "refused") refused++;
    L.ws.close();
  }
  refused > 0
    ? ok(`a connect loop is refused after its burst (${refused} of 30 refused)`)
    : fail("30 rapid connects were all accepted — connects are unbudgeted");

  // ---- two tabs loading at the SAME instant (fresh account). Each behaves
  // like the real app: connect, join its user channel, reconnect after a
  // close — unless told session_moved, which stops it for good. The claim:
  // it settles after at most one bounce, never a kick loop.
  console.log("\ntwo tabs loading at the same instant:\n");
  const fresh = await login(`NW2-${Date.now()}`);
  const freshTopic = `user:${fresh.me.id}`;

  function appTab(name) {
    const tab = { name, connects: 0, moved: false, live: null };
    const start = async () => {
      if (tab.moved) return;
      tab.connects++;
      const c = client(await token(fresh.cookie));
      tab.live = c;
      c.ws.addEventListener("message", (e) => {
        const [, , , event] = JSON.parse(e.data);
        if (event === "session_moved") tab.moved = true;
      });
      c.ws.addEventListener("close", () => {
        if (tab.live === c && !tab.moved) setTimeout(start, 200);
      });
      c.ws.addEventListener("error", () => {});
      try {
        await c.opened;
        await c.push(freshTopic, "phx_join", {});
      } catch (_) {}
    };
    tab.start = start;
    return tab;
  }

  const X = appTab("X");
  const Y = appTab("Y");
  await Promise.all([X.start(), Y.start()]);
  await sleep(6000);

  const open = [X, Y].filter((t) => t.live && t.live.ws.readyState === WebSocket.OPEN);
  open.length === 1
    ? ok(`exactly one tab is connected after 6 s (${open[0].name})`)
    : fail(`${open.length} tabs connected after 6 s`);
  const loser = [X, Y].find((t) => t !== open[0]);
  loser && loser.moved
    ? ok(`the other tab (${loser.name}) was told session_moved and stopped`)
    : fail("the other tab was never told session_moved");
  const total = X.connects + Y.connects;
  total <= 3
    ? ok(`settled in ${total} connects (at most one bounce)`)
    : fail(`${total} connects — the tabs kicked each other in a loop`);
  for (const t of [X, Y]) t.live && t.live.ws.close();

  // ---- THE DEVICE YOU CHOSE LAST WINS (session stamps). A choice (page
  // load, refresh, "Use here") takes over; an automatic reconnect carries its
  // tab's stamp and gets in only if no newer choice exists.
  console.log("\nthe device you chose last wins (stamps):\n");
  const st = await login(`NW3-${Date.now()}`);
  const stTopic = `user:${st.me.id}`;
  const tok3 = await token(st.cookie);
  const choose = async () => {
    const c = client(tok3, { takeover: "true" });
    await c.opened;
    const r = await c.push(stTopic, "phx_join", {});
    c.stamp = r.response && r.response.stamp;
    return c;
  };
  const auto = async (stamp) => {
    const c = client(tok3, { stamp: String(stamp), takeover: "false" });
    await c.opened;
    c.join = await c.push(stTopic, "phx_join", {}).catch(() => ({ status: "none" }));
    return c;
  };
  const sentAway = (c) => c.join.status === "error" && c.join.response.reason === "session_moved";
  const toldMoved = (c) => c.events.some((e) => e.event === "session_moved");

  const phone = await choose();
  Number.isInteger(phone.stamp) ? ok(`a choice gets a stamp (${phone.stamp})`) : fail("no stamp in the join reply");
  const laptop = await choose();
  laptop.stamp > phone.stamp ? ok("a later choice gets a higher stamp") : fail("stamps didn't rise");
  await sleep(200);
  toldMoved(phone) ? ok("the phone was told session_moved (the laptop chose last)") : fail("phone not told");

  // the tunnel phone: it never heard it, and comes back by itself
  const tZombie = performance.now();
  const zombie = await auto(phone.stamp);
  await sleep(300);
  sentAway(zombie)
    ? ok("the phone reconnecting by itself is refused: session_moved")
    : fail(`zombie join: ${JSON.stringify(zombie.join)}`);
  zombie.closedAt
    ? ok(`...and the server closed it (${(zombie.closedAt - tZombie).toFixed(0)} ms after it connected)`)
    : fail("the zombie's socket is still open");
  !toldMoved(laptop) && laptop.ws.readyState === WebSocket.OPEN
    ? ok("the laptop was untouched: still open, never told it moved")
    : fail("the laptop was disturbed");
  (await laptop.push(stTopic, "__barrier__", {}).catch(() => null))
    ? ok("the laptop still answers")
    : fail("the laptop stopped answering");

  // a blip: nobody live, but the server remembers the laptop's stamp
  laptop.ws.close();
  await sleep(300);
  const zombie2 = await auto(phone.stamp);
  sentAway(zombie2)
    ? ok("with nobody connected, the phone still can't come back by itself")
    : fail("blip: the phone got in");
  const laptop2 = await auto(laptop.stamp);
  laptop2.join.status === "ok"
    ? ok("the laptop's own reconnect gets in")
    : fail(`laptop reconnect: ${JSON.stringify(laptop2.join)}`);

  // the same tab reconnecting while its old socket still looks alive
  const laptop3 = await auto(laptop.stamp);
  await sleep(300);
  laptop3.join.status === "ok" && !toldMoved(laptop3)
    ? ok("the same tab reconnecting replaces its own leftover, silently")
    : fail("same-tab reconnect refused or told it moved");
  laptop2.closedAt ? ok("...and its leftover was closed") : fail("leftover still open");

  // a refresh past a leftover: a choice
  const refreshed = await choose();
  await sleep(300);
  !toldMoved(refreshed) && refreshed.ws.readyState === WebSocket.OPEN
    ? ok("a refresh gets in and is never told it moved")
    : fail("the refreshed page was disturbed");
  toldMoved(laptop3) ? ok("...the page it replaced was told it moved") : fail("the replaced page wasn't told");
  for (const c of [phone, zombie, zombie2, laptop2, laptop3, refreshed]) c.ws.close();

  // ---- THE LOGIN LOCKDOWN: the token in the WebSocket protocol header (not
  // the URL), and a sign-out that ends every socket and token of the account
  console.log("\nlogin lockdown (real sockets):\n");
  const lk = await login(`NW4-${Date.now()}`);
  const lkTok = await token(lk.cookie);
  const headerSocket = (tok) => {
    const b64 = Buffer.from(tok).toString("base64").replace(/=/g, "");
    const ws = new WebSocket(`${WS}&takeover=true`, ["phoenix", `base64url.bearer.phx.${b64}`]);
    const c = { ws, closedAt: null };
    c.result = new Promise((res) => {
      ws.onopen = () => res("open");
      ws.onerror = () => res("refused");
    });
    ws.addEventListener("close", () => (c.closedAt = performance.now()));
    return c;
  };
  const h = headerSocket(lkTok);
  (await h.result) === "open"
    ? ok(`a token in the protocol header connects (protocol "${h.ws.protocol}")`)
    : fail("a header token was refused");

  const tLogout = performance.now();
  await fetch(`${BASE}/api/logout`, { method: "POST", headers: { cookie: lk.cookie } });
  await sleep(500);
  h.closedAt
    ? ok(`sign-out closed the open socket (${(h.closedAt - tLogout).toFixed(0)} ms)`)
    : fail("the socket stayed open after sign-out");
  (await headerSocket(lkTok).result) === "refused"
    ? ok("the old token is refused after sign-out (header)")
    : fail("the old token still connects after sign-out");
  const viaUrl = client(lkTok, { takeover: "true" });
  const urlRes = await Promise.race([
    viaUrl.opened.then(() => "open"),
    new Promise((r) => (viaUrl.ws.onerror = () => r("refused"))),
  ]);
  urlRes === "refused" ? ok("...and in the URL") : fail("the old token still connects via the URL");
  const lkMe = await (await fetch(`${BASE}/api/me`, { headers: { cookie: lk.cookie } })).json();
  lkMe.user === null ? ok("the old session cookie is signed out too") : fail("the old cookie still works");

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL NEWEST-WINS CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("crashed:", e);
  process.exit(1);
});
