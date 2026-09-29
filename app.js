import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { APP_CONFIG } from "./config.js";

const supabase = createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.publishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const authDialog = $("#authDialog");
const portalDialog = $("#portalDialog");
let currentUser = null;
let currentSession = null;
let isAdmin = false;
let pendingLabel = "";
let authMode = "signin";
let toastTimer;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function domainFor(label) { return `${label}.weblitex.com`; }

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function setNote(element, message, kind = "") {
  element.textContent = message;
  element.className = `form-note${kind ? ` ${kind}` : ""}`;
}

async function callApi(action, values = {}) {
  const { data, error } = await supabase.functions.invoke(APP_CONFIG.functionName, { body: { action, ...values } });
  if (error) {
    let message = error.message || "The request could not be completed.";
    try {
      const response = error.context;
      if (response && typeof response.json === "function") {
        const payload = await response.json();
        message = payload.error || payload.message || message;
      }
    } catch { /* keep the safe generic message */ }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

function openAuth() {
  if (!authDialog.open) authDialog.showModal();
  setTimeout(() => $("#authEmail").focus(), 40);
}

function openPortal() {
  if (!currentUser) { openAuth(); return; }
  if (!portalDialog.open) portalDialog.showModal();
  refreshDashboard();
  if (pendingLabel) showClaimPanel(pendingLabel);
}

function showClaimPanel(label) {
  pendingLabel = label;
  $("#claimDomain").textContent = domainFor(label);
  $("#claimPriceText").textContent = "PKR 300 per year, or use an admin-issued free-year code. Your request stays pending while an administrator reviews payment and confirms name availability. DNS provisioning happens only after approval.";
  $("#claimPanel").hidden = true;
  if (!currentUser) { openAuth(); return; }
  $("#claimPanel").hidden = false;
  $("#claimForm").reset();
}

function updateSignupState() {
  const canSignUp = APP_CONFIG.publicSignupEnabled;
  $("#toggleAuthMode").disabled = !canSignUp;
  $("#toggleAuthMode").textContent = canSignUp ? (authMode === "signin" ? "Create an account" : "I already have an account") : "Public signup is not open yet";
  $("#authIntro").textContent = canSignUp
    ? "Use your email and password to open your Weblitex Domains dashboard."
    : "Sign in with your existing Weblitex account. Public registration will open after verified email delivery is configured.";
  $("#resetPassword").disabled = !APP_CONFIG.publicSignupEnabled;
}

function statusLabel(status) {
  return ({
    awaiting_payment: "Pending · payment needed",
    payment_submitted: "Pending · admin review",
    review_pending: "Pending · admin review",
    approved: "Approved",
    denied: "Denied",
    cancelled: "Cancelled",
  })[status] || status.replaceAll("_", " ");
}

function statusClass(status) { return `status-${String(status).replace(/[^a-z_]/g, "")}`; }

function renderDns(request) {
  const records = request.dns_records || [];
  const rows = records.length ? records.map((record) => `
    <div class="dns-item">
      <span class="dns-type-pill">${esc(record.record_type)}</span>
      <span><code>${esc(record.host === "@" ? request.label : `${record.host}.${request.label}`)}.weblitex.com</code>${record.record_type === "MX" ? ` · ${esc(record.priority)}` : ""}</span>
      <code>${esc(record.value)}</code>
      <span class="dns-actions"><button type="button" data-edit-record="${esc(record.id)}" data-request="${esc(request.id)}">Edit</button><button type="button" data-delete-record="${esc(record.id)}" data-request="${esc(request.id)}">Delete</button></span>
    </div>`).join("") : `<p class="dns-empty">No records yet. Add the destination you want this name to resolve to.</p>`;
  const form = APP_CONFIG.dnsPublishingExpected ? `
    <form class="dns-form" data-dns-form="${esc(request.id)}">
      <label>Type<select name="type"><option>A</option><option>AAAA</option><option>CNAME</option><option>TXT</option><option>MX</option></select></label>
      <label>Host (relative)<input name="host" value="@" maxlength="190" placeholder="@ or www" required></label>
      <label>Value<input name="value" maxlength="2000" placeholder="IP / hostname / text" required></label>
      <label>TTL<input name="ttl" type="number" min="60" max="86400" value="3600" required></label>
      <label>MX priority<input name="priority" type="number" min="0" max="65535" value="10"></label>
      <button class="button button-primary" type="submit">Add record</button>
      <input type="hidden" name="record_id" value="">
    </form>` : `<p class="dns-empty">DNS publishing is paused until the administrator completes provider setup.</p>`;
  return `<div class="dns-management"><strong>DNS records for ${esc(domainFor(request.label))}</strong><p class="dns-empty">Host is relative to your purchased name: @ means the name itself, and www means a name such as www.ali.weblitex.com. The backend writes only names within the fixed weblitex.com zone.</p><div class="dns-list">${rows}</div>${form}</div>`;
}

function paymentMarkup(request) {
  if (Number(request.price_pkr) === 0 || request.payment_status === "waived") return `<div class="payment-instructions"><p><strong>Free first year.</strong> No payment is due; the administrator still needs to review and approve the request.</p></div>`;
  if (request.status === "awaiting_payment" || request.status === "payment_submitted") {
    const instructions = `<div class="payment-instructions"><p>Send <strong>PKR 300</strong> using Easypaisa to <strong>03363268833</strong> · <strong>Mukesh Kumar</strong>.</p><p>Payment is manual. Submitting a reference is not confirmation that funds arrived.</p></div>`;
    if (request.status === "payment_submitted") return `${instructions}<p class="request-meta">Reference submitted: <code>${esc(request.payment_reference)}</code>. Waiting for an administrator to verify it.</p>`;
    return `${instructions}<form class="payment-form" data-payment-form="${esc(request.id)}"><input name="reference" maxlength="120" placeholder="Easypaisa transaction reference" autocomplete="off" required><button class="button button-primary" type="submit">Submit reference</button></form>`;
  }
  return "";
}

function renderRequest(request, adminCard = false) {
  const meta = adminCard ? `<p class="request-meta">Account: ${esc(request.account_email || "")}${request.payment_reference ? ` · Reference: <code>${esc(request.payment_reference)}</code>` : ""}</p>` : `<p class="request-meta">${Number(request.price_pkr) === 0 ? "First year waived by promo" : `PKR ${esc(request.price_pkr)} / year`} · Created ${new Date(request.created_at).toLocaleDateString()}</p>`;
  const actions = adminCard && ["awaiting_payment", "payment_submitted", "review_pending"].includes(request.status)
    ? `<div class="admin-request-actions">${["payment_submitted", "review_pending"].includes(request.status) ? `<button type="button" class="button button-primary" data-review="approve" data-request="${esc(request.id)}">Approve request</button>` : ""}<button type="button" class="button button-deny" data-review="deny" data-request="${esc(request.id)}">Deny request</button></div>`
    : "";
  const pendingNote = ["awaiting_payment", "payment_submitted", "review_pending"].includes(request.status)
    ? `<p class="request-meta">This request is pending administrator payment and name-availability review. DNS provisioning happens only after approval.</p>`
    : "";
  const details = adminCard ? `<p class="request-meta">Status: ${esc(request.payment_status)}${request.review_note ? ` · Note: ${esc(request.review_note)}` : ""}</p>` : `${paymentMarkup(request)}${pendingNote}`;
  const approved = request.status === "approved" ? `<div class="request-footer"><span>Approved · valid until ${request.expires_at ? new Date(request.expires_at).toLocaleDateString() : "renewal date pending"}</span><span>Manage below ↓</span></div>${renderDns(request)}` : "";
  return `<article class="request-card"><div class="request-card-top"><div><h4 class="request-name">${esc(domainFor(request.label))}</h4>${meta}</div><span class="status-badge ${statusClass(request.status)}">${esc(statusLabel(request.status))}</span></div>${details}${actions}${approved}</article>`;
}

async function refreshDashboard() {
  if (!currentUser) return;
  $("#portalIdentity").textContent = currentUser.email || "Signed in";
  $("#portalMessage").textContent = "Loading your requests…";
  try {
    const data = await callApi("dashboard");
    isAdmin = !!data.is_admin;
    const own = (data.requests || []).filter((request) => request.user_id === currentUser.id);
    $("#requestList").innerHTML = own.length ? own.map((request) => renderRequest(request)).join("") : `<div class="request-card"><p class="request-meta">You have no subdomain requests yet. Search above to find a name.</p></div>`;
    $("#adminSection").hidden = !isAdmin;
    $("#adminRequests").innerHTML = isAdmin
      ? ((data.requests || []).length ? data.requests.map((request) => renderRequest(request, true)).join("") : `<div class="request-card"><p class="request-meta">No requests to review.</p></div>`)
      : "";
    $("#adminUsers").innerHTML = isAdmin
      ? ((data.users || []).length ? data.users.map((account) => {
        const names = (account.subdomains || []).length
          ? account.subdomains.map((entry) => `<span><code>${esc(domainFor(entry.label))}</code> · ${esc(statusLabel(entry.status))}</span>`).join("")
          : `<span class="admin-user-no-domains">No subdomain requests yet</span>`;
        return `<article class="admin-user-row"><div class="admin-user-heading"><strong>${esc(account.email || "Unknown email")}</strong><small>Joined ${new Date(account.created_at).toLocaleDateString()}</small></div><div class="admin-user-domains">${names}</div></article>`;
      }).join("") : `<p class="request-meta">No registered accounts yet.</p>`)
      : "";
    $("#portalMessage").textContent = isAdmin ? "Administrator access is enabled for the confirmed owner account." : "Requests, payment references, and DNS records are visible only to your signed-in account.";
  } catch (error) {
    $("#portalMessage").textContent = error.message;
    $("#requestList").innerHTML = "";
  }
}

function showAvailability(result) {
  const node = $("#searchResult");
  node.hidden = false;
  node.className = `search-result ${result.available ? "ok" : "bad"}`;
  if (!result.available) {
    const label = result.label || "That name";
    const message = result.reason === "already_in_dns_zone"
      ? `An existing provider-zone DNS record conflicts with ${esc(domainFor(label))}. Try another prefix.`
      : result.reason === "invalid_or_reserved"
        ? `${esc(label)} is not a valid marketplace prefix. Try another label.`
        : `A conflicting marketplace request already exists for ${esc(domainFor(label))}. Try another prefix.`;
    node.innerHTML = `<strong>${message}</strong>`;
    return;
  }
  const providerNote = result.zone_checked
    ? "A provider-zone check found no matching DNS record."
    : "Provider-zone availability has not been verified.";
  node.innerHTML = `<strong>No conflicting marketplace request was found for ${esc(domainFor(result.label))}.</strong> ${providerNote} An administrator reviews payment and name availability; DNS provisioning happens only after approval. <button type="button" data-claim-label="${esc(result.label)}">Request this prefix →</button>`;
}

$("#searchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const label = $("#labelInput").value.trim().toLowerCase();
  const button = $("#checkButton");
  button.disabled = true;
  button.textContent = "Checking…";
  $("#searchResult").hidden = true;
  try {
    const result = await callApi("check_availability", { label });
    showAvailability(result);
  } catch (error) {
    showAvailability({ available: false, label });
    $("#searchResult").innerHTML = `<strong>We couldn’t check that name right now.</strong> ${esc(error.message)}`;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Check name <span aria-hidden="true">→</span>';
  }
});

$("#searchResult").addEventListener("click", (event) => {
  const button = event.target.closest("[data-claim-label]");
  if (!button) return;
  pendingLabel = button.dataset.claimLabel;
  if (!currentUser) openAuth();
  else openPortal();
});

$("#claimForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser || !pendingLabel) return;
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = await callApi("request_subdomain", { label: pendingLabel, promo_code: form.elements.promo_code.value.trim() });
    pendingLabel = "";
    $("#claimPanel").hidden = true;
    showToast(data.request?.price_pkr === 0 ? "Free-year request is pending administrator payment and availability review." : "Pending request created. Submit your Easypaisa reference for admin review.");
    await refreshDashboard();
  } catch (error) {
    $("#portalMessage").textContent = error.message;
  } finally { button.disabled = false; }
});

$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("#authEmail").value.trim();
  const password = $("#authPassword").value;
  const note = $("#authNote");
  const submit = $("#authSubmit");
  submit.disabled = true;
  setNote(note, authMode === "signin" ? "Signing in…" : "Creating account…");
  try {
    if (authMode === "signup" && !APP_CONFIG.publicSignupEnabled) throw new Error("Public signup is paused until a verified production email sender is configured.");
    if (authMode === "signin") {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      currentSession = data.session;
      currentUser = data.user;
      setNote(note, "Signed in. Opening your dashboard…", "success");
      authDialog.close();
      openPortal();
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}${location.pathname}` } });
      if (error) throw error;
      if (data.session) {
        currentSession = data.session;
        currentUser = data.user;
        authDialog.close();
        openPortal();
      } else {
        setNote(note, "Check your inbox to confirm your email, then sign in.", "success");
      }
    }
  } catch (error) { setNote(note, error.message, "error"); }
  finally { submit.disabled = false; }
});

$("#toggleAuthMode").addEventListener("click", () => {
  if (!APP_CONFIG.publicSignupEnabled) return;
  authMode = authMode === "signin" ? "signup" : "signin";
  $("#authTitle").innerHTML = authMode === "signin" ? "Sign in <em>to continue.</em>" : "Make it <em>yours.</em>";
  $("#authSubmit").innerHTML = authMode === "signin" ? 'Sign in <span aria-hidden="true">→</span>' : 'Create account <span aria-hidden="true">→</span>';
  $("#authPassword").autocomplete = authMode === "signin" ? "current-password" : "new-password";
  updateSignupState();
  setNote($("#authNote"), "");
});

$("#resetPassword").addEventListener("click", async () => {
  if (!APP_CONFIG.publicSignupEnabled) { setNote($("#authNote"), "Password recovery will be available when verified email delivery is configured.", "error"); return; }
  const email = $("#authEmail").value.trim();
  if (!email) { setNote($("#authNote"), "Enter your email address first.", "error"); return; }
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}${location.pathname}` });
  setNote($("#authNote"), error ? error.message : "If an account exists, a reset link has been sent.", error ? "error" : "success");
});

$("#portalSignOut").addEventListener("click", async () => {
  const { error } = await supabase.auth.signOut();
  if (error) showToast(error.message);
  currentUser = null; currentSession = null; isAdmin = false;
  portalDialog.close();
  showToast("Signed out.");
});

$("#requestList").addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-payment-form]");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector("button"); button.disabled = true;
  try {
    await callApi("submit_payment", { request_id: form.dataset.paymentForm, reference: form.elements.reference.value.trim() });
    showToast("Reference sent to the administrator for manual verification.");
    await refreshDashboard();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

$("#requestList").addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-dns-form]");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector("button[type=submit]"); button.disabled = true;
  const type = form.elements.type.value;
  try {
    await callApi("dns_upsert", {
      request_id: form.dataset.dnsForm,
      record_id: form.elements.record_id.value || null,
      record: {
        type,
        host: form.elements.host.value.trim() || "@",
        value: form.elements.value.value.trim(),
        ttl: Number(form.elements.ttl.value),
        priority: type === "MX" ? Number(form.elements.priority.value || 10) : null,
      },
    });
    showToast("DNS record published.");
    await refreshDashboard();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

$("#requestList").addEventListener("change", (event) => {
  const form = event.target.closest("[data-dns-form]");
  if (!form || event.target.name !== "type") return;
  const priority = form.elements.priority;
  priority.disabled = event.target.value !== "MX";
  priority.closest("label").style.opacity = event.target.value === "MX" ? "1" : ".45";
});

$("#requestList").addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-record]");
  if (editButton) {
    const form = $(`[data-dns-form="${CSS.escape(editButton.dataset.request)}"]`);
    if (!form) { showToast("DNS editing is paused until provider setup is complete."); return; }
    const record = (await callApi("dashboard")).requests.flatMap((request) => request.dns_records || []).find((item) => item.id === editButton.dataset.editRecord);
    if (!record) { showToast("Record not found. Refresh and try again."); return; }
    form.elements.record_id.value = record.id;
    form.elements.type.value = record.record_type;
    form.elements.host.value = record.host;
    form.elements.value.value = record.value;
    form.elements.ttl.value = record.ttl;
    form.elements.priority.value = record.priority ?? 10;
    form.querySelector("button[type=submit]").textContent = "Save record";
    form.elements.priority.disabled = record.record_type !== "MX";
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const deleteButton = event.target.closest("[data-delete-record]");
  if (!deleteButton) return;
  if (!APP_CONFIG.dnsPublishingExpected) { showToast("DNS publishing is paused during setup."); return; }
  if (!confirm("Delete this DNS record from Spaceship?")) return;
  deleteButton.disabled = true;
  try {
    await callApi("dns_delete", { request_id: deleteButton.dataset.request, record_id: deleteButton.dataset.deleteRecord });
    showToast("DNS record deleted.");
    await refreshDashboard();
  } catch (error) { showToast(error.message); deleteButton.disabled = false; }
});

$("#adminRequests").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-review]");
  if (!button) return;
  const decision = button.dataset.review;
  const note = decision === "deny" ? (prompt("Optional note for this request:") || "") : "";
  if (decision === "deny" && !confirm("Deny this request? Any submitted payment is not automatically refunded.")) return;
  button.disabled = true;
  try {
    await callApi("review_request", { request_id: button.dataset.request, decision, note });
    showToast(decision === "approve" ? "Request approved. DNS editing is now available to the owner." : "Request denied.");
    await refreshDashboard();
  } catch (error) { showToast(error.message); button.disabled = false; }
});

$("#promoForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button"); button.disabled = true;
  try {
    const maxUses = Number(form.elements.max_uses.value);
    const expiresAt = form.elements.expires_at.value ? new Date(`${form.elements.expires_at.value}T23:59:59`).toISOString() : null;
    const data = await callApi("create_promo", { max_uses: maxUses, expires_at: expiresAt });
    const created = $("#promoCreated");
    created.hidden = false;
    created.innerHTML = `<strong>Copy this code now. It is stored as a hash and will not be shown again.</strong><code>${esc(data.code)}</code><span>First year free · up to ${esc(data.max_uses)} use(s)</span>`;
    showToast("Free-year code created.");
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

$("#signInTop").addEventListener("click", () => currentUser ? openPortal() : openAuth());
$("#signInFooter").addEventListener("click", () => currentUser ? openPortal() : openAuth());
$("#openDashboardDns").addEventListener("click", openPortal);
$("#startClaim").addEventListener("click", () => { $("#labelInput").focus(); window.scrollTo({ top: 0, behavior: "smooth" }); });
$("#contactAdmin").addEventListener("click", () => { location.href = "mailto:mkuk2013@gmail.com?subject=Weblitex%20Domains%20question"; });

$$("[data-close]").forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
[authDialog, portalDialog].forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); }));

$("#mobileMenu").addEventListener("click", () => {
  const nav = $(".main-nav");
  const open = nav.classList.toggle("open");
  $("#mobileMenu").setAttribute("aria-expanded", String(open));
});
$$(".main-nav a").forEach((link) => link.addEventListener("click", () => { $(".main-nav").classList.remove("open"); $("#mobileMenu").setAttribute("aria-expanded", "false"); }));

async function boot() {
  updateSignupState();
  if (!APP_CONFIG.publicSignupEnabled || !APP_CONFIG.dnsPublishingExpected) $("#setupBanner").hidden = false;
  const { data } = await supabase.auth.getSession();
  currentSession = data.session;
  currentUser = data.session?.user ?? null;
  supabase.auth.onAuthStateChange((_event, session) => {
    currentSession = session;
    currentUser = session?.user ?? null;
    if (currentUser && portalDialog.open) refreshDashboard();
  });
  if (currentUser) { $("#signInTop").innerHTML = "My dashboard <span aria-hidden=\"true\">↗</span>"; }
  if (location.hash.includes("access_token") || location.search.includes("code=")) {
    setTimeout(() => { window.history.replaceState({}, document.title, location.pathname); }, 1000);
  }
}

boot();
