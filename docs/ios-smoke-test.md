# Real-iPhone smoke test

Automated tests (Vitest, Playwright) cannot reproduce iOS WebKit's microphone prompts, Home Screen installation, background suspension or service-worker update timing. Run this check on a real iPhone before each release that touches recording, storage, the service worker or the manifest, and record the results in the table at the end.

Run every section twice: once in **Safari** and once in **Chrome on iOS**. Both use Apple's WebKit, but their permission prompts, menus and Home Screen behaviour differ.

## Before you start

- **Device:** an iPhone on the current iOS release, plus the previous major release if you have one. Write the exact versions in the results table (Settings → General → About).
- **Build under test:** the deployed site at `https://js-headquaters.github.io/tennis-stats/`, or a staging deployment with the same `/tennis-stats/` path. Do not test on `localhost` over the LAN: service workers and the microphone require HTTPS.
- **Provider key:** use a restricted, budget-capped test key created only for this test, and revoke it afterwards.
  - Never paste the key into notes, screenshots, issues or this document.
  - If you inspect storage (see "Reading diagnostics"), do not capture the local-storage view that shows the key.
- **Clean start:** remove any earlier Home Screen icon for the app. Clear the site's data:
  - **Safari:** Settings → Apps → Safari → Advanced → Website Data. Find `js-headquaters.github.io` and delete it.
  - **Chrome:** Chrome → Settings → Privacy and Security → Clear Browsing Data.
- **Mac (optional):** you need one for the "Reading diagnostics" steps.

## Reading diagnostics without exposing secrets

The app has no hidden diagnostics screen, and none may be added if it could show keys. To observe the recording MIME type and service-worker state, use Safari Web Inspector.

1. On the iPhone, turn on Settings → Apps → Safari → Advanced → **Web Inspector**.
   - For Chrome on iOS, turn on Chrome → Settings → Content Settings → **Web Inspector**, if your version offers it. If it does not, record "not observable" for Chrome.
2. Connect the iPhone to the Mac by cable.
3. In Safari on the Mac, open Develop → *your iPhone* → the Tennis Stats page (or the Home Screen app).
4. **Recording MIME type:** open Storage → IndexedDB → `tennis-stats` → `drafts`, select the newest draft, and read its `mimeType` field. On current iOS it is expected to be `audio/mp4` (possibly with `;codecs=mp4a.40.2`).
   - The recorder tries these formats in order: `audio/mp4;codecs=mp4a.40.2`, `audio/mp4`, `audio/aac`, `audio/webm;codecs=opus`, `audio/webm`.
5. **Service worker:** open Storage → Cache Storage. You should see only the `workbox-precache-…` cache, holding `/tennis-stats/` files.
   - There must be **no** entries for provider hosts such as `api.openai.com` or `api.anthropic.com`, or for any custom endpoint.
6. **Do not open the Local Storage view.** It contains the test key. If you open it by mistake, do not screenshot or record it.

## 1. Install (Add to Home Screen)

| Step | Expected |
| --- | --- |
| Open `https://js-headquaters.github.io/tennis-stats/` and let it load fully. | The app shell and navigation render. |
| **Safari:** Share → Add to Home Screen. **Chrome:** Share (the icon in the address bar) → Add to Home Screen. | The suggested name is "Tennis Stats", with the lime tennis-ball icon. |
| Open the app from the Home Screen icon. | It opens full screen (standalone, with no browser bar) on the start page at `/tennis-stats/`. The status bar is readable and the header is not hidden under the notch or Dynamic Island. |
| Open Settings → **Application**. | App version, data/schema version, Online status, installed/standalone status and offline readiness are shown. The installed app says it is running as an installed app. |
| Turn on Airplane Mode, then force-quit the app and reopen it from the Home Screen. | The app opens from the cache. History, dashboards and manual entry work. The offline banner says AI transcription is waiting for a connection. |
| Navigate to a deep page (a match), force-quit the app, and reopen it while still offline. | The app loads; it does not show an iOS "no connection" page. |

> A Home Screen app on iOS has **its own storage**, separate from the same site in a Safari or Chrome tab. Data entered in the browser tab does not appear in the installed app. Use backup and restore (section 7) to move data between them.

## 2. Microphone: allow, deny and recovery

| Step | Expected |
| --- | --- |
| Open a match, then choose **Record with voice** → Start recording. | iOS shows its microphone permission prompt. The app does not record anything before you allow it. |
| Tap **Allow**, speak for about 5 seconds, then stop. | The recording is saved before navigation. The app opens the voice-draft review page and starts transcription/parsing automatically. If you return to the recording page, the retained draft appears under **Saved voice drafts**. |
| Reset the permission for the site:<br>• **Safari:** aA menu → Website Settings → Microphone → Ask.<br>• **Chrome:** iOS Settings → Apps → Chrome → Microphone.<br>Then start recording again and tap **Don't Allow**. | The app explains how to turn the microphone on, and offers **Manual entry**. It does not crash or hang in "requesting". |
| Turn the microphone back on, using the same settings path, and return to the app. | Recording works again without reinstalling the app. Record whether a page reload was needed. |
| In the installed Home Screen app, repeat Allow and Deny. | Same behaviour as in the browser. Note any difference in the prompt (iOS may ask again on each launch). |

## 3. Recorded format

| Step | Expected |
| --- | --- |
| After a successful recording, read the draft's `mimeType` (see "Reading diagnostics"). | An `audio/mp4` (AAC) type on iOS. Record the exact string. |
| Let the review page process the draft automatically while online with the test key. | Transcription succeeds; the provider accepts the format. A format error is a **fail**: record the MIME type and the message shown. |
| While processing is active, tap **Cancel processing**. | Processing stops, the recording remains, and the draft becomes retryable. **Retry processing** can start it again. |
| Tap **Discard draft**, then **Keep draft**; repeat and choose **Confirm discard**. | The first choice preserves the recording. The confirmed choice removes the draft and its recording without changing games already added to the match. |

## 4. Lock screen and background during recording

| Step | Expected |
| --- | --- |
| Start recording, then lock the phone for 10 seconds and unlock it. | The app either keeps the audio recorded so far or shows a clear, recoverable state (for example, it saved or stopped the recording with a message). It never loses the draft silently and never shows a frozen "recording" state. |
| Start recording, swipe to the Home Screen, open another app for 10 seconds, then return. | Same as above. Record which of the two behaviours you saw. |
| Start recording and take an incoming call (or start a timer alarm). | The recording stops or pauses with a visible message. Any audio already captured stays as a draft or can be retried. |

## 5. Offline manual entry

| Step | Expected |
| --- | --- |
| Turn on Airplane Mode. Start a new match, then add games and a tie-break with **Manual entry**. | Everything saves. The offline banner is visible. Nothing tries to reach an AI provider. |
| Edit and delete a game while offline, then force-quit and reopen. | The changes are still there. |

## 6. Pending recording, retried after reconnecting

| Step | Expected |
| --- | --- |
| While offline, record a voice entry. | The draft is saved as waiting for a connection or retryable. The banner explains that transcription is waiting. |
| Force-quit the app, turn Airplane Mode off, and reopen. | The draft is still listed. A cold online start does **not** show “Back online”; that message is only for an offline→online transition while the app is open. |
| With the reopened app visible, go offline and then turn Airplane Mode off. | The banner briefly shows “Back online. Voice drafts that were waiting can be retried now.” |
| Open the draft and tap **Retry processing**. Review the parsed games, then confirm. | Transcription and parsing succeed. The games are added only after you confirm, and only once (no duplicates if you tap twice). |

## 7. Backup: download and upload

| Step | Expected |
| --- | --- |
| Settings → **Export backup**. | iOS offers to save or share a `.json` file. Save it to Files (On My iPhone). |
| Open the saved file in Files (Quick Look). | It contains match data **only**. Searching it for the test key or the endpoint finds nothing (spot-check with a short part of the key, then discard the search). |
| Settings → **Import backup**, then pick the file from Files. Check the preview, then choose **Merge into current data**. | The preview counts match the file, and the import reports added and skipped records. |
| Repeat in the other context: export from the Safari tab and import in the Home Screen app. | The data appears in the installed app. |

## 8. Update prompt

Before this section, deploy a new build to the same site. Any change that alters a bundled file is enough.

| Step | Expected |
| --- | --- |
| With the app open (installed, online), wait about 1 minute, or switch away from the app and back. If nothing appears, close and reopen the app once. | "An update is available" appears with **Reload to update** and **Later**. The page does **not** reload by itself. |
| Start a voice recording while the prompt is visible. | **Reload to update** is disabled and the reason is shown ("Finish or save your recording or draft first…"). |
| Stop the recording, let it save, and let automatic processing finish (or tap **Cancel processing**). | **Reload to update** becomes enabled. Persisted recorded/ready/waiting/error/processing/confirming drafts do not block updates by themselves; only work active in this page session does. |
| Tap **Later**. | The prompt hides and stays dismissed while this page remains mounted; the app keeps working on the old version. |
| Reload or reopen the app so the update prompt can appear again, then tap **Reload to update**. | The app reloads exactly once and runs the new build. All matches and drafts are still there. |
| If the app is open in two contexts (for example, two Safari tabs), tap **Later** in one and apply the update in the other. | Neither tab reloads on its own. The tab that chose **Later** stays dismissed until it is reloaded/reopened; other contexts manage their own prompt. |

## 9. Private Browsing storage failure

Private Browsing can reject IndexedDB Blob writes on some iOS versions. This row verifies that a rejected save is visible and recoverable rather than silently losing audio.

| Step | Expected |
| --- | --- |
| Open a new Private Browsing tab, start a match, choose **Record with voice**, record briefly, and stop. | If the recording saves, note that result. If storage rejects the Blob, the page says the recording could not be saved, keeps it on that page, and offers **Retry saving recording** plus **Manual entry**. It must not navigate to a nonexistent draft or claim the recording was saved. |

## Results

Copy this table for each run. Mark each cell **Pass**, **Fail** or **N/A**, and explain every Fail or N/A in Notes.

| Date | Tester | iPhone model | iOS version | Browser and version | Build (commit) | 1 Install | 2 Mic | 3 Format (MIME) | 4 Lock/background | 5 Offline manual | 6 Pending retry | 7 Backup | 8 Update | 9 Private | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| YYYY-MM-DD | | | | Safari | | | | `audio/mp4` | | | | | | | |
| YYYY-MM-DD | | | | Chrome | | | | | | | | | | | |

When you finish, revoke the test key and delete the site data from the test device.
