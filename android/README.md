# Medicine Ledger — Android app

This wraps your deployed Medicine Ledger web app in a real Android app — an icon on the
home screen, no browser address bar, back button works properly. Under the hood it's a
WebView pointed at your live URL, so it always shows whatever's currently deployed.

**Before anything else, you need your app deployed and working in a browser first.**
This APK just loads that URL — there's nothing to build until that link exists and works.
See the main `README.md` for the deploy steps (Render, ~5 minutes).

## What you need

- **Android Studio** (free) — [developer.android.com/studio](https://developer.android.com/studio). Just install it normally, no special setup.
- Your deployed app's URL (e.g. `https://your-app.onrender.com`)

## Steps to build a test APK

1. **Put your URL in the code.** Open this file:
   `app/src/main/java/com/medledger/app/MainActivity.kt`
   Find this line near the top:
   ```kotlin
   private val appUrl = "https://your-app.onrender.com"
   ```
   Replace it with your actual deployed link, then save.

2. **Open the project in Android Studio.**
   Android Studio → **File → Open** → pick this `android` folder (the one with
   `settings.gradle` inside it) → **Open**.
   It'll spend a few minutes downloading things the first time ("Gradle sync") — just
   let it finish, don't click anything.

3. **Build the APK.**
   Top menu → **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
   Wait for it to finish (a notification pops up bottom-right).

4. **Find and install it.**
   Click **"locate"** on that notification — it opens the folder containing
   `app-debug.apk`. Copy that file to your phone (email it to yourself, USB transfer,
   Google Drive, whatever's easiest) and tap it on the phone to install. Android will
   warn about installing from outside the Play Store the first time — that's expected
   and normal for a test build; tap "Install anyway."

That's the whole process. Steps 1-2 are one-time setup; if you change your app later and
want a fresh APK, you only need step 3 again (skip straight to Build APK).

## Optional — testing live without building an APK each time

Instead of steps 3-4, you can click the green ▶ **Run** button in Android Studio with a
phone connected by USB (with "USB debugging" turned on in the phone's Developer Options)
or an emulator running. It installs and opens instantly — much faster for repeated
testing while you're still checking things look right.

## Things worth knowing

- **This debug build isn't signed** — that's fine for testing and sharing with your own
  team, but the Play Store requires a signed "release" build, which is a separate,
  later step if you ever want to publish it there.
- **Push notifications don't work through this APK.** Android's WebView doesn't support
  background push the way a real installed browser does. If you want real
  notification-bar alerts, open the site directly in Chrome on the phone and use
  Chrome's menu → **"Add to Home Screen"** instead of this APK — same look and feel,
  but push notifications actually work. This APK is best for the core day-to-day
  dashboard/logging use, not for notifications specifically.
- The app icon (teal medical cross) is already included. To use your own, right-click
  the `res` folder in Android Studio → **New → Image Asset**, and it regenerates all the
  sizes for you from one image.
- Needs internet access to work, same as the website — it's still talking to the same
  server either way.
