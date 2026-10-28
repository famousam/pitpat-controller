# PitPat Web Bluetooth — improved static controller

A small controller for the PitPat/SupeRun FBA Bluetooth protocol, prepared for Chrome on an Android phone such as the Pixel 8 Pro. It provides explicit movement controls, a remembered speed, and local workout records.

**Open the app:** [famousam.github.io/pitpat-controller](https://famousam.github.io/pitpat-controller/). Use Chrome on your Android phone, tap **Connect**, and select your walking pad. Connecting does not start the belt.

**This adaptation has not been tested on your walking pad.** Its software checks reduce specific failure modes; they do not certify the treadmill, its firmware, or uninterrupted Bluetooth operation. Keep the physical remote available.

## Files and requirements

Keep these files together in the published folder:

- `index.html` — responsive screen and embedded CSS.
- `controller-core.js` — protocol, command, and session logic.
- `treadmill.js` — browser Bluetooth and screen behavior.
- `LICENSE` — upstream code license.

There is no build step, npm installation, backend, or service worker. The phone needs Chrome, Bluetooth enabled, and access to the HTTPS page. The app loads no third-party scripts, fonts, or styles.

Google documents [Bluetooth website connections on Android](https://support.google.com/chrome/answer/6362090?co=GENIE.Platform%3DAndroid&hl=en). [Web Bluetooth requires a secure context and a user gesture for initial device selection](https://developer.chrome.com/docs/capabilities/bluetooth).

## Quick hosting with GitHub Pages

Using a computer for this one-time upload is easiest:

1. Create a public repository in your own GitHub account, for example `pitpat-controller`.
2. Upload the contents of this folder to the repository root. `index.html` must be directly in that root, not inside another folder.
3. Open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**, then **main** and **/(root)**. Save.
5. Wait for the deployment to finish and open the HTTPS address shown by GitHub, typically `https://YOUR-USERNAME.github.io/pitpat-controller/`.
6. Check **Enforce HTTPS** in the Pages settings.

GitHub documents [branch publishing](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) and [HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https). GitHub Pages sites are public. Publish the application files only: do not add device identifiers, credentials, or workout exports to the repository.

The static host serves the screen and code. Bluetooth commands travel from your phone to the nearby treadmill; the host is not a treadmill-control server. Workout records remain in your browser unless you export them.

Use the top-level HTTPS page in Chrome. A downloaded file, an embedded chat preview, or plain HTTP on a home-network address is not the supported deployment for this version. No Chrome security flags, port forwarding, or self-signed certificates are needed.

## Connect from your Pixel 8 Pro

1. Use an up-to-date Chrome in a normal browsing profile.
2. Turn Bluetooth on and switch on the walking pad.
3. Close PitPat and other treadmill controllers so they release the pad's connection.
4. Open your HTTPS controller address directly in Chrome.
5. Tap **Connect**, choose your pad, and accept Chrome's device permission prompt.
6. Allow Chrome's **Nearby devices** permission if Android requests it. If previously denied, check **Settings → Apps → Chrome → Permissions → Nearby devices** where listed.
7. Wait for compatible live status before using movement controls. Connecting itself must not start the belt.
8. Keep **Keep screen awake** enabled while using the controller, and check that it reports an active wake lock.

Google documents [Pixel app permissions](https://support.google.com/pixelphone/answer/6293419?hl=en). Grant the permission Chrome requests; this setup does not require blanket access to your contacts, files, or other unrelated data.

For a home-screen icon, current Chrome uses **⋮ → Install and create shortcut → Create shortcut → Add**. Older versions may say **Add to Home screen**. A shortcut opens the controller in Chrome; it does not add background Bluetooth privileges. See [Google's shortcut instructions](https://support.google.com/chrome/answer/15085120?co=GENIE.Platform%3DAndroid&hl=en).

## Everyday controls

- **Selected speed:** preselect a target from **1.0 to 6.0 km/h**. Selecting a speed while stopped stores the preference without starting the belt.
- **Start:** explicitly applies the selected speed. Begin hardware testing at **1.0 km/h**.
- **Speed − / +:** adjust the running target in **0.1 km/h** steps.
- **Pause / Resume:** use the action appropriate to the observed treadmill state. Pause keeps the current workout together.
- **Stop:** requests a stop with priority over unsent movement commands. It remains available to attempt a stop when the GATT connection is usable, including when ordinary movement controls are blocked.
- **Usual speed:** estimates the speed used for the longest observed running time and can preselect it for a later workout. Restoring a preference never issues a movement command.

Commands are serialized. Disconnects and stale connection state cancel unsent commands; reconnecting does not replay an old Start or speed command. A command already handed to Bluetooth cannot be recalled by JavaScript. A successful write is not proof that the motor has stopped: check live status and the belt.

## Workout records

The recorder tracks observed running periods and keeps pause/resume in one workout. It saves partial records after disconnection, page reload, or gaps in observation instead of presenting them as complete sessions.

Time is **observed active time measured by the phone**, avoiding assumptions about firmware-specific duration units. Distance and other totals use observed device-counter changes. Missing telemetry can mean missing time or counter changes; these records are not guaranteed to match the pad's final display.

The usual-speed calculation weights valid speed observations by their elapsed duration. It does not count stopped time or assume a speed remained unchanged through a data gap.

Automatic usual-speed learning requires at least ten observed walking seconds and complete speed coverage. A counter reset alone does not invalidate speed coverage, but a gap, an unexpected workout-cycle change, or joining an already running belt does. The last manually selected speed is still remembered. A firmware that changes its cycle ID unexpectedly may therefore require manual presets until its behavior is verified.

Records and preferences are stored locally in this browser profile and site origin. Clearing site data, changing the site's hostname, or using another browser can make them unavailable. Storage failures are shown on screen. Use **Export** to save a JSON backup; this version deliberately has no history-import function.

## First-session hardware checks

Complete these checks beside the pad, with its remote ready:

1. **Idle:** connect with the belt stopped. Confirm sensible state, speed, and reported limits. Incompatible or implausible telemetry must leave movement controls disabled.
2. **Preselection:** change the selected speed while stopped. The belt must remain stopped.
3. **Start and Stop:** choose **1.0 km/h**, press Start, check actual motion, then Stop. Confirm the belt stops.
4. **Adjustment and pause:** start again at low speed; check one +0.1 and one −0.1 adjustment. Check Pause, Resume, and Stop. Confirm pause/resume stays in one record.
5. **Power cycle:** stop first, switch the pad off, then on. Reconnect and verify that the belt remains stopped until a new Start action.
6. **Recording:** finish a short session, reload the page, and export its record. Treat gaps or missing device metrics as limitations to investigate, not values to fill in by guessing.

If a control behaves unexpectedly, stop with the physical remote and discontinue that control until the firmware/protocol behavior is understood. Software tests cannot replace these checks.

## Compatibility and limits

This app targets the FBA protocol documented by [PitPat-WebBT](https://github.com/KeiranY/PitPat-WebBT) and the [BA09-B controller's protocol reference](https://github.com/heilmic/treadmill-tray/blob/main/docs/reference/hex-commands.md): service **FBA0**, writes **FBA1**, and notifications **FBA2**.

Incoming status must match the recognized **0x68 / declared length / 0x43 trailer** framing and plausible fields before movement is enabled. **The received-packet checksum has not been verified against your firmware.** Framing and plausibility checks cannot prove every reading is correct. A different firmware layout is rejected rather than guessed. The selected movement range remains capped at **6.0 km/h**.

HTTPS authenticates and encrypts delivery of the web page. It does not add authentication to the treadmill's Bluetooth firmware. Only run code you trust and grant access to your own pad.

### Keep the controller in the foreground

Screen Wake Lock prevents ordinary screen dimming while the page is visible. It can be refused or released, including on low battery or when switching apps. Chrome documents the [wake-lock behavior](https://developer.chrome.com/docs/capabilities/web-apis/wake-lock).

Android or Chrome may freeze, discard, or terminate a background page. Timers and callbacks can stop, and an unload handler may never run. Neither a home-screen icon nor this app can guarantee control, continuous logging, or a Stop command after the phone locks. See [Chrome's Page Lifecycle documentation](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).

**The phone is not a motor failsafe.** Do not rely on closing the page, disconnecting Bluetooth, or locking the screen to stop the pad. Use Stop and verify the belt, with the physical remote available.

If you need dependable recording while the phone is locked or another app is open, use an always-running backend such as [HomeAssistantWalkingPad](https://github.com/sirfergy/HomeAssistantWalkingPad), after testing its compatibility with your unit.

## Software validation

This package passed **19 core tests** and **7 isolated Chromium integration tests**. All Bluetooth in the tests was simulated; none of these checks operated a real pad or Pixel.

The checks include published command byte vectors, bounds and malformed frames, write serialization and Stop priority, canceled commands across reconnects, pause/stop confirmation, stale and hidden-page behavior, interrupted recording, duration-weighted speed learning, stored-data injection, and mobile layout at 448 px and 360 px. The browser test observed no external runtime requests or JavaScript page errors. An independent source review was also completed.

For developers, the core checks need only Node.js: run `node tests/core.test.cjs` from this folder. The optional browser suite is `node tests/browser.test.cjs`; it needs the `playwright` package and its Chromium browser installed in the development environment. Neither is needed to host or use the app.

## Provenance and license

This is an adaptation of **KeiranY/PitPat-WebBT**, based on commit [`17f94a666c3392ab9dcb9cb76942f47620e8030a`](https://github.com/KeiranY/PitPat-WebBT/tree/17f94a666c3392ab9dcb9cb76942f47620e8030a), hosted at [famousam/pitpat-controller](https://github.com/famousam/pitpat-controller). It is not an upstream release and is not affiliated with PitPat or SupeRun.

The upstream project uses the **Unlicense**; see the included `LICENSE`. Protocol documentation was cross-checked with the BA09-B project linked above. Validation performed on the software does not constitute testing on a physical BA09-B, a Pixel 8 Pro, or your particular firmware.
