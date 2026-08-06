# Medicine Ledger

A hospital medicine stock & dispensing tracker with its **own** username/email/password
login — no Supabase, no third-party auth service, no API keys to configure. Everything
lives in this one project: frontend + backend + database, together.

## Run it

```bash
npm install
node server.js
```

Then open **http://localhost:3000** in your browser. `npm install` now pulls in one
package — `web-push` (see "Push notifications" below for why). Everything else is still
built-in Node, same as before.

First time you open it: click **Sign up**, enter a hospital name + username + email +
password. That's your login from then on — share those same details with your staff so
everyone logs in with the same account, or create separate accounts per person (each
signup gets its own completely separate set of medicines/data).

## Push notifications (real notification-bar popups on the phone)

When a medicine goes low/empty or is expiring within 30 days, the app can send an actual
push notification to your phone's notification bar — the same kind of popup as WhatsApp
or email give you, working even if the app isn't open.

**To turn it on:** open the app, look in the sidebar for **"Enable notifications"**,
tap it, and allow notifications when your browser asks. A **"Send test notification"**
button appears once you're subscribed — use that to confirm delivery immediately,
instead of waiting for a real stock alert.

**How it works technically** (Web Push, the open web standard — not Firebase, not a
third-party notification service): a background check runs every 6 hours on the server,
looks at every hospital's stock and expiry dates, and pushes a notification if there's
something to flag. It won't repeat the same alert more than once a day.

**Important limitations, stated plainly:**
- **Requires HTTPS to work on a real phone.** `localhost` is exempted for testing, but
  once deployed, your hosting URL must be `https://` — Render/Railway give you this
  automatically, so this isn't extra work, just something to know.
- **This does NOT work through the Android Studio WebView app** built earlier in this
  project. Android's WebView doesn't support background push the way a real installed
  browser app does. For real notification-bar delivery on Android, use the website
  directly in Chrome and tap **"Add to Home Screen"** (Chrome's menu → Install app) — it
  then behaves like an installed app, icon and all, *and* push notifications work
  correctly. If you specifically need it inside the native Android Studio app instead,
  that requires wiring in Firebase Cloud Messaging natively — a separate, bigger task.
- **iPhone note:** iOS supports this too, but only once the site is added to the Home
  Screen (Safari → Share → Add to Home Screen) — push doesn't work in a regular Safari
  tab on iOS.
- **I tested the server-side logic thoroughly** (subscribing, unsubscribing, the alert
  calculation, dead-subscription cleanup, the scheduled checker actually firing on its
  own timer) — all confirmed working. What I could **not** test myself is a real push
  arriving on a real phone, since that requires reaching Google/Apple/Mozilla's push
  servers over the internet, which I don't have access to in my sandbox. The "Send test
  notification" button is exactly for you to confirm that last mile once it's deployed.
- If you ever move hosting or restart with a fresh `vapid.json`, everyone who enabled
  notifications will need to tap "Enable notifications" again — the keys changing
  invalidates old subscriptions. Treat `vapid.json` like a secret; don't delete or
  regenerate it casually once people are subscribed.

## How it's built, and why

- **Backend (`server.js`)** — one file, one npm dependency (`web-push`). Password
  hashing uses Node's built-in `scrypt` (as secure as bcrypt, no extra package needed).
  Login sessions use a hand-written JWT signed with Node's built-in `crypto` module —
  also no extra package. The one exception is `web-push`: real push notification
  delivery requires a specific encryption scheme (ECDH + HKDF + AES-GCM per RFC 8291) —
  the kind of cryptography that's genuinely risky to hand-roll without extensive testing
  against real push servers, so this one uses the standard, widely-used library instead
  of reinventing it.
- **Alert logic (`alerts.js`)** — a small, dependency-free file that decides what counts
  as "low stock" or "expiring soon." Pure logic, no I/O, easy to test on its own (and I
  did — every case from a fresh, well-stocked medicine to an empty/expired one).
- **Data storage (`data.json`)** — a plain JSON file on disk, created automatically the
  first time you run the server. Good for one hospital's worth of day-to-day use.
  **This is the one thing worth knowing:** a JSON file isn't built for many people
  hammering it with writes at the exact same second — if that becomes your situation
  (a large hospital, dozens of staff logging doses simultaneously), the natural next
  step is swapping this for a real database (Postgres/MySQL/SQLite-with-a-real-driver).
  The API layer (the `/api/...` routes) wouldn't need to change at all if you do that
  later — only the inside of `readDB()`/`writeDB()` in `server.js`.
- **Frontend (`public/index.html`)** — the same dashboard/stock/monthly-sheet app from
  before, unchanged except the login screen now talks to this server's `/api/login` and
  `/api/signup` instead of Supabase.

## Staying logged in

Once you log in, a token is stored in the browser and sent with every request. It's
valid for 30 days and silently keeps you logged in across closing the browser/app,
restarting your phone, etc. Logging out (or clearing the browser's site data) is what
clears it. No emails, no confirmation links, no rate limits from a third-party service —
this was the whole point of moving away from Supabase.

## Deploying it — step by step (so it's reachable from anywhere, not just your laptop)

This needs real server hosting, not Netlify/GitHub Pages (those only serve static files
— this app has a backend process that needs to keep running). We'll use **Render.com** —
free, and built exactly for "here's my Node app, run it."

**1. Put your code on GitHub** (skip if it's already there)
```bash
cd medledger-app
git init
git add .
git commit -m "Medicine Ledger"
```
Create an empty repo at **github.com/new**, then run the two commands it shows you
(`git remote add origin ...` and `git push -u origin main`).

**2. Create a Render account**
Go to **render.com** → sign up (free, no credit card needed for this).

**3. Create the web service**
- Click **New → Web Service**
- Connect your GitHub account, pick the repo you just pushed
- Fill in:
  - **Build command:** `npm install`
  - **Start command:** `node server.js`
- Leave everything else as default

**4. Add one setting before you launch** — this one matters
Scroll to **Environment Variables** → **Add Environment Variable**:
- Key: `JWT_SECRET`
- Value: a long random string. Easiest way to get one — run this on your own computer
  and copy what it prints:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
Without this, everyone gets logged out every time the server restarts — this one
variable is what makes logins actually stick.

**5. Click "Create Web Service"**
Render builds it (takes a couple of minutes the first time) and gives you a live link,
something like `https://medicine-ledger-xyz.onrender.com`. Open it — you should see the
same login screen you tested locally.

**That's it — it's live.** Anyone with that link can sign up and log in from anywhere.

**A couple of things worth knowing about the free tier:**
- It may "sleep" after periods of no traffic and take ~30 seconds to wake up on the next
  visit — totally fine for how a hospital would actually use this, just don't be
  surprised by a slow first load.
- The free tier's disk isn't guaranteed to survive every redeploy, which matters because
  `data.json` and `vapid.json` live on disk. This is fine while you're testing; if this
  becomes your real, permanent system, that's the point to move storage to a proper
  database (the README section above explains where that change would go).

## Security notes, plainly stated

- Passwords are never stored in plain text — only a salted scrypt hash
- The login token (JWT) is only ever sent over the connection you're already using; there's no separate secret floating around in the frontend code (unlike the Supabase version, which had an API key baked into the HTML)
- This is still **HTTP by default locally** — when you deploy it for real, make sure your host serves it over **HTTPS** (Render/Railway do this automatically) so passwords aren't sent in plain text over the network

## Building an Android app

Once it's deployed and working in a browser (the steps above), see **`android/README.md`**
for turning it into a real, installable `.apk` you can put on a phone — Android Studio,
one file to edit, click Build. Takes about 10 minutes the first time.

#   M e d i c i n e - l e d g e r  
 