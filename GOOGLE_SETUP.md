# Google sign-in setup

About 10 minutes, free, done once. Hood Ride signs people in with Google;
your copy needs its own keys, because only you can own the Google Cloud
project behind them. (Hood Ride never asks Google for anyone's email
address: only their name and photo.)

Below, `YOUR-DOMAIN` is your site's address, like `rides.example.com`.

## 1. Create the keys

1. Go to **[console.cloud.google.com](https://console.cloud.google.com/)** and
   sign in with your Google account.
2. Top bar → the project picker → **New Project** → give it your app's
   name → **Create**. Make sure the new project is selected.
3. Left menu → **APIs & Services → OAuth consent screen** (on newer screens:
   **Google Auth Platform → Branding** and **Audience**):
   - User type: **External**
   - App name: your app's name. Support email: an address on your Google
     account (people see it on Google's sign-in screen).
   - App home page: `https://YOUR-DOMAIN`
   - Privacy policy: `https://YOUR-DOMAIN/privacy`. Google wants it on the
     same domain, linked from your home page (Hood Ride's sign-in screen
     does) and here, the same address in both.
   - Terms of service (optional): `https://YOUR-DOMAIN/terms`
   - Scopes: nothing to add. Hood Ride only uses the basic sign-in scopes
     (`openid` and `profile`).
   - Test users: add your own Gmail address (see step 3 below).
4. Left menu → **APIs & Services → Credentials** → **+ Create credentials**
   → **OAuth client ID**:
   - Application type: **Web application**
   - **Authorized redirect URIs**, add exactly:
     ```
     https://YOUR-DOMAIN/auth/google/callback
     ```
     (and, to try real Google on your own computer,
     `http://localhost:4000/auth/google/callback`)
   - Nothing is needed under "Authorized JavaScript origins": Hood Ride
     signs in on the server, not in the browser.
   - **Create**, then copy the **Client ID** and **Client secret**.
5. Put them in your server's settings, `/etc/hoodride/env`:
   ```
   GOOGLE_CLIENT_ID=…
   GOOGLE_CLIENT_SECRET=…
   ```
   then `sudo systemctl restart hoodride`. Keep the secret private: never
   put it in the code or in git.

## 2. If sign-in fails

**"Error 400: redirect_uri_mismatch"** (or "Invalid redirect_uri") is the
most common problem. The address Hood Ride sends must match the one in
step 4 **exactly**:

- `https`, not `http`;
- the same domain as `PHX_HOST` in `/etc/hoodride/env`, with nothing extra
  (no `www.` unless you use it, no `/` at the end);
- the path is exactly `/auth/google/callback`.

Changes in Google's console can take a few minutes to apply.

**"Access blocked: this app's request is invalid"**, or only some people
can sign in: see "Who can sign in" below.

## 3. Who can sign in

- **Testing (where every new project starts):** only the Google accounts
  listed under **Test users** can sign in, up to 100. Good for trying it
  with friends: add their Gmail addresses there.
- **Anyone:** **Audience → Publish app**. Any Google account can then sign
  in (Hood Ride has no sign-up limit of its own). To show your app's name
  and logo on Google's screen, Google's **brand verification** asks for a
  verified home page domain (Google Search Console) and your privacy policy.
  After publishing, try signing in with an account that is NOT a test user.

## 4. Real Google on your own computer (optional)

On `localhost`, the **Continue with Google** button signs you in as a test
user instead, so you don't need keys to try Hood Ride. To try real Google
there:

1. Add `http://localhost:4000/auth/google/callback` to the redirect URIs
   (step 4 above).
2. Start the app with the keys:
   - PowerShell: `$env:GOOGLE_CLIENT_ID = "…"; $env:GOOGLE_CLIENT_SECRET = "…"; mix phx.server`
   - macOS/Linux: `GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… mix phx.server`
3. Open **http://localhost:4000/auth/google** directly.

## Facebook sign-in (optional)

Hood Ride can also offer Facebook sign-in; its button appears only once its
keys are set. (hoodride.app doesn't use it.)

1. A free Meta developer account → **developers.facebook.com → My Apps →
   Create app** → use case "Authenticate and request data from users with
   Facebook Login".
2. **Facebook Login → Settings** → Valid OAuth Redirect URIs:
   `https://YOUR-DOMAIN/auth/facebook/callback`
3. **App settings → Basic:** Privacy Policy URL `https://YOUR-DOMAIN/privacy`;
   **User data deletion → Data deletion instructions URL**
   `https://YOUR-DOMAIN/privacy#delete-account`; an app icon and category.
   Copy the **App ID** and **App Secret**.
4. Permissions: only `public_profile` (no App Review needed). Never `email`.
5. In `/etc/hoodride/env`: `FACEBOOK_APP_ID=…` and `FACEBOOK_APP_SECRET=…`,
   then `sudo systemctl restart hoodride`.
6. Switch the app from **Development** to **Live** (until then, only people
   with a role on the app can sign in).

Built to Facebook's documentation but not yet tried against real Facebook:
sign in once yourself before inviting anyone.

## Turnstile: a bot check on sign-in (optional, recommended)

Cloudflare Turnstile tells a person from a script when someone taps
**Continue with Google** (or Facebook). For nearly everyone it's invisible;
now and then it shows one "Verify you are human" checkbox. Scripts can't
start sign-ins in bulk, so they can't make your server send Google made-up
codes, or crowd out real people on a shared network (a café, a campus). It's
free, with no limit on checks (Cloudflare's plans page).

It's **off until both keys are set**, so you can deploy first and add the
keys whenever you like. Signing in works exactly as before until then.

**Before you switch it on:** add a line to your privacy policy, for example:
"The sign-in screen uses Cloudflare Turnstile to tell people from automated
programs. Cloudflare processes technical information about your browser
and connection for this check, under its own privacy policy." (Have your
own wording reviewed; the privacy page exists in every language you offer.)

1. **Cloudflare dashboard → Turnstile → Add widget.**
   - Widget name: anything, e.g. `Hood Ride sign-in`.
   - Hostnames: your domain (e.g. `hoodride.app`).
   - Widget mode: **Managed** (invisible unless Cloudflare wants a click).
   - Pre-clearance: **No**.
   - Create. Copy the **Site Key** and the **Secret Key**.
2. **On the server**, add both to the settings file (it's root's alone, so
   edit it with sudo):

   ```bash
   sudoedit /etc/hoodride/env
   ```

   ```
   TURNSTILE_SITE_KEY=0x4AAAA…   # public: it's put on the page
   TURNSTILE_SECRET_KEY=0x4AAAA… # the server's only: never share it
   ```

3. **Restart:** `sudo systemctl restart hoodride` (or deploy).
4. **Check it's on:** open your site signed out. The page's source has
   `<meta name="hoodride-turnstile" …>`, and tapping **Continue with Google**
   still takes you to Google (after a second's check). Typing
   `https://YOUR-DOMAIN/auth/google` straight into the address bar now
   lands back on the sign-in screen: a start needs a passed check.

**Turning it off:** remove the two lines and restart.

**If something's wrong:**

- *"Couldn't check your browser — allow challenges.cloudflare.com…"*: that
  browser blocks Cloudflare's check (an ad blocker, a strict privacy
  setting). Allowing `challenges.cloudflare.com`, or another browser, fixes it.
- *Sign-in goes back to the sign-in screen every time*: the hostname in the
  widget doesn't match your site (step 1), or the secret key is wrong. The
  server's log says nothing in that case (a failed check isn't an error);
  check both keys.
- *Cloudflare's check itself is down*: sign-in is let through, and the log
  says `turnstile: Cloudflare's check unavailable` (`deploy/errors.sh`
  shows it). It never locks people out.

**For tests:** Cloudflare publishes test keys: site key
`1x00000000000000000000AA` with secret `1x0000000000000000000000000000000AA`
always pass; `2x00000000000000000000AB` always fails. The app's own tests
(`test/hoodride_web/turnstile_test.exs`, `test_browser/turnstile.mjs`) use
them with Cloudflare's answer stood in, so they never leave the machine.

**Where it lives:** `lib/hoodride_web/turnstile.ex` (the server's check),
`priv/static/turnstile.js` (the page's), ARCHITECTURE.md "Sign-in".
