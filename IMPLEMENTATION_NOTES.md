# Implementation notes and verified provider behavior

- **Pakidev inspiration only:** the inspected reference demonstrates a subdomain search, manual payment review, request approval, and managed DNS records. The Weblitex copy, brand, visual system, and page layout are original. Source reviewed: https://pakidev.com
- **Spaceship DNS API:** official docs describe API key + API secret authentication through `X-API-Key` and `X-API-Secret`, DNS read permission `dnsrecords:read`, and write permission `dnsrecords:write`. The documented endpoint is `PUT /v1/dns/records/{domain}` and `DELETE /v1/dns/records/{domain}` at `https://spaceship.dev/api`; reads are paginated. Sources: https://docs.spaceship.dev/ and https://caddyserver.com/docs/modules/dns.providers.spaceship
- **Spaceship record payloads:** a Go SDK for Spaceship documents `type`, `name`, `ttl`, `address`, `cname`, `value`, `exchange`, and `preference` as the corresponding JSON fields; its single-record create method sends a one-item `items` array, while deletion sends only the selected record. Its docs say create/upsert is idempotent by `(type, name, data)`, and conflict cases are rejected. Source: https://raw.githubusercontent.com/namecheap/go-spaceship-sdk/v0.2.1/client/dns.go
- **DNS records are isolated by construction:** all browser-supplied record names are relative. The Edge Function constructs the absolute name below the approved `label.domains` only after verifying request ownership and approval; it always calls the fixed `weblitex.com` API zone. It never accepts the zone from the client and never sends root/apex or full-zone replacement instructions.
- **Supabase Edge Function secrets:** hosted functions have built-in server-side environment variables and project secrets can be added through the Supabase dashboard or CLI. Never place the Spaceship credentials in SQL, source control, or browser config. Source: https://supabase.com/docs/guides/functions/secrets
- **Supabase Auth email:** the official SMTP guide states that the built-in sender only delivers to addresses on the project organization team, is currently limited to 2 messages/hour, and is best-effort/non-production. Custom SMTP is required for public signup verification and password recovery. Keep email confirmation enabled. Source: https://supabase.com/docs/guides/auth/auth-smtp
- **Auth redirect allowlist:** Supabase only redirects to configured URLs; the default Site URL is used when no redirect is passed. Source: https://supabase.com/docs/guides/auth/redirect-urls

No Spaceship API write was performed while building this repository. The root domain's DNS records remain unchanged pending the owner's explicit approval of the exact proposed record.

## Supabase Free plan (verified 2026-09-29)

Supabase's official pricing page currently lists the Free plan at $0/month, with 50,000 monthly active users, 500 MB database size per project, 5 GB egress plus 5 GB cached egress, 1 GB file storage, 500,000 Edge Function invocations, and 2 million Realtime messages. Free projects may pause after one week of inactivity, and the plan allows up to two active projects. See the official [pricing page](https://supabase.com/pricing) and [billing/quota guide](https://supabase.com/docs/guides/platform/billing-on-supabase); limits may change.

## Final deployment checks (2026-09-29)

- The Supabase security advisor returned no findings after migrations `002` and `003`. The performance advisor reports only unused-index informational items; the marketplace tables are new and have not received normal traffic.
- Read-only smoke tests confirmed the public availability endpoint returns HTTP 200, unauthenticated dashboard requests return HTTP 401, and anonymous direct calls to the availability/admin helper RPCs are denied.
- The owner-created repository `mkuk2013/domains-marketplace` is public; the connector now reports admin and push access. No alternate host or DNS changes were made.
- Public signup remains disabled pending custom SMTP details. Spaceship credentials have not yet been installed as Edge Function secrets; provider-zone checks, paid request creation, approvals, and DNS writes therefore remain gated.
