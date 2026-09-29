# Weblitex Domains

A mobile-first marketplace for **one product only: a prefix subdomain directly under the registered root `weblitex.com`**. A buyer enters a single label such as `ali`; the app always appends `.weblitex.com`, yielding `ali.weblitex.com`. The product is not `ali.domains.weblitex.com`, and buyers do not enter or choose a root domain. The original static site uses Supabase Auth, Postgres, and one Edge Function.

## What the site supports

- Public label availability checks against marketplace reservations and, once securely configured, the fixed Spaceship `weblitex.com` zone.
- Email/password sign-in. Public signup remains disabled until production SMTP delivery is configured and tested.
- A request price of PKR 300 per year, or an admin-created promo code that waives the first year. All requests still need admin review and approval.
- Manual Easypaisa instructions: send PKR 300 to **03363268833 · Mukesh Kumar**, then submit the transaction reference. A submitted reference is not proof of payment; an administrator verifies it manually.
- Buyer-managed A, AAAA, CNAME, TXT, and MX records after approval. Buyers can manage only records for their own approved prefix; each request is bound to its authenticated owner.
- Admin review and promo-code creation only for the confirmed `mkuk2013@gmail.com` account, checked in both the Edge Function and the server-only review RPC.
- The supplied `assets/weblitex-logo.jpg` is used in the site header/footer and as the source for the ICO, PNG, and Apple touch favicons.

## Product and DNS boundary

The buyer submits only a DNS label (1–63 lowercase letters, digits, or internal hyphens). The server fixes the provider zone to `weblitex.com`; it never accepts a user-supplied root domain or DNS zone. In Spaceship, record names are relative to that root zone: for the purchased prefix `ali`, the buyer's host `@` maps to record name `ali`, and host `www` maps to `www.ali`. The corresponding names are `ali.weblitex.com` and `www.ali.weblitex.com`. A full-zone replacement, the `weblitex.com` apex, and another buyer's names are never targeted.

The DNS API uses the fixed Spaceship base `https://spaceship.dev/api/v1`, checks only the fixed root zone, and sends one-record PUT/DELETE operations. Every record write/delete first verifies that the caller owns an approved, unexpired request. Host input is parsed as a relative name below that request's prefix; no client-provided domain is used to build the API path or record name.

## Current deployment readiness

The approved public repository is `mkuk2013/domains-marketplace`; the GitHub Pages path URL is `https://mkuk2013.github.io/domains-marketplace/`. The Supabase project is `hrslcotlxirarjqbjnmd` in `ap-south-1`; migration `005` restores the original `mkuk2013@gmail.com` address in both database admin checks after migration `004`. The `marketplace` Edge Function is active. Public signup remains paused; the SMTP settings form is still pending. Spaceship secrets have **not** been installed as Supabase Edge Function secrets, so provider-zone checks, request submission, payment review actions that require a zone check, and DNS publishing remain gated. The public config flags `publicSignupEnabled` and `dnsPublishingExpected` stay `false`.

The repository's existing `CNAME` file is for the marketplace website's separate Pages address `domains.weblitex.com`; it is not the product suffix. That file is unchanged. No records in the `weblitex.com` DNS zone were changed for this update. Do not alter any root-zone DNS records without first showing the exact proposed records and obtaining the owner's explicit confirmation.

## Deployment

1. For a fresh Supabase project, apply migrations `202609290001_marketplace.sql`, `202609290002_security_performance.sql`, `202609290003_server_only_admin_access.sql`, `202609290004_update_marketplace_admin_email.sql`, and `202609290005_restore_original_admin_email.sql` in order. Migration `005` is the forward-only update that restores both database admin checks to the original confirmed owner address.
2. Deploy `supabase/functions/marketplace/index.ts` together with `supabase/functions/marketplace/admin-access.mjs` as the `marketplace` Edge Function. Keep gateway JWT verification disabled only because the function performs its own Supabase user-token verification; do not remove that user check.
3. When separately authorized and ready, install `SPACESHIP_API_KEY` and `SPACESHIP_API_SECRET` as Supabase Edge Function secrets. Never put either value in browser config, SQL, source control, issues, or logs.
4. Configure and test a custom SMTP sender in Supabase Auth; keep email confirmation enabled. Allow the GitHub Pages URL for auth redirects. Any additional site redirect or DNS change requires its own review and approval.
5. Keep `publicSignupEnabled` off until verified email delivery is ready. Keep `dnsPublishingExpected` off until the provider secrets and zone check are set up and the owner has expressly approved the exact DNS changes involved.
6. GitHub Pages publishes from the `main` branch root of `mkuk2013/domains-marketplace`. The path URL remains `https://mkuk2013.github.io/domains-marketplace/`.

## Local preview and operational notes

Serve this directory from a local HTTP server (for example, `python3 -m http.server 5500`) and open it in a browser. `http://localhost:5500` and the GitHub Pages origin are included in the Edge Function CORS allowlist. The browser uses only the project's public publishable key; privileged database and DNS operations stay server-side. Run the regression checks with `node --test tests/*.test.mjs`.

- A requested name is one direct child of the registered `weblitex.com` root, not an independently registered domain.
- DNS editing is available only after admin approval and only to the owner of that request.
- Promo codes are generated by the Edge Function; only SHA-256 hashes are stored. The plaintext code is returned once to the administrator.
- A denied request does not automatically refund a submitted payment; payment handling remains a human decision.
- The app imposes a 50-record per-subdomain limit and TTLs from 60 through 86,400 seconds.
- `IMPLEMENTATION_NOTES.md` records provider behavior and the DNS-safety boundary.
