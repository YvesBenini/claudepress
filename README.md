# ClaudePress

Let your clients edit the static sites you built for them, by asking in plain language. Free and open source, powered by Claude.

> ClaudePress is an independent open-source project. It is not made, endorsed or sponsored by Anthropic. Claude is a trademark of Anthropic, PBC.

You build sites with Claude Code (or by hand), as static sites in a git repo. Your clients don't have WordPress anymore, so every small change comes back to you. ClaudePress gives them a simple screen instead:

- **"Modifier le site"**: they type what they want ("change the opening hours on the shop page", "replace this photo"). Claude finds the right place, makes the edit, and shows a **before/after** of each change, outlined on the real page, side by side, on desktop or mobile. They can also attach a PDF (a new price list, a menu, a flyer, even a scanned poster): the assistant reads it line by line against the site, changes what differs, and says what was already right and what the site does not have.
- **Images and videos**: they can also ask for a picture they don't have ("an illustration of a summer terrace for the home page", "make this photo brighter"). The assistant makes it with an image model on [fal.ai](https://fal.ai) (Nano Banana Pro; short silent videos with Kling), shows it in the conversation and, for images, puts it in place as a proposed change. Every photo put on a site, generated or attached, is first sized for the spot it goes into (the size of the photo it replaces, 1200 to 2400 px wide, never enlarged) and compressed as WebP. An account can add its own fal.ai key next to its Claude key (Administration → Account): images and videos are then paid to fal.ai directly. Otherwise they use the server's `FAL_KEY` and are paid from the account's included AI credit (about 135 credits an image, 126 a second of video), even when the account uses its own Claude key.
- **"Écrire un article"**: Claude drafts a full blog post from a subject and a few notes. They edit it in a simple editor with a live **SEO checklist** and Google preview.
- **"Demander une nouvelle page"**: they describe the page; Claude turns it into a structured brief; the agency builds it.
- **Approval**: editors send changes for approval; the client's owner (or the agency) approves and publishes, or asks for a correction. Every published change can be undone.
- **Publishing on a date**: a change can be scheduled ("the new prices from 9 November"). When the request names a day, the assistant notes it and the publish button offers to schedule it for that day; an editor can ask for a day when sending a change for approval, and the approver approves and schedules it in one click. Until then the change is locked and can be published now or taken off the schedule. At the set time it is published as the person who scheduled it, if they still may; if it cannot be (the site changed in between, rights withdrawn), it goes back to its draft with the reason, and its author, that person and the agency are told.
- **You stay in control**: who has access to which site, who must be approved, what the assistant is allowed to touch, and what it costs.

- **White label**: an account can show its clients its own name, logo, tab icon and colour instead of ClaudePress's, and hide Nini, the mascot (Administration → Account): in the top bar, the browser tab, and the sign-in and invitation screens. Without a tab icon of its own, the browser tab shows the logo when it is about square, else the name's first letter on the account's colour. Every self-hosted account has it.

Nothing goes live without someone pressing **Publish** (or **Schedule**, for a date). Publishing is a git commit to the site's repo, attributed to the person, then your usual deploy.

## How it works

```
client ── chat ──▶ Claude + content tools ──▶ operations (before → after)
                                                   │
                       copy of the site + operations → site's own build → preview
                                                   │
                         approve ──▶ apply to the checkout → git commit → push / deploy
```

- **The assistant never edits code.** It gets a small set of tools (read a page, search, edit a text / list / button / photo, SEO texts, prices, hand over to the agency). Each edit is recorded as an operation that keeps its `before` value, so it can be shown, checked against the live content, and undone.
- **Previews use the site's own build.** For each change, ClaudePress copies the site checkout (copy-on-write on APFS/btrfs, so it is instant), applies the operations, runs the site's build command and serves the result under `/preview/…`.
- **Adapters** teach ClaudePress how a site stores its content (see `server/adapters/types.ts`):
  - `markdown`: one Markdown or MDX file per page, with a YAML or TOML front matter (Astro, Next.js, Hugo, Eleventy, Jekyll…). See [Markdown sites](#markdown-sites).
  - `blocks-json`: a JSON file of pages made of sections → rows → columns → blocks (the shape a WordPress/Divi export leaves), with an optional prices file.

## Run it

Requires Node.js 23.6 or later (TypeScript runs natively), git, and whatever the site's build needs.

```bash
npm install
cp config/claudepress.example.json config/claudepress.json   # describe your sites, users and access
cp .env.example .env                               # add your Claude API key
npm start                                          # http://localhost:4400
```

On first start, each site's repo is cloned into `workspaces/<site>/base` and built once.

### First start

Open the address: ClaudePress asks you to create the **administrator** account. Then, in **Administration**:

1. **Add a site**: its name, live address and GitHub repository (`owner/name`). ClaudePress clones it and builds it once.
2. **Invite people**: you get a one-time link to send them (valid 14 days) where they choose their password.
3. **Give access** per site:

| Role | Can do |
|---|---|
| **Administrator** | Everything, on every site: sites, people, reviewing and publishing. |
| **Client – can publish** | Edits their site and publishes; approves changes sent by others on that site. |
| **Client – no publishing** | Prepares changes and sends them for review; an administrator (or a client who can publish) puts them online. |

A client can also be trusted **like the agency**: everything without approval, and every file of the site (templates, styles, scripts).

4. **Set the permissions** of each site's clients (Administration → Sites), one kind of change at a time: **free**, **with the agency's approval** (even a client who can publish sends it to the agency, which approves it before it goes live), or **by the agency only** (the assistant hands it over).

| Kind of change | By default |
|---|---|
| Texts and photos of the pages, their Google title and description | Free |
| Blog articles | Free |
| Product prices | Free |
| Business details shown site-wide: address, phone, e-mail, opening hours | With approval |
| Menu labels and other texts shared by every page | With approval |

Everything else (layout, new sections, adding or removing items such as a team member or a product, forms, design, code) is the agency's. Each request the assistant hands over says what kind it is; in Administration → Requests, **Allow from now on** opens that kind to the site's clients, so the line moves with what each client actually asks for. A page can also have its own permission (the homepage with approval, legal pages by the agency only, `/project/*` for a group). When a site is added, the import scan reads its code, maps the site page by page (what comes from the content, what the code fixes) and proposes these permissions: the administrator reviews them on the site's settings and applies them in one click, before clients start. Business details are told apart from other shared texts by their keys (`contact.*`, `phone`, `email`, `address`, `hours`… holding a digit or an @).

### Previews and publishing

Previews are **on request**: the before/after of each change shows instantly from the content itself, and a full preview of the site (ready in 1 to 5 minutes) is prepared only when someone asks for it. Publishing works with or without a preview. Each site chooses how previews are made:

- **By ClaudePress (recommended, hosted).** One preview address per site, reused: the change is committed to a `claudepress/<change>` branch, Google Cloud Build clones it, runs the site's own build command and uploads the result to a private bucket (deleted when the change is published or discarded, and after 3 days in any case). ClaudePress shows it behind sign-in, and a share link shows it to people without an account. Publishing commits the change on the site's branch, on its latest version; the site's host deploys it (Netlify, Vercel, Cloudflare Pages, Firebase, Hostinger…). Configure with `previewBuild` (project, region, bucket, builder service account, Secret Manager name of the GitHub token).
- **By the site's own pipeline.** Each change becomes a pull request; the pipeline posts its preview address as a commit status named `preview` (or a GitHub deployment). Publishing squash-merges the pull request.
- **On the ClaudePress server** (self-hosting): the repository is cloned and built locally; previews are automatic, publishing commits and, if enabled, pushes.

In the first two modes ClaudePress keeps no copy of the site: content files are read through the GitHub API.

### Connecting GitHub

ClaudePress reaches repositories through its own **GitHub App**. The person running the server creates it once from Administration → Sites (GitHub's manifest flow: GitHub returns the app's keys to the server, which stores them encrypted). Each account then clicks **Connect my GitHub**, installs the app on its account or organisation and picks the repositories it allows; only those can be added as sites, and the installation joins an account only if the person who installed it can see it. Requests use one-hour installation tokens. Without the app (development, self-hosting), `CLAUDEPRESS_GITHUB_TOKEN` or the GitHub CLI's login is used.

### Site statistics

Each site can show its people a **Statistics** page: visitors, visits, page views and time per visit from **Google Analytics 4**, and clicks, impressions, click rate, average position and top searches from **Search Console**, over 7, 28 or 90 days against the period before, with the last 28 days in brief on the site's home. In Administration → Google statistics, an account gives ClaudePress read access one of two ways, then picks each site's Analytics and Search Console properties and whether its clients see them. Figures are fetched on demand and kept 6 hours.

- **Add ClaudePress as a viewer** (`"google": { "viewer": { "project": "<gcp-project>" } }`): each account gets its own Google address (a service account `cp-<account>@<project>.iam.gserviceaccount.com`, created the first time), which the agency or its client adds as a *Viewer* in Google Analytics (Property access management) and a *Restricted* user in Search Console (Users and permissions). An account only sees what was shared with its own address. No key is stored: the server acts as each address with short-lived tokens, so its own credentials need *Service Account Admin* and *Service Account Token Creator* on that project. Google allows about 100 service accounts per project by default; ask for more as accounts grow. A server with a single agency can use `"viewer": { "shared": true }` instead: one address, the service account the server runs as (`GOOGLE_APPLICATION_CREDENTIALS`); it is refused once the server has several accounts.
- **Connect Google** (`"clientId"` and `"clientSecret"` in the same `google` block): an administrator signs in with a Google account that already reaches the properties. It needs an OAuth client of type *Web application* with `<publicUrl>/api/google/connected` as an authorised redirect URI; its consent screen asks for `analytics.readonly` and `webmasters.readonly`, so until Google verifies the app only the test users listed there can connect. The refresh token is stored encrypted.

Either way, enable the Google Analytics Admin API, Google Analytics Data API and Google Search Console API in the Google Cloud project.

### Markdown sites

A Markdown site lists its folders of pages ("collections"), each with the address its files are published at and whether it holds pages or blog posts. In Administration → the site → Technical settings, one per line:

```
src/content/blog /blog/{slug}/ post
src/pages /{path}/ page
```

`{path}` is the file's path inside the folder without its extension (`index` and Hugo's `_index` give their folder), `{slug}` the front matter's `slug` or the file name; a `permalink` or `url` in the front matter wins. The most specific folder wins, and drafts are left out. The import scan proposes these lines from the framework's routing.

What clients can change: the page title, description (or `seo.description`, `metaDescription`…), SEO title when the site has its own field for it, and cover photo (`heroImage`, `image`, `cover.image`…) of the front matter; in the body, headings, paragraphs, simple lists, quotes, photos and link-only lines. Code, tables, HTML, MDX components and expressions, and shortcodes stay as they are, for the agency. An edit rewrites only the lines it changes, in the file's own style (quotes, block scalars, list markers). New blog posts copy the front matter of the latest post: same fields, same date format, lists emptied. On a site whose pages point to photos relative to their own file (Astro's `image()`), new photos are written relative too, so put the images folder under `src/` (for example `src/assets/uploads`).

Texts in shared JSON files (menu, footer, labels) work as for the other format.

### Languages

The interface is in **French and English**: each person picks it with the FR/EN switch (top bar and sign-in screens); the choice follows their account from device to device, and Firebase's e-mails use it too. The screens are written in French and `web/i18n.js` translates what they render, never what people wrote (conversations, page content, articles, before/after). `claudepressMissing()` in the browser console lists interface texts still missing an English version. The assistant answers in the language people write in.

### Sign-in

With a `firebase` block in the config (the web app config of a Firebase project with Authentication on), people sign in with **email + password or Google** (and **GitHub** with `"githubSignIn": true`, once the GitHub provider is on in Firebase) through Firebase Authentication: Firebase keeps the passwords and sends the confirmation and password-reset e-mails; ClaudePress checks the ID token once and opens its own session. Without it, ClaudePress uses its own passwords (scrypt) and invitation links.

Invitations go out by e-mail with a `mail` block (`{ "from": "ClaudePress <invite@your-domain>", "resendKey": "re_…" }`, or the key in `RESEND_API_KEY`), sent through [Resend](https://resend.com) from a domain verified there, in the agency's name, replies going to the administrator who invited. Without it, the administrator gets the invitation link to pass on.

### Data

By default everything is kept locally: one SQLite file (`data/claudepress.db`) and a folder of files (`data/blobs`: photos, assistant conversations). For hosting, set `"storage": { "type": "firestore", "projectId": "…", "bucket": "…" }`: records go to Firestore, files to a private Cloud Storage bucket, through Application Default Credentials. Only simple lookups are used, so Firestore needs no extra index. Lock the database to the server with rules that deny all client access.

### Site monitoring

ClaudePress checks every minute that each site's live address responds. After two failures in a row it opens an incident and tells the account's administrators, by e-mail and in the notifications; when a change was published in the two hours before, the alert names it and links to it, so it can be undone in one click. A site can also tell its clients, with a calm message under the agency's name. The SSL certificate's expiry is watched too (a warning 14 days before). Each site's settings page shows its uptime over 30 days, its response time and its last incidents; the site's home shows whether it is online.

Administration → Monitoring lists every site of the account like an uptime dashboard: how many are up, down or paused, then each site with its state, how long it has been in it, the last 24 hours in bars and its uptime. A site's page shows its monitor: current state, last check, certificate, uptime over 24 hours, 7 and 30 days with their incidents and downtime, 30 daily bars, the last 24 hours' response times and the latest incidents.

A self-hosted server monitors every site. A server with an extension that lists plans (see Extensions) monitors every site of the accounts whose plan includes it, and one site of the others; it never fetches private addresses.

Checks run on a timer inside the server. A server that sleeps between requests (App Hosting, Cloud Run) also needs a call to `POST <publicUrl>/api/monitor/tick` every minute; it only checks what is due, so it needs no secret. The same tick publishes the changes scheduled for that minute:

```bash
gcloud scheduler jobs create http claudepress-monitor --schedule="* * * * *" --uri="https://<publicUrl>/api/monitor/tick" --http-method=POST --location=europe-west1
```

### Site security

Once a day ClaudePress checks each site from outside and in its repository, and saves its files:

- **The live site**: HTTPS and the http → https redirect, security headers (HSTS, CSP, nosniff, framing), cookies, mixed content, secret keys left in its scripts (Stripe, AWS, OpenAI, Anthropic, GitHub, Supabase service_role…), files that should never be public (`.env`, `.git`, database dumps…), an open Firebase database or bucket, and scripts from other sites that appear on the page without being anywhere in the repository (a sign the site was changed behind the agency's back).
- **The domain**: its expiry (RDAP, a warning 30 days before), and for a domain that receives e-mail, SPF and DMARC.
- **The repository**: every dependency of its lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `requirements.txt`, `Gemfile.lock`) against the advisories of [OSV.dev](https://osv.dev) (which covers the GitHub Advisory Database), with the version that fixes each one; those in CISA's [Known Exploited Vulnerabilities](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) catalogue are marked critical. Keys and `.env` files committed to the repository.
- **A backup**: the repository's files as GitHub archives them, each time they changed, kept 90 days, downloadable from the site's page.

Each site gets a grade from A to F. What is new is told to the account's administrators in the notifications, and by e-mail when it is high or critical; what is gone at the next check is marked fixed. An administrator may accept a finding: it then stops counting. Administration → Security lists every site with its grade, then the bulletin: the published advisories that affect the account's sites, with the version that fixes each. No tool can guarantee a site will never be hacked: this is the process that finds problems early, says how to fix them and keeps a copy to restore.

The probes that ask for more than the home page and its scripts (sensitive files, Firebase) run only on a site ClaudePress knows is built from its repository: a change published from ClaudePress was seen on it, or the home page's title is in the repository.

A self-hosted server checks every site every day. With an extension that lists plans, the accounts whose plan does not include it check a site on request, once a day. The daily checks start with the same `POST /api/monitor/tick`. On Firestore, backups go to the storage bucket under `backups/`: give that prefix a retention policy (or object versioning) so a backup cannot be deleted from the server either.

### Hosting on Firebase App Hosting

`apphosting.yaml` takes every setting from Secret Manager, so it works for any Firebase project: the server settings as one line of JSON in `claudepress-config` (Firestore storage, Firebase sign-in, `githubOnly`, `firstAdmins`), and the secrets `claudepress-encryption-key`, `claudepress-anthropic-key` and `claudepress-fal-key`. A hosted server keeps no copy of sites, so only previews built by GitHub are offered. Set `firstAdmins` on any public server: otherwise the first person to sign in becomes its administrator.

### Configuration

`config/claudepress.json` (kept out of git) only holds server settings: `port`, `host`, `publicUrl` (used in invitation links), `model`, `agencyName`, `signup` (let new administrators create their own account), `firebase`, `google` (site statistics, see above) and `storage`. Every account has unlimited sites, clients and administrators and, when the server has a Claude key (`ANTHROPIC_API_KEY`), unlimited AI; Administration → Account shows each account its credits, sites and clients. Sites listed there under `sites` are imported once into the database; after that, the Administration screen manages them.

### Extensions

A hosted service can add what a self-hosted server does not need (plans with limits, an AI credit that runs out, payment, and the screens that offer them) without changing ClaudePress's code: an extension, the module `cloud/server/index.ts` (or the file named by `CLAUDEPRESS_EXTENSION`), whose default export follows the `Extension` interface in [server/extension.ts](server/extension.ts). Its plans' limits then apply everywhere (sites, clients per site, administrators, white label, monitoring, security, AI credit). Its screens are a folder of its own: its `app.js` is loaded before the first screen and adds to the places the app names with `ClaudePress.hook(name, fn)` (see "extensions" in [web/app.js](web/app.js)). Without an extension nothing changes.

## Status

Early prototype, used on one real site. Known gaps:

- **E-mail needs Resend.** Without a `mail` block, nothing is sent: invitations are links the administrator copies and passes on, and alerts only show in the app's notifications.
- **Two content formats.** Pages JSON and Markdown; other storage (a headless CMS, YAML data files) needs its own adapter.
- **Previews run the site's own scripts on the ClaudePress address.** That's fine for sites you built yourself. Don't point ClaudePress at a site whose code you don't trust.
- Costs shown are estimates from token counts.

## Contributing

Issues and pull requests are welcome. Run `npm run check` (TypeScript, no build step) before sending a change, and keep each pull request to one thing.

To report a security flaw, please don't open a public issue: see [SECURITY.md](SECURITY.md).

## License

[GNU AGPL-3.0](LICENSE) or later. Use it, change it, run it for your clients, for free. If you run a modified version as a service for others, share your changes under the same license.

The license covers the code, not the ClaudePress name, logo or the Nini mascot: see [TRADEMARKS.md](TRADEMARKS.md).
