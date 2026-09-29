import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ADMIN_EMAIL, isAdmin } from "../supabase/functions/marketplace/admin-access.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFile(new URL(path, `file://${root}`), "utf8");

 test("only the confirmed new administrator address receives admin access", () => {
  assert.equal(ADMIN_EMAIL, "weblitexagency@gmail.com");
  assert.equal(isAdmin({ email: ADMIN_EMAIL, email_confirmed_at: "2026-09-29T00:00:00Z" }), true);
  assert.equal(isAdmin({ email: "WEBLITEXAGENCY@GMAIL.COM", email_confirmed_at: "2026-09-29T00:00:00Z" }), true);
  assert.equal(isAdmin({ email: "mkuk2013@gmail.com", email_confirmed_at: "2026-09-29T00:00:00Z" }), false);
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

test("signup and DNS publishing stay paused", async () => {
  const config = await read("config.js");
  assert.match(config, /publicSignupEnabled:\s*false/);
  assert.match(config, /dnsPublishingExpected:\s*false/);
});

test("the deployed RPC migration uses the new address and preserves server-only access", async () => {
  const migration = await read("supabase/migrations/202609290004_update_marketplace_admin_email.sql");
  const edge = await read("supabase/functions/marketplace/index.ts");
  assert.match(migration, /weblitexagency@gmail\.com/g);
  assert.doesNotMatch(migration, /mkuk2013@gmail\.com/i);
  assert.match(migration, /grant execute on function public\.admin_review_request\(uuid,uuid,text,text\) to service_role/i);
  assert.match(edge, /from \"\.\/admin-access\.mjs\"/);
});
