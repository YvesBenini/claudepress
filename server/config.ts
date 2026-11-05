// Server settings (config/claudepress.json, or the file named by CLAUDEPRESS_CONFIG).
import fs from 'node:fs';
import path from 'node:path';

export interface ClaudePressConfig {
  port: number;
  host: string;
  publicUrl?: string;                 // address people use, for invitation links (default http://host:port)
  model: string;
  agencyName: string;
  signup?: boolean;                   // let new administrators create their own account (Free plan)
  /** Google Analytics 4 measurement id (G-…): the web app then measures visits, only after the person accepts the banner. */
  analytics?: { measurementId: string };
  /**
   * Site figures (Analytics 4 + Search Console, read only; see server/insights.ts). `clientId`/`clientSecret`: "Connect Google",
   * an OAuth client of type "Web application" whose authorised redirect is <publicUrl>/api/google/connected. `viewer`:
   * "Add ClaudePress as a viewer", one service account per account created in `project`, or `shared` (one agency only).
   */
  google?: { clientId?: string; clientSecret?: string; viewer?: { project: string } | { shared: true } };
  /** E-mails to people (invitations): sent through Resend from `from` ("ClaudePress <invite@claudepress.org>", a verified domain). */
  mail?: { from: string; resendKey?: string };
  /** Sign-in through Firebase Authentication (else local passwords). `authEmulator` (http://127.0.0.1:9099): local tests only. */
  firebase?: { apiKey: string; authDomain: string; projectId: string; appId: string; authEmulator?: string };
  /** With Firebase: also offer "Continue with GitHub" (the GitHub provider must be on in Firebase Authentication). */
  githubSignIn?: boolean;
  /** Where data lives: a local file (default), or Firestore + a Cloud Storage bucket. */
  storage?: { type: 'local' } | { type: 'firestore'; projectId: string; bucket: string; database?: string };
  /** Only these addresses may become the first administrator of a new server (strongly advised on a public address). */
  firstAdmins?: string[];
  /** Hosted servers keep no copy of sites: only previews built by the sites' own pipelines (GitHub) are offered. */
  githubOnly?: boolean;
  /** Previews built by ClaudePress on Google Cloud Build (see server/cloudbuild.ts). */
  previewBuild?: { project: string; region: string; bucket: string; serviceAccount: string; githubTokenSecret: string; image?: string };
  sites?: any[];                      // imported once into the database
  /** Settings of the server's extension, if it has one (server/extension.ts): read by the extension itself. */
  [extension: string]: unknown;
}

// CLAUDEPRESS_CONFIG_JSON (hosting) wins over the file, so a hosted server needs no file in the repository
const CONFIG_FILE = path.resolve(process.env.CLAUDEPRESS_CONFIG || 'config/claudepress.json');
export const config: ClaudePressConfig = process.env.CLAUDEPRESS_CONFIG_JSON
  ? JSON.parse(process.env.CLAUDEPRESS_CONFIG_JSON)
  : JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
