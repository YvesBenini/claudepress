# ClaudePress for iPhone — plan

A small native iPhone app where a client connects once to their ClaudePress account and then just chats: "change the opening hours", "put this photo on the home page". They see what the assistant changed, and send it for approval or publish it, depending on their role.

The app is a new client of the existing `/api`. The assistant, the operations, approval and publishing stay on the server, unchanged.

## Choices made (can be changed)

| Question | Choice | Why |
|---|---|---|
| How a phone connects | **Pairing code / QR** shown in ClaudePress on the web | No password typed on the phone; works for self-hosted servers too, because the QR carries the server address |
| What the first version does | **Chat + see the changes + send for approval / publish + undo** | That is the whole "ask for an update" loop; articles, page requests and admin stay on the web |
| How it is built | **Native SwiftUI**, iOS 17+, in `ios/` in this repo | Camera / photo picker, push notifications, smooth streaming chat |

## Staying connected

A connected phone **stays connected**: no sign-in again after a few days.

- Pairing gives the phone its own **device token**, kept in the iOS Keychain (survives app restarts and updates, not shared with backups to other devices).
- The token has **no fixed expiry**. Each use updates `last_used`; it is dropped only after **6 months without opening the app**.
- It stops working when: the person removes the device on the web, an administrator deactivates the account, or the person resets their password (`endAllSessions` also removes their devices).
- Web sessions are unchanged (30 days from sign-in, `server/auth.ts`).

## Server changes

1. **Device tokens** (`server/auth.ts`, new collection `devices`)
   - `devices`: id = SHA-256 of the token (the token itself is never stored), `user_id`, `name` ("iPhone de Marie"), `created`, `last_used`, `apns_token`, `lang`.
   - `userOf(req)` also accepts `Authorization: Bearer cpd_<token>`; touches `last_used` at most once an hour.
   - `endAllSessions(userId)` also removes devices.
2. **Pairing**
   - `POST /api/devices/pair-code` (signed in on the web): returns an 8-character code (no ambiguous letters), valid 10 minutes, single use, plus the QR payload `claudepress://pair?server=<origin>&code=<code>`.
   - `POST /api/devices/pair` `{ code, deviceName }` (no session, in `authRoutes`, rate-limited with `tooManyAttempts`): returns `{ token, user }`.
   - `GET /api/devices`, `POST /api/devices/:id/remove`: list and revoke.
3. **Web**: in the account menu, "Connect the iPhone app" (QR + code + countdown) and the list of connected devices with "Remove". French text, English in `web/i18n.js`.
4. **Push notifications** (phase 4)
   - `notify()` in `server/db.ts` is already the single place where people are told something; it also sends to their devices through APNs (HTTP/2, `.p8` key, `apns` block in the config — instance values go in the private config, not this repo).
   - Plus one push when the assistant finishes a long answer while the app is in the background.
5. **Previews on the phone** (phase 3): the preview pages are behind the cookie session. `POST /api/devices/web-link` returns a one-time link (60 s) that opens a normal session in the app's web view, so the full preview and the live site show signed in.

Everything else is reused as it is:

| App needs | Existing route |
|---|---|
| Who am I, my sites, notices | `GET /api/me` |
| A site's open and recent changes | `GET /api/sites/:id` |
| Start a conversation | `POST /api/sites/:id/changes` `{ type: "edit" }` |
| Send a message, streamed answer | `POST /api/changes/:id/message` (NDJSON: `progress` lines, then `done` / `error`) |
| The conversation and the proposed changes | `GET /api/changes/:id` (`chat`, `items` with before/after texts, `can`) |
| Attach a photo | `POST /api/uploads` |
| Send for approval / publish / undo | `/submit`, `/publish`, `/approve`, `/request-changes`, `/undo` |
| Language | `POST /api/me/lang` |

## The app

```
ios/ClaudePress/
  App/            entry, deep link claudepress://pair
  Connect/        scan QR (VisionKit DataScanner) or type server + code
  API/            Client (URLSession, Bearer token), NDJSON stream reader, models
  Sites/          list (skipped when the person has one site)
  Chat/           messages, progress line, photo picker, generated images/videos
  Changes/        before/after cards, Send for approval / Publish, preview
  History/        published changes, Undo
  Settings/       language, notifications, disconnect
  Keychain.swift
```

Screens:

1. **Connect**: "Open ClaudePress on your computer → Connect the iPhone app → scan the code." Camera scanner, or type the code (server address prefilled with the hosted one, editable for self-hosting).
2. **Sites**: the sites from `/api/me`; one site opens directly.
3. **Chat** (the main screen): resumes the person's open draft on that site (`mine` from `/api/sites/:id`) or starts one. The assistant's progress shows as one live line ("Reading the Contact page…"). Photos from the library or camera. Images and videos the assistant made show in the conversation.
4. **Changes**: under the chat, a bar "3 changes ready" opens the list: each change as before → after text (or photos), remove one, full preview. Buttons by role: **Send for approval** (editor) or **Publish** (can publish). Review comments ("please change…") appear in the chat.
5. **History**: last published changes, **Undo**.
6. **Settings**: FR/EN (follows the account), notifications, "Disconnect this iPhone".

Language: French and English with String Catalogs, following the account's `lang`. Brand: Nini and the ClaudePress colours.

## Phases

| # | What | Done when |
|---|---|---|
| 1 ✅ | Server: device tokens, pairing, web "Connect the iPhone app" + devices list | A token from a code calls `/api/me`; removing the device on the web makes it 401 |
| 2 | App: connect, sites, streaming chat, photos | A message from the phone produces a change visible on the web |
| 3 | App: changes list, send for approval / publish, preview, history + undo | A change goes live from the phone |
| 4 | Push: approved, published, changes requested, answer ready | Notification arrives with the app closed, opens the right change |
| 5 | TestFlight, then App Store | Approved by Apple |

## App Store notes

- Apple's reviewer needs a way in: a review account on the hosted server and a pairing code that does not expire for that account, given in the review notes.
- No account creation in the app (accounts are made by the agency), so no in-app account deletion is required; "Disconnect this iPhone" is enough on the app side.
- Privacy: photos the person picks and the conversation go to their ClaudePress server; declare it in the privacy manifest and the App Store privacy form.

## Open questions

- App name and who publishes it on the App Store (the ClaudePress account, or each agency under its own name later?).
- Should the app also let agencies (administrators) approve changes on the go, or only clients in v1?
- Android later: the server side (tokens, pairing, push via FCM) is the same; only the app differs.
