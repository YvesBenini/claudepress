# Security

ClaudePress holds Claude and fal.ai keys, the keys of its GitHub App, and the right to push to the repositories of the sites it edits. Please report flaws privately.

## Reporting a flaw

Use **[Report a vulnerability](https://github.com/YvesBenini/claudepress/security/advisories/new)** on GitHub (Security tab → Advisories). Please don't open a public issue or pull request for it.

Say what is affected, how to reproduce it and what an attacker could do with it. You will get an answer within a week. Once a fix is out, the advisory is published and, if you want, you are credited in it.

## What is covered

The code in this repository: the server (`server/`), the web app (`web/`) and the deployment file (`apphosting.yaml`).

Not covered: the sites you connect to ClaudePress (see "Status" in the README: previews run a site's own scripts), and servers run by other people.

## Supported versions

Only the latest commit on `main`. There are no release branches yet.
