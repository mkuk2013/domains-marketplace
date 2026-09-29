import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const PROJECT_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SECRET_KEYS = (() => {
  try { return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); } catch { return {}; }
})();
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? SUPABASE_SECRET_KEYS.default ?? "";
const SPACESHIP_KEY = Deno.env.get("SPACESHIP_API_KEY") ?? "";
const SPACESHIP_SECRET = Deno.env.get("SPACESHIP_API_SECRET") ?? "";
const ADMIN_EMAIL = "mkuk2013@gmail.com";
const ROOT_DOMAIN = "weblitex.com";
const CHILD_ZONE = "domains";
const SPACESHIP_BASE = "https://spaceship.dev/api/v1";
const RESERVED = new Set(["admin", "api", "autoconfig", "autodiscover", "cpanel", "domains", "ftp", "imap", "mail", "ns1", "ns2", "root", "smtp", "webmail", "www"]);
const ALLOWED_ORIGINS = new Set([
  "https://domains.weblitex.com",
  "https://mkuk2013.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowOrigin = !origin || ALLOWED_ORIGINS.has(origin) ? (origin || "*") : "https://domains.weblitex.com";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function respond(req: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function getClient(): SupabaseClient {
  if (!PROJECT_URL || !SERVICE_KEY) fail("Marketplace backend is not configured.", 503);
  return createClient(PROJECT_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function currentUser(req: Request, db: SupabaseClient) {
  const header = req.headers.get("authorization") ?? "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) fail("Please sign in to continue.", 401);
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) fail("Your session expired. Please sign in again.", 401);
  if (!data.user.email_confirmed_at) fail("Please verify your email address before continuing.", 403);
  return data.user;
}

function isAdmin(user: { email?: string | null; email_confirmed_at?: string | null }): boolean {
  return (user.email ?? "").toLowerCase() === ADMIN_EMAIL && !!user.email_confirmed_at;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value.normalize("NFKC").trim().toUpperCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeLabel(value: unknown): string {
  const label = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) || RESERVED.has(label)) fail("Choose a valid, non-reserved label (1–63 letters, numbers, or internal hyphens).", 422);
  return label;
}

function dnsConfigured(): boolean {
  return !!SPACESHIP_KEY && !!SPACESHIP_SECRET;
}

async function spaceship(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<Response> {
  if (!dnsConfigured()) fail("DNS publishing is not configured. The administrator must add the Spaceship API key and secret to Supabase Edge Function secrets.", 503);
  const response = await fetch(`${SPACESHIP_BASE}${path}`, {
    method,
    headers: {
      "X-API-Key": SPACESHIP_KEY,
      "X-API-Secret": SPACESHIP_SECRET,
      "Accept": "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response;
}

async function zoneRecords(): Promise<Record<string, unknown>[]> {
  const domain = encodeURIComponent(ROOT_DOMAIN);
  const collected: Record<string, unknown>[] = [];
  let skip = 0;
  let total = Number.POSITIVE_INFINITY;
  for (let page = 0; page < 10 && skip < total; page++) {
    const url = `/dns/records/${domain}?take=500&skip=${skip}&orderBy=name`;
    const response = await spaceship("GET", url);
    if (!response.ok) fail(`DNS provider read failed (HTTP ${response.status}).`, response.status === 403 ? 503 : 502);
    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    collected.push(...items);
    total = Number.isFinite(Number(data?.total)) ? Number(data.total) : collected.length;
    if (!items.length) break;
    skip += items.length;
  }
  return collected;
}

function nameFor(label: string, host: string): string {
  const suffix = `${label}.${CHILD_ZONE}`;
  return host === "@" ? suffix : `${host}.${suffix}`;
}

function zoneHasChildName(records: Record<string, unknown>[], label: string): boolean {
  const suffix = `${label}.${CHILD_ZONE}`.toLowerCase();
  return records.some((record) => {
    const name = String(record.name ?? "").replace(/\.$/, "").toLowerCase();
    return name === suffix || name.endsWith(`.${suffix}`);
  });
}

async function checkAvailability(db: SupabaseClient, rawLabel: unknown, requireZoneCheck = false) {
  const label = normalizeLabel(rawLabel);
  const { data, error } = await db.rpc("check_subdomain_availability", { p_label: label });
  if (error) fail("Could not check the name right now.", 500);
  const databaseAvailable = data?.available === true;
  if (!databaseAvailable) return { available: false, zone_checked: false, label, reason: data?.reason ?? "already_reserved" };
  if (!dnsConfigured()) {
    if (requireZoneCheck) fail("Name reservation is temporarily unavailable while DNS publishing is being configured.", 503);
    return { available: true, zone_checked: false, label };
  }
  const records = await zoneRecords();
  const zoneAvailable = !zoneHasChildName(records, label);
  return { available: zoneAvailable, zone_checked: true, label, ...(zoneAvailable ? {} : { reason: "already_in_dns_zone" }) };
}

async function requireApprovedRequest(db: SupabaseClient, requestId: unknown, userId: string) {
  const id = String(requestId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) fail("Invalid subdomain request.", 422);
  const { data, error } = await db.from("subdomain_requests")
    .select("id,user_id,label,status,expires_at")
    .eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) fail("Could not load the subdomain.", 500);
  if (!data || data.status !== "approved") fail("DNS editing is available only after your request is approved.", 403);
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) fail("This subdomain has expired. Contact the administrator before changing DNS.", 403);
  return data;
}

function validHostname(value: string): boolean {
  const target = value.replace(/\.$/, "").toLowerCase();
  if (target.length < 3 || target.length > 253 || !target.includes(".")) return false;
  return target.split(".").every((part) => part.length >= 1 && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part));
}

function validIPv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function validIPv6(value: string): boolean {
  if (!value.includes(":") || /[^0-9a-f:.]/i.test(value)) return false;
  try { new URL(`http://[${value}]/`); return true; } catch { return false; }
}

function parseDnsInput(input: Record<string, unknown>) {
  const type = String(input.type ?? "").toUpperCase();
  if (!["A", "AAAA", "CNAME", "TXT", "MX"].includes(type)) fail("Only A, AAAA, CNAME, TXT, and MX records are supported.", 422);
  const host = String(input.host ?? "@").trim().toLowerCase();
  if (host !== "@") {
    if (host.length > 190 || host.split(".").some((part) => part.length > 63 || !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/.test(part))) fail("Host must be @ or a relative hostname such as www or _acme-challenge.", 422);
  }
  const value = String(input.value ?? "").trim();
  if (!value || value.length > 2000 || /[\r\n\u0000-\u001f\u007f]/.test(value)) fail("Enter a valid record value.", 422);
  const ttl = Number(input.ttl ?? 3600);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) fail("TTL must be between 60 and 86400 seconds.", 422);
  let priority: number | null = null;
  if (type === "A" && !validIPv4(value)) fail("A records need a valid IPv4 address.", 422);
  if (type === "AAAA" && !validIPv6(value)) fail("AAAA records need a valid IPv6 address.", 422);
  if (type === "CNAME" && !validHostname(value)) fail("CNAME value must be a fully qualified hostname.", 422);
  if (type === "TXT" && value.length > 1000) fail("TXT values are limited to 1000 characters.", 422);
  if (type === "MX") {
    if (!validHostname(value)) fail("MX value must be a fully qualified mail host.", 422);
    priority = Number(input.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 65535) fail("MX priority must be between 0 and 65535.", 422);
  }
  return { type, host, value, ttl, priority };
}

function spaceshipRecord(label: string, record: { type: string; host: string; value: string; ttl?: number; priority?: number | null }) {
  const base: Record<string, unknown> = { type: record.type, name: nameFor(label, record.host) };
  if (record.ttl) base.ttl = record.ttl;
  if (record.type === "A" || record.type === "AAAA") base.address = record.value;
  if (record.type === "CNAME") base.cname = record.value;
  if (record.type === "TXT") base.value = record.value;
  if (record.type === "MX") {
    base.exchange = record.value;
    base.preference = record.priority ?? 10;
  }
  return base;
}

async function writeDns(record: Record<string, unknown>) {
  const response = await spaceship("PUT", `/dns/records/${encodeURIComponent(ROOT_DOMAIN)}`, { items: [record] });
  if (!response.ok) {
    let detail = "Spaceship rejected the DNS record.";
    try { detail = (await response.json()).detail ?? detail; } catch { /* keep generic message */ }
    fail(detail.slice(0, 240), response.status >= 500 ? 502 : 422);
  }
}

async function deleteDns(record: Record<string, unknown>) {
  const response = await spaceship("DELETE", `/dns/records/${encodeURIComponent(ROOT_DOMAIN)}`, [record]);
  if (!response.ok && response.status !== 404) fail(`Spaceship could not delete the record (HTTP ${response.status}).`, response.status >= 500 ? 502 : 422);
}

function oldDnsShape(row: Record<string, unknown>, label: string) {
  return spaceshipRecord(label, {
    type: String(row.record_type), host: String(row.host), value: String(row.value),
    ttl: Number(row.ttl), priority: row.priority == null ? null : Number(row.priority),
  });
}

async function listDashboard(db: SupabaseClient, userId: string, adminMode: boolean) {
  const baseQuery = db.from("subdomain_requests").select("id,user_id,label,status,payment_status,price_pkr,payment_reference,payment_submitted_at,review_note,approved_at,expires_at,created_at").order("created_at", { ascending: false }).limit(adminMode ? 200 : 100);
  const { data: requests, error } = adminMode ? await baseQuery : await baseQuery.eq("user_id", userId);
  if (error) fail("Could not load marketplace requests.", 500);
  const rows = requests ?? [];
  const ids = rows.map((row) => row.id);
  let records: Record<string, unknown>[] = [];
  let profiles: Record<string, unknown>[] = [];
  if (ids.length) {
    const result = await db.from("dns_records").select("id,request_id,user_id,record_type,host,value,ttl,priority,created_at,updated_at").in("request_id", ids);
    if (result.error) fail("Could not load DNS records.", 500);
    records = result.data ?? [];
  }
  if (adminMode) {
    const result = await db.from("profiles").select("id,email,display_name,created_at").order("created_at", { ascending: false }).limit(200);
    if (result.error) fail("Could not load registered accounts.", 500);
    profiles = result.data ?? [];
  }
  const emailById = new Map(profiles.map((p) => [String(p.id), String(p.email ?? "")]));
  const dashboardRequests = rows.map((row) => ({
    ...row,
    ...(adminMode ? { account_email: emailById.get(String(row.user_id)) ?? "" } : {}),
    dns_records: records.filter((record) => record.request_id === row.id),
  }));
  const users = adminMode ? profiles.map((profile) => ({
    id: String(profile.id),
    email: String(profile.email ?? ""),
    display_name: String(profile.display_name ?? ""),
    created_at: String(profile.created_at ?? ""),
    subdomains: rows.filter((row) => String(row.user_id) === String(profile.id)).map((row) => ({ label: row.label, status: row.status })),
  })) : [];
  return { requests: dashboardRequests, users };
}

function randomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `WLX-${Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("")}`;
}

function rpcMessage(error: { message?: string }): string {
  const raw = error.message ?? "Marketplace operation failed.";
  if (raw.includes("INVALID_OR_EXPIRED_PROMO")) return "That promo code is invalid, expired, or already used up.";
  if (raw.includes("LABEL_TAKEN")) return "That name was just reserved. Please try another.";
  if (raw.includes("ADMIN_REQUIRED")) return "Administrator access is required.";
  if (raw.includes("PAYMENT_NOT_SUBMITTED_OR_PROMO_NOT_VALID")) return "Payment reference or free-year approval is not ready for review.";
  if (raw.includes("REQUEST_ALREADY_REVIEWED")) return "This request has already been reviewed.";
  if (raw.includes("REQUEST_NOT_FOUND")) return "Request not found.";
  if (raw.includes("INVALID_LABEL")) return "Choose a valid subdomain label.";
  return raw.slice(0, 240);
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return respond(req, { error: "Method not allowed." }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return respond(req, { error: "Send a JSON request." }, 400); }

  try {
    const db = getClient();
    const action = String(body.action ?? "");

    if (action === "check_availability") {
      const result = await checkAvailability(db, body.label, false);
      return respond(req, result);
    }

    const user = await currentUser(req, db);
    const adminMode = isAdmin(user);

    if (action === "dashboard") {
      const dashboard = await listDashboard(db, user.id, adminMode);
      return respond(req, { user: { id: user.id, email: user.email }, is_admin: adminMode, requests: dashboard.requests, users: dashboard.users });
    }

    if (action === "request_subdomain") {
      const label = normalizeLabel(body.label);
      const availability = await checkAvailability(db, label, true);
      if (!availability.available) fail("That name is not available under domains.weblitex.com.", 409);
      const promo = String(body.promo_code ?? "").trim();
      const codeHash = promo ? await sha256Hex(promo) : null;
      const { data, error } = await db.rpc("create_marketplace_request", { p_user_id: user.id, p_label: label, p_code_hash: codeHash });
      if (error) fail(rpcMessage(error), error.message.includes("LABEL_TAKEN") ? 409 : 422);
      return respond(req, { request: data, subdomain: `${label}.domains.weblitex.com` }, 201);
    }

    if (action === "submit_payment") {
      const requestId = String(body.request_id ?? "");
      const reference = String(body.reference ?? "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._\-/]{2,119}$/.test(reference)) fail("Enter the Easypaisa transaction reference (3–120 characters).", 422);
      const { data: existing, error: loadError } = await db.from("subdomain_requests")
        .select("id,status,price_pkr").eq("id", requestId).eq("user_id", user.id).maybeSingle();
      if (loadError) fail("Could not load the request.", 500);
      if (!existing || Number(existing.price_pkr) !== 300 || !["awaiting_payment", "payment_submitted"].includes(String(existing.status))) fail("This request is not waiting for a payment reference.", 409);
      const { error } = await db.from("subdomain_requests").update({ status: "payment_submitted", payment_status: "submitted", payment_reference: reference, payment_submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", requestId).eq("user_id", user.id);
      if (error) fail("Could not submit the reference. Try again.", 500);
      return respond(req, { ok: true, message: "Reference submitted for manual review. Payment is not treated as verified until the administrator confirms it." });
    }

    if (action === "create_promo") {
      if (!adminMode) fail("Administrator access is required.", 403);
      const maxUses = Number(body.max_uses ?? 1);
      if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10000) fail("Maximum uses must be between 1 and 10,000.", 422);
      const expiresAt = body.expires_at ? new Date(String(body.expires_at)) : null;
      if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) fail("Expiry must be a future date.", 422);
      const code = randomCode();
      const codeHash = await sha256Hex(code);
      const { error } = await db.from("promo_codes").insert({ code_hash: codeHash, max_uses: maxUses, expires_at: expiresAt?.toISOString() ?? null, created_by: user.id });
      if (error) fail("Could not create the promo code.", 500);
      return respond(req, { code, max_uses: maxUses, expires_at: expiresAt?.toISOString() ?? null }, 201);
    }

    if (action === "review_request") {
      if (!adminMode) fail("Administrator access is required.", 403);
      const decision = String(body.decision ?? "");
      const requestId = String(body.request_id ?? "");
      if (decision === "approve") {
        const { data: reqRow, error: reqError } = await db.from("subdomain_requests").select("id,label,status,payment_status").eq("id", requestId).maybeSingle();
        if (reqError || !reqRow) fail("Request not found.", 404);
        const existingZoneRecords = await zoneRecords();
        if (zoneHasChildName(existingZoneRecords, reqRow.label)) fail("That child name now conflicts with an existing DNS record. Do not approve it until the conflict is resolved.", 409);
      }
      const { data, error } = await db.rpc("admin_review_request", { p_admin_id: user.id, p_request_id: requestId, p_decision: decision, p_note: String(body.note ?? "").slice(0, 500) });
      if (error) fail(rpcMessage(error), error.message.includes("REQUEST_NOT_FOUND") ? 404 : 422);
      return respond(req, { result: data });
    }

    if (action === "dns_upsert") {
      const request = await requireApprovedRequest(db, body.request_id, user.id);
      const input = parseDnsInput(body.record && typeof body.record === "object" ? body.record as Record<string, unknown> : {});
      const recordId = body.record_id ? String(body.record_id) : "";
      let old: Record<string, unknown> | null = null;
      if (recordId) {
        const { data, error } = await db.from("dns_records").select("*").eq("id", recordId).eq("request_id", request.id).eq("user_id", user.id).maybeSingle();
        if (error) fail("Could not load the DNS record.", 500);
        if (!data) fail("DNS record not found.", 404);
        old = data;
      } else {
        const { count, error } = await db.from("dns_records").select("id", { count: "exact", head: true }).eq("request_id", request.id);
        if (error) fail("Could not count DNS records.", 500);
        if ((count ?? 0) >= 50) fail("This subdomain has reached the 50-record limit.", 409);
      }
      const nextRecord = spaceshipRecord(request.label, input);
      const oldRecord = old ? oldDnsShape(old, request.label) : null;
      const identityChanged = !!old && (old.record_type !== input.type || old.host !== input.host || old.value !== input.value || old.priority !== input.priority);
      if (identityChanged && oldRecord) await deleteDns(oldRecord);
      try {
        await writeDns(nextRecord);
      } catch (error) {
        if (identityChanged && oldRecord) { try { await writeDns(oldRecord); } catch { /* report original write error */ } }
        throw error;
      }
      const row = { request_id: request.id, user_id: user.id, record_type: input.type, host: input.host, value: input.value, ttl: input.ttl, priority: input.priority, updated_at: new Date().toISOString() };
      const result = recordId
        ? await db.from("dns_records").update(row).eq("id", recordId).eq("request_id", request.id).eq("user_id", user.id).select("id,request_id,record_type,host,value,ttl,priority,created_at,updated_at").single()
        : await db.from("dns_records").insert(row).select("id,request_id,record_type,host,value,ttl,priority,created_at,updated_at").single();
      if (result.error) {
        try { await deleteDns(nextRecord); } catch { /* preserve the database error */ }
        if (identityChanged && oldRecord) { try { await writeDns(oldRecord); } catch { /* preserve the database error */ } }
        fail("The DNS provider accepted the record, but the marketplace could not save its dashboard entry. Please contact the administrator before retrying.", 500);
      }
      return respond(req, { record: result.data });
    }

    if (action === "dns_delete") {
      const request = await requireApprovedRequest(db, body.request_id, user.id);
      const recordId = String(body.record_id ?? "");
      const { data: old, error: loadError } = await db.from("dns_records").select("*").eq("id", recordId).eq("request_id", request.id).eq("user_id", user.id).maybeSingle();
      if (loadError) fail("Could not load the DNS record.", 500);
      if (!old) fail("DNS record not found.", 404);
      const oldRecord = oldDnsShape(old, request.label);
      await deleteDns(oldRecord);
      const { error } = await db.from("dns_records").delete().eq("id", recordId).eq("request_id", request.id).eq("user_id", user.id);
      if (error) {
        try { await writeDns(oldRecord); } catch { /* preserve the database error */ }
        fail("Spaceship removed the record, but the dashboard could not update. Contact the administrator before retrying.", 500);
      }
      return respond(req, { ok: true });
    }

    fail("Unknown marketplace action.", 404);
  } catch (error) {
    const status = Number((error as { status?: number }).status ?? 500);
    const message = error instanceof Error ? error.message : "Unexpected backend error.";
    return respond(req, { error: message }, status);
  }
}

Deno.serve(handle);
