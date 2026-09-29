import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ADMIN_EMAIL, isAdmin } from "../supabase/functions/marketplace/admin-access.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFile(new URL(path, `file://${root}`), "utf8");

test("only the confirmed original administrator address receives admin access", () => {
  assert.equal(ADMIN_EMAIL, "mkuk2013@gmail.com");
  assert.equal(isAdmin({ email: ADMIN_EMAIL, email_confirmed_at: "2026-09-29T00:00:00Z" }), true);
  assert.equal(isAdmin({ email: "MKUK2013@GMAIL.COM", email_confirmed_at: "2026-09-29T00:00:00Z" }), true);
  assert.equal(isAdmin({ email: "weblitexagency@gmail.com", email_confirmed_at: "2026-09-29T00:00:00Z" }), false);
  assert.equal(isAdmin({ email: ADMIN_EMAIL, email_confirmed_at: null }), false);
  assert.equal(isAdmin({ email: null, email_confirmed_at: "2026-09-29T00:00:00Z" }), false);
});

test("header and footer use the supplied logo and favicon derivatives", async () => {
  const html = await read("index.html");
  assert.equal((html.match(/src=\"\.\/assets\/weblitex-logo\.jpg\"/g) ?? []).length, 2);
  assert.match(html, /href=\"\.\/favicon\.ico\"/);
  assert.match(html, /href=\"\.\/assets\/favicon-32x32\.png\"/);
  assert.match(html, /href=\"\.\/assets\/apple-touch-icon\.png\"/);
  for (const path of ["assets/weblitex-logo.jpg", "favicon.ico", "assets/favicon-32x32.png", "assets/apple-touch-icon.png"]) {
    assert.ok((await stat(new URL(path, `file://${root}`))).size > 1000, `${path} should be present and non-empty`);
  }
});

test("buyer signup is enabled while DNS publishing stays paused", async () => {
  const config = await read("config.js");
  assert.match(config, /publicSignupEnabled:\s*true/);
  assert.match(config, /dnsPublishingExpected:\s*false/);
});

test("the restored RPC migration uses the original address and preserves server-only access", async () => {
  const migration = await read("supabase/migrations/202609290005_restore_original_admin_email.sql");
  const edge = await read("supabase/functions/marketplace/index.ts");
  assert.match(migration, /mkuk2013@gmail\.com/g);
  assert.doesNotMatch(migration, /weblitexagency@gmail\.com/i);
  assert.match(migration, /grant execute on function public\.admin_review_request\(uuid,uuid,text,text\) to service_role/i);
  assert.match(edge, /from "\.\/admin-access\.mjs"/);
});

test("pending requests are marketplace-only, authenticated, collision-safe, and never claim unverified provider availability", async () => {
  const app = await read("app.js");
  const edge = await read("supabase/functions/marketplace/index.ts");
  const migration = await read("supabase/migrations/202609290001_marketplace.sql");
  const requestRoute = edge.slice(edge.indexOf('if (action === "request_subdomain")'), edge.indexOf('if (action === "submit_payment")'));
  assert.match(edge, /const user = await currentUser\(req, db\);[\s\S]*if \(action === "request_subdomain"\)/);
  assert.match(requestRoute, /checkMarketplaceAvailability\(db, label\)/);
  assert.doesNotMatch(requestRoute, /checkAvailability\(|zoneRecords\(|spaceship\(/);
  assert.match(requestRoute, /create_marketplace_request/);
  assert.match(migration, /create unique index subdomain_requests_active_label_uq[\s\S]*on public\.subdomain_requests \(label\)[\s\S]*where status not in \('denied','cancelled'\)/i);
  assert.match(app, /Provider-zone availability has not been verified\./);
  assert.match(app, /Request this prefix/);
  assert.match(app, /DNS provisioning happens only after approval/);
  assert.doesNotMatch(app, /New requests are paused until DNS credentials/);
  const html = await read("index.html");
  assert.match(html, /Sign-up and prefix requests are open \(email confirmation required\)/);
  assert.match(html, /Easypaisa proof is checked manually/);
  assert.match(html, /DNS record management begins only after admin approval and Spaceship secret\/zone setup/);
  assert.doesNotMatch(html, /Preview is live while the owner finishes email delivery/);
});
