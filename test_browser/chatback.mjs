// ‹ Back and drafts (owner, 2026-11-07): ‹ always opens the chat list —
// it used to drop the chat you'd just opened (nothing written yet) and jump
// straight into the one other chat. A chat opened from the map stays in the
// list while the window is open; ✕ drops it unless something's typed in it.
// What's typed stays with its chat ("Draft" in the list, as WhatsApp).
// Both directions: a driver writing to a ✋, a rider writing to a car.
import { journey, step, check, server } from "./cdp.mjs";
import { DRAWN, goOnline, sees, openChatWith, typeText, box, send, chatOpenWith, closeChatPanel, bannerIs, YELLOW } from "./app.mjs";

// the chat window: open? the list or a chat — whose?
const where = (p) =>
  p.eval(`(() => document.getElementById("chat").classList.contains("hidden") ? "closed" : state.chatView === "list" ? "list" : "chat:" + state.chatPeer.name)()`);
// the list's rows, top to bottom: name, unread number, "Draft"?, the line
const rows = (p) =>
  p.eval(`[...document.querySelectorAll("#chat-messages .chat-item")].map((r) => ({
    name: r.querySelector("strong").textContent,
    unread: r.querySelector(".unread-dot")?.textContent ?? null,
    draft: r.querySelector(".chat-draft")?.textContent ?? null,
    line: r.querySelector(".chat-item-info .muted").textContent,
  }))`);
const row = async (p, name) => (await rows(p)).find((r) => r.name === name) || null;
const tapRow = (p, name) =>
  p.eval(`([...document.querySelectorAll("#chat-messages .chat-item")].find((r) => r.querySelector("strong").textContent === ${JSON.stringify(name)}).click(), true)`);
const backBadge = (p) =>
  p.eval(`(() => { const b = document.getElementById("chat-back"), c = document.getElementById("chat-back-count"); return b.classList.contains("hidden") ? "no ‹" : c.classList.contains("hidden") ? "‹" : "‹ " + c.textContent; })()`);
const has = (p, id) => p.eval(`realPeersById.has(${id}) && chats.has(realPeersById.get(${id}))`);

await journey("chatback: ‹ opens the list; drafts stay with their chat", async (browser) => {
  step("Dora and Ed (drivers, online), Ray (✋ up), Sam (rider) sign in");
  const dora = await browser.person("BT-Dora");
  const ed = await browser.person("BT-Ed");
  const ray = await browser.person("BT-Ray");
  const sam = await browser.person("BT-Sam");
  await goOnline(dora, { color: "Gray", make: "Honda", model: "Civic" });
  await goOnline(ed, { color: "Red", make: "Kia", model: "Soul" });
  const [doraId, edId, rayId, samId] = [await dora.id(), await ed.id(), await ray.id(), await sam.id()];
  await ray.click("btn-hand");
  await ray.waitFor("state.handRaised", "Ray's ✋ up");
  await sees(dora, rayId, "(Ray's ✋)");
  await sees(sam, doraId);
  await sees(sam, edId);

  step("Ray's ✋ on Dora's map and Dora's car on Sam's: the same yellow edge (owner, 2026-11-08)");
  // (the marker is drawn a moment after the person is on the map: waited for)
  const edge = (p, type, id) =>
    p.waitFor(`(() => { for (const pm of pileMarkers.values()) if (pm.type === ${JSON.stringify(type)} && pm.ids.includes(${id})) return getComputedStyle(pm.el).borderTopColor; return null; })()`, `${p.name}: #${id}'s marker drawn`);
  check((await edge(dora, "hand", rayId)) === YELLOW, "the ✋ has the yellow edge", await edge(dora, "hand", rayId));
  check((await edge(sam, "driver", doraId)) === YELLOW, "the car has the yellow edge", await edge(sam, "driver", doraId));

  step("driver: Dora taps Ray's ✋ → Message; Sam writes to her meanwhile: ‹ 1");
  await openChatWith(dora, rayId, "hand");
  await openChatWith(sam, doraId);
  await typeText(sam, "hi Dora");
  await send(sam);
  await dora.waitFor(`realPeersById.has(${samId}) && chats.has(realPeersById.get(${samId}))`, "Dora has Sam's message");
  check((await where(dora)) === "chat:BT-Ray", "still in Ray's chat", await where(dora));
  check((await backBadge(dora)) === "‹ 1", "‹ 1", await backBadge(dora));

  step("‹ → the list (not Sam's chat): Ray, nothing written yet, and Sam, 1 unread");
  await dora.click("chat-back");
  check((await where(dora)) === "list", "the list", await where(dora));
  check(JSON.stringify(await row(dora, "BT-Ray")) === JSON.stringify({ name: "BT-Ray", unread: null, draft: null, line: "" }), "Ray's empty chat is in it", await row(dora, "BT-Ray"));
  check((await row(dora, "BT-Sam"))?.unread === "1", "Sam's: 1 unread", await row(dora, "BT-Sam"));

  step("back into Ray's chat from the list; typed, not sent — it stays with Ray");
  await tapRow(dora, "BT-Ray");
  check((await where(dora)) === "chat:BT-Ray", "Ray's chat", await where(dora));
  await typeText(dora, "  need a ride?  ");
  await dora.click("chat-back");
  check(JSON.stringify(await row(dora, "BT-Ray")) === JSON.stringify({ name: "BT-Ray", unread: null, draft: "Draft", line: "Draft need a ride?" }), "the list: Ray's row says Draft", await row(dora, "BT-Ray"));
  await tapRow(dora, "BT-Sam");
  check((await box(dora)) === "", "Sam's box is empty (never Ray's text)", await box(dora));
  await dora.click("chat-back");
  await tapRow(dora, "BT-Ray");
  check((await box(dora)) === "  need a ride?  ", "Ray's text is back in the box", await box(dora));

  step("✕ with a draft: Ray's chat stays; 💬 Chat → the list, Draft");
  await closeChatPanel(dora);
  check(await has(dora, rayId), "Ray's chat kept");
  await dora.click("btn-chat");
  check((await where(dora)) === "list", "💬 Chat: the list (two chats)", await where(dora));
  check((await row(dora, "BT-Ray"))?.draft === "Draft", "still Draft", await row(dora, "BT-Ray"));

  step("the text cleared, then ✕: Ray's chat goes (nothing in it)");
  await tapRow(dora, "BT-Ray");
  await typeText(dora, "");
  await dora.click("chat-back");
  check((await row(dora, "BT-Ray"))?.draft === null, "no Draft once the text is gone", await row(dora, "BT-Ray"));
  check(await has(dora, rayId), "but still in the list while the window's open");
  await closeChatPanel(dora);
  check(!(await has(dora, rayId)), "✕: Ray's empty chat dropped");

  step("rider: Sam taps Ed's car → Message; Dora answers Sam meanwhile: ‹ 1");
  await openChatWith(sam, edId);
  await dora.eval(`openChat(realPeersById.get(${samId})), true`);
  await typeText(dora, "hi Sam");
  await send(dora);
  await sam.waitFor(`chatFor(realPeersById.get(${doraId})).msgs.some((m) => m.text === "hi Sam")`, "Sam has Dora's answer");
  check((await where(sam)) === "chat:BT-Ed", "still in Ed's chat", await where(sam));
  check((await backBadge(sam)) === "‹ 1", "‹ 1", await backBadge(sam));

  step("‹ → the list: Ed, nothing written yet, and Dora, 1 unread; ✕ drops Ed's");
  await sam.click("chat-back");
  check((await where(sam)) === "list", "the list (not Dora's chat)", await where(sam));
  check(JSON.stringify(await row(sam, "BT-Ed")) === JSON.stringify({ name: "BT-Ed", unread: null, draft: null, line: "" }), "Ed's empty chat is in it", await row(sam, "BT-Ed"));
  check((await row(sam, "BT-Dora"))?.unread === "1", "Dora's: 1 unread", await row(sam, "BT-Dora"));
  await tapRow(sam, "BT-Ed");
  check((await where(sam)) === "chat:BT-Ed", "back in Ed's chat", await where(sam));

  // a reload for an update waits while anything's typed — in the open chat
  // or another (HoodUpdate.isBusy: Sam is a rider with no ✋, nothing else)
  step("a draft in Ed's chat, Dora's open with an empty box: an update still waits");
  const busy = () => sam.eval(`HoodUpdate.isBusy({ mode: state.mode, online: state.online, handRaised: state.handRaised, ride: state.ride, draft: allDrafts() })`);
  check(!(await busy()), "nothing typed: not busy");
  await typeText(sam, "for Ed");
  await sam.click("chat-back");
  await tapRow(sam, "BT-Dora");
  check((await box(sam)) === "", "Dora's box is empty", await box(sam));
  check(await busy(), "Ed's draft: busy");
  await sam.click("chat-back");
  await tapRow(sam, "BT-Ed");
  await typeText(sam, "");
  await closeChatPanel(sam);
  check(!(await has(sam, edId)), "✕: Ed's empty chat dropped");
  check(await has(sam, doraId), "Dora's stays");
  check((await chatOpenWith(sam)) === null, "the window closed");

  // 20 new chats an hour (Hoodride.Throttle): the server's refusal, as the
  // app shows it — the server side: abuse_limits_test.exs
  step("Sam has started 20 new chats this hour: a 21st (Ed) is refused and says so, the text kept; Dora (already talking) still works");
  await server(`cold_used_up ${samId}`); // (throws if the server couldn't)
  await openChatWith(sam, edId);
  await typeText(sam, "are you free?");
  await send(sam);
  await bannerIs(sam, "You've started a lot of new chats — try again later");
  check(!(await sam.eval(`chatFor(realPeersById.get(${edId})).msgs.some((m) => m.mine)`)), "not shown as sent");
  check((await box(sam)) === "are you free?", "the text is back in the box", await box(sam));
  check((await where(sam)) === "chat:BT-Ed", "Ed's chat stays open", await where(sam));
  await sam.click("chat-back");
  await tapRow(sam, "BT-Dora");
  await typeText(sam, "still on?");
  await send(sam);
  await dora.waitFor(`chatFor(realPeersById.get(${samId})).msgs.some((m) => m.text === "still on?")`, "Dora gets it: someone you already talk to costs nothing");

  // the map's messages, from a DRIVER's side (owner, 2026-11-10): an update
  // for a cell Dora doesn't watch takes Ray's stale ✋ off (the server folded
  // his "left" into it); a ✋ "left" takes it off; a car's "left" on Sam's
  // map takes that car off — each message, each type, through the app's
  // real handlers. Sent and read in one go (a real update can't slip in).
  step("Dora's map (driver): a ✋ update elsewhere takes Ray's stale ✋ off; a ✋ 'left' too; Sam's map: a car's 'left' takes Ed's off");
  await closeChatPanel(dora);
  await sees(dora, rayId, "(Ray's ✋, drawn)");
  const inject = (p, event, payload, id) =>
    p.eval(`new Promise((ok) => {
      worldChannel.trigger("batch", { items: [[${JSON.stringify(event)}, ${JSON.stringify(payload)}]] });
      const gone = !realEntries.has(${id});
      requestAnimationFrame(() => requestAnimationFrame(() => ok({ gone, drawn: ${DRAWN(id)} })));
    })`);
  const far = await dora.eval(`h3.latLngToCell(state.me.lat + 0.3, state.me.lng, H3_RES)`);
  let r = await inject(dora, "hand_update", { id: rayId, cell: far, spot: far }, rayId);
  check(r.gone && !r.drawn, "a ✋ update for a cell Dora doesn't watch: Ray's stale ✋ gone", r);
  // (the server still has it here: a fresh look brings it back)
  const v = await dora.eval(`(() => { const c = map.getCenter(); return { lng: c.lng, lat: c.lat, zoom: map.getZoom() }; })()`);
  await dora.eval(`map.jumpTo({ zoom: 11 }), true`);
  await dora.waitFor(`worldSync.settled() && !map.isMoving()`, "Dora zoomed out");
  await dora.eval(`map.jumpTo({ center: [${v.lng}, ${v.lat}], zoom: ${v.zoom} }), true`);
  await sees(dora, rayId, "(Ray's ✋ back)");
  r = await inject(dora, "hand_left", { id: rayId }, rayId);
  check(r.gone && !r.drawn, "a ✋ 'left': Ray's ✋ gone", r);
  await sees(sam, edId, "(Ed's car, drawn)");
  r = await inject(sam, "driver_left", { id: edId }, edId);
  check(r.gone && !r.drawn, "a car's 'left': Ed's car gone from Sam's map", r);
  // and a car's message never touches a ✋ (nor the reverse): Sam's map
  // has no ✋ of Ray's to touch — Dora's map, Dora's own ✋-less car layer
  await dora.eval(`map.jumpTo({ zoom: 11 }), true`);
  await dora.waitFor(`worldSync.settled() && !map.isMoving()`, "Dora zoomed out");
  await dora.eval(`map.jumpTo({ center: [${v.lng}, ${v.lat}], zoom: ${v.zoom} }), true`);
  await sees(dora, rayId, "(Ray's ✋ back again)");
  r = await inject(dora, "driver_left", { id: rayId }, rayId);
  check(!r.gone && r.drawn, "a CAR's 'left' with Ray's id: his ✋ stays", r);
});
