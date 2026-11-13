defmodule Hoodride.Limits do
  @moduledoc """
  EVERY limit the app sets, in one place (owner, 2026-11-12: "put em all
  in same place" — so "find me the limits" is reading this file, or
  `mix hoodride.limits`). The code reads its numbers from here, so this
  list is always what the app really does; Hoodride.LimitsTest fails when a
  limit-like number is defined anywhere else, and checks the app's own
  copies (priv/static/chatlist.js, errors.js) against these.

  Each entry: `{group, name, value, what it limits and why}`. A `name` is
  also a function: `Hoodride.Limits.message_chars()` → 2000.

  Rate budgets (`*_budget`, `sign_in_failures`) are a refill rate and a
  burst — `per_minute`, `burst` (RateBudget's token bucket). They can be
  switched off for one environment with `config :hoodride, :http_budget,
  nil` (dev: the load "monster" is one address; tests that need them on
  turn them on) — read through `budget/1`, never `Application.get_env`.

  Not here: internal tuning that limits nobody (how often the sweeper runs,
  map batching, recount pauses) — LimitsTest lists those, each with why.
  """

  @second 1_000
  @minute 60 * @second
  @hour 60 * @minute
  @day 24 * @hour

  @limits [
    # ---------- chat messages ----------
    {:messages, :message_chars, 2_000,
     "Characters in one chat message, as the server checks it. The app warns at 500 (app_message_chars); this looser backstop exists because phones and the server can count some letters differently (a Hindi conjunct is 1 now, 4 under older rules)."},
    {:messages, :message_bytes, 20_480,
     "Bytes in one chat message: 500 of the heaviest real characters (a 35-byte emoji: 17.5 KB) with room to spare; stops thousands of invisible marks stacked on one letter."},
    {:messages, :message_stacked_marks, 30,
     "Accent marks in a row on one letter; more is no language (Unicode's Stream-Safe Text Format)."},
    {:messages, :app_message_chars, 500,
     "Where the app's message box stops you (a warning from 400, Send refused over). priv/static/chatlist.js MAX_CHARS — checked against this by a test."},
    {:messages, :messages_per_minute, 30, "Chat messages one person may send a minute, in all."},
    {:messages, :pair_messages_per_minute, 15,
     "Chat messages one person may send one other person a minute."},
    {:messages, :new_chats_per_hour, 20,
     "People one person may contact first (a message or a ride request to someone new) an hour."},
    {:messages, :message_id_keep_ms, 10 * @minute,
     "How long a sent message's id is remembered, so a resend after a lost reply isn't a duplicate."},

    # ---------- chats ----------
    {:chats, :chat_history, 20,
     "Messages kept per conversation (older ones drop off); also the most an unread count can show. Delivery is never capped — only what the server remembers (owner, 2026-11-12: 50 → 20; ride chats are short)."},
    {:chats, :chat_history_bytes, 65_536,
     "Bytes of message text kept per conversation, oldest dropped first, the newest always kept (owner, 2026-11-12: 64 KB, so 20 long messages fit in any language; about 50 accounts could otherwise hold 1 GB)."},
    {:chats, :chats_started_open, 10,
     "Open chats one person STARTED (by a first message): the next is refused until one ends. Chats others start, and a ride's own chat, never count (owner, 2026-11-12)."},
    {:chats, :chat_preview_chars, 100, "Characters of a message shown as a chat's preview."},
    {:chats, :chat_preview_bytes, 400, "Bytes of that preview."},

    # ---------- ride requests and rides ----------
    {:rides, :request_cooldown_ms, @minute,
     "After a request to a driver ends (declined, cancelled, expired), how long before the same rider may ask that driver again."},
    {:rides, :request_expiry_ms, 5 * @minute, "A ride request nobody answered ends after this."},
    {:rides, :ride_abandoned_ms, 30 * @minute,
     "A ride with no activity from either person for this long ends as abandoned (owner, 2026-11-10: kept)."},

    # ---------- the map ----------
    {:map, :map_cells_watched, 120, "Map areas (hexes) one screen may watch at once."},
    {:map, :cell_bytes, 24, "Bytes in one map area's name (a hex id)."},
    {:map, :presence_grace_ms, 5 * @minute,
     "How long someone who left stays (car, ✋, chats) before the sweeper removes them."},
    {:map, :position_stale_ms, 3 * @minute,
     "A car whose position stopped arriving while connected is removed after this (a stuck app)."},

    # ---------- actions on the live connection (per account) ----------
    {:live, :events_per_minute, 120,
     "Actions a minute on the user connection (position updates, ✋, requests, messages…)."},
    {:live, :events_burst, 30, "Of those, how many may come in one burst."},
    {:live, :sync_per_minute, 60, "Map re-syncs (and names looked up) a minute."},
    {:live, :sync_burst, 20, "…at once — also the most names one lookup may ask for."},
    {:live, :ride_per_minute, 120, "Actions a minute on a ride (positions, pin, end)."},
    {:live, :ride_burst, 30, "Of those ride actions, how many may come in one burst."},
    {:live, :joins_per_minute, 30, "Channel joins a minute."},
    {:live, :joins_burst, 30, "Of those joins, how many may come in one burst."},
    {:live, :connects_per_minute, 20, "Live connections opened a minute."},
    {:live, :connects_burst, 20, "Of those connections, how many may open in one burst."},

    # ---------- signing in ----------
    {:sign_in, :sign_in_valid_ms, 30 * @day,
     "A sign-in lasts this long from its last renewal (30 days without opening the app: signed out)."},
    {:sign_in, :sign_in_renew_after_ms, 7 * @day,
     "A sign-in this old is renewed when the app is used."},
    {:sign_in, :sign_in_max_age_ms, 365 * @day,
     "At most this long from the real Google sign-in, however often renewed."},
    {:sign_in, :sign_ins_per_account, 10,
     "Sign-ins one account may hold (devices × renewals); over it the oldest-replaced go first (the key fix, 2026-11-12)."},
    {:sign_in, :lost_reply_ms, @minute,
     "A renewal whose new sign-in went unused this long may renew again (its reply was lost on bad signal)."},
    {:sign_in, :socket_pass_ms, @day, "A live-connection pass is accepted for this long."},
    {:sign_in, :session_stamp_keep_ms, @day,
     "Which device was chosen last is kept this long after an account's last connection."},
    {:sign_in, :language_cookie_ms, 365 * @day,
     "A chosen language is remembered this long (a cookie)."},

    # ---------- per-address and per-account rate budgets (budget/1) ----------
    {:budgets, :http_budget, [per_minute: 60, burst: 120],
     "Requests a minute to the app's server (per account when signed in, else per address; IPv6 per /64)."},
    {:budgets, :avatar_budget, [per_minute: 120, burst: 40],
     "Profile photos fetched a minute (their own budget: a busy pile list can't use up the rest)."},
    {:budgets, :chat_budget, [per_minute: 60, burst: 60], "Chats opened a minute."},
    {:budgets, :ws_budget, [per_minute: 60, burst: 120],
     "Live-connection handshakes a minute per address, before the sign-in is even checked."},
    {:budgets, :sign_in_budget, [per_minute: 30, burst: 29], "Sign-in starts a minute."},
    {:budgets, :sign_in_failures, [max: 30, window_ms: 3 * @minute, block_ms: @hour],
     "Sign-in codes Google refuses: this many in the window blocks the address for block_ms (GitLab's numbers)."},
    {:budgets, :refresh_budget, [per_minute: 0.5, burst: 4],
     "\"Refresh from Google\" per account: 5 in a row, then one every 2 minutes."},

    # ---------- sizes ----------
    {:sizes, :ws_frame_bytes, 65_536, "Bytes in one message on the live connection."},
    {:sizes, :http_body_bytes, 64_000, "Bytes in one request's body."},
    {:sizes, :car_text_chars, 24, "Characters in each of a car's make, model and color."},
    {:sizes, :avatar_bytes, 512_000, "A profile photo fetched from Google is refused over this."},
    {:sizes, :avatar_fetch_ms, 3 * @second, "Waiting for that photo at most this long."},
    {:sizes, :avatar_px, 128, "Profile photos are kept this size (pixels)."},

    # ---------- the app's error reports (no names, no positions) ----------
    {:errors, :error_report_chars, 200, "Characters of an error's message logged."},
    {:errors, :error_scrub_chars, 1_000,
     "At most this much of a report is looked at (abuse review, 2026-11-12: all 64 KB took 18 s of CPU)."},
    {:errors, :error_reports_per_minute, 100,
     "Error reports logged a minute from everyone together; the rest of the minute dropped."},
    {:errors, :app_error_reports_per_minute, 5,
     "Error reports one app sends a minute. priv/static/errors.js PER_MINUTE — checked by a test."},
    {:errors, :app_error_reports_per_session, 30,
     "…and per session. errors.js PER_SESSION — checked by a test."},
    {:errors, :csp_report_bytes, 64_000, "Bytes in one browser security report read."}
  ]

  for {_group, name, value, _note} <- @limits do
    @doc false
    def unquote(name)(), do: unquote(Macro.escape(value))
  end

  @doc "Every limit: `{group, name, value, note}`, in this file's order."
  def all, do: @limits

  @budgets for {:budgets, name, value, _} <- @limits, do: {name, value}

  @doc """
  A rate budget as this environment runs it: its value here, unless the
  environment sets its own (`nil` = off — dev, the load test, tests that
  don't exercise it). Raises for a name that isn't a budget.
  """
  def budget(name) do
    case Application.fetch_env(:hoodride, name) do
      {:ok, own} -> own
      :error -> Keyword.fetch!(@budgets, name)
    end
  end

  @doc false
  def budget_names, do: Keyword.keys(@budgets)
end
