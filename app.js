const $ = (selector) => document.querySelector(selector);
const AUTH_STORAGE_KEY = "cloudexify.server.auth.v1";
const REFRESH_INTERVAL_MS = 15000;
let refreshInFlight = null;
const state = { selectedNodeId: null, config: null, session: null, user: null, tenants: [], tenantId: null, page: "overview", data: { nodes: [], applications: [], deployments: [], jobs: [] }, timer: null, loading: false };

export const pageMeta = {
  overview: ["Overview", "Infrastructure overview", "Live status from your registered infrastructure."],
  nodes: ["Compute nodes", "Compute nodes", "Devices enrolled with your control plane."],
  applications: ["Applications", "Hosted applications", "Applications registered in this workspace."],
  deployments: ["Deployments", "Deployment history", "Deployment records stored in your database."],
  jobs: ["Jobs", "Node jobs", "Diagnostic jobs and their current execution state."]
};
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const formatDate = (value) => value ? new Date(value).toLocaleString() : "—";
const formatBytes = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "—";
  if (number < 1024 ** 3) return (number / 1024 ** 2).toFixed(0) + " MB";
  return (number / 1024 ** 3).toFixed(1) + " GB";
};
function message(text, error = false) {
  const element = $("#auth-message");
  if (element) { element.textContent = text; element.classList.toggle("error", error); }
}
function dashboardMessage(text, error = false) {
  const element = $("#dashboard-message");
  if (!element) return;
  element.hidden = !text;
  element.textContent = text || "";
  element.classList.toggle("error-notice", error);
}
function readSession() {
  try { return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null"); } catch { return null; }
}
function saveSession(session) {
  state.session = session;
  if (session) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  else localStorage.removeItem(AUTH_STORAGE_KEY);
}
async function authRequest(path, body, accessToken = null) {
  const response = await fetch(state.config.supabaseUrl.replace(/\/$/, "") + "/auth/v1/" + path, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: state.config.supabasePublishableKey, ...(accessToken ? { authorization: "Bearer " + accessToken } : {}) },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.msg || result.message || result.error_description || "Authentication request failed.");
  return result;
}
async function signIn(email, password) {
  const result = await authRequest("token?grant_type=password", { email, password });
  if (!result.access_token || !result.refresh_token || !result.user?.id) throw new Error("Supabase Auth returned an incomplete session.");
  saveSession({ access_token: result.access_token, refresh_token: result.refresh_token, expires_at: Math.floor(Date.now() / 1000) + Number(result.expires_in || 3600), user: result.user });
  return result.user;
}
async function ensureFreshSession() {
  if (!state.session?.access_token || !state.session?.refresh_token) throw new Error("Please sign in again.");
  if (Number(state.session.expires_at || 0) > Math.floor(Date.now() / 1000) + 90) return state.session;
  if (!refreshInFlight) {
    const refreshToken = state.session.refresh_token;
    refreshInFlight = authRequest("token?grant_type=refresh_token", { refresh_token: refreshToken })
      .then((result) => {
        if (!result.access_token || !result.refresh_token) throw new Error("Session refresh failed. Please sign in again.");
        saveSession({ access_token: result.access_token, refresh_token: result.refresh_token, expires_at: Math.floor(Date.now() / 1000) + Number(result.expires_in || 3600), user: result.user || state.session?.user });
        return state.session;
      }).catch((error) => { saveSession(null); throw error; })
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}
async function api(path, options = {}) {
  await ensureFreshSession();
  const response = await fetch(path, { ...options, headers: { ...(options.headers || {}), authorization: "Bearer " + state.session.access_token, ...(options.body ? { "content-type": "application/json" } : {}) }, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) { saveSession(null); throw new Error("Your session expired. Please sign in again."); }
  if (!response.ok) throw new Error(payload.error?.message || "Request failed (" + response.status + ").");
  return payload;
}
async function signOut() {
  try { if (state.session?.access_token) await authRequest("logout", {}, state.session.access_token); } catch { /* Local sign-out still clears this browser session. */ }
  if (state.timer) clearInterval(state.timer);
  saveSession(null);
  state.user = null;
  state.tenants = [];
  state.tenantId = null;
  $("#app-view").hidden = true;
  $("#auth-view").hidden = false;
  message("You have been signed out.");
}
function renderLogin() {
  $("#app-view").hidden = true;
  $("#auth-view").hidden = false;
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#login-button");
    button.disabled = true;
    message("Signing in…");
    try {
      const user = await signIn($("#login-email").value.trim(), $("#login-password").value);
      state.user = user;
      await openDashboard();
    } catch (error) {
      saveSession(null);
      $("#app-view").hidden = true;
      $("#auth-view").hidden = false;
      message(error.message || "Unable to sign in.", true);
    }
    finally { button.disabled = false; }
  });
}
async function loadTenants() {
  const result = await api("/api/v1/tenants");
  state.tenants = Array.isArray(result.tenants) ? result.tenants : [];
  if (!state.tenants.some((tenant) => tenant.id === state.tenantId)) state.tenantId = state.tenants[0]?.id || null;
  const select = $("#tenant-select");
  select.innerHTML = state.tenants.map((tenant) => '<option value="' + escapeHtml(tenant.id) + '">' + escapeHtml(tenant.name) + " · " + escapeHtml(tenant.role) + "</option>").join("");
  select.disabled = state.tenants.length < 2;
  if (state.tenantId) select.value = state.tenantId;
  $("#workspace-name").textContent = state.tenants.find((tenant) => tenant.id === state.tenantId)?.name || "No workspace";
}
async function loadData() {
  if (!state.tenantId) {
    state.data = { nodes: [], applications: [], deployments: [], jobs: [] };
    renderPage();
    dashboardMessage("Your account is authenticated, but it has no active Cloudexify workspace membership. Ask an Owner to provision your user and tenant membership.");
    return;
  }
  const base = "/api/v1/tenants/" + encodeURIComponent(state.tenantId);
  const [nodes, applications, deployments, jobs] = await Promise.all([
    api(base + "/nodes"), api(base + "/applications"), api(base + "/deployments"), api(base + "/jobs")
  ]);
  state.data = {
    nodes: Array.isArray(nodes.nodes) ? nodes.nodes : [],
    applications: Array.isArray(applications.applications) ? applications.applications : [],
    deployments: Array.isArray(deployments.deployments) ? deployments.deployments : [],
    jobs: Array.isArray(jobs.jobs) ? jobs.jobs : []
  };
  dashboardMessage("");
  $("#last-updated").textContent = "Updated " + new Date().toLocaleTimeString();
  renderPage();
}
function metric(label, value, foot) {
  return '<article class="metric-card"><div class="metric-top"><span>' + escapeHtml(label) + '</span><span class="metric-icon purple">◈</span></div><div class="metric-value">' + escapeHtml(value) + '</div><div class="metric-foot">' + escapeHtml(foot) + "</div></article>";
}
function status(value) {
  const safe = String(value || "unknown").toLowerCase();
  const healthy = ["online", "running", "healthy", "succeeded", "completed"].includes(safe);
  return '<span class="status ' + (healthy ? "" : "offline") + '">' + escapeHtml(value || "Unknown") + "</span>";
}
function table(headers, rows, empty) {
  if (!rows.length) return '<div class="empty-state">' + escapeHtml(empty) + "</div>";
  return "<table><thead><tr>" + headers.map((header) => "<th>" + escapeHtml(header) + "</th>").join("") + "</tr></thead><tbody>" + rows.join("") + "</tbody></table>";
}
function nodeRows(nodes) {
  const role = state.tenants.find((tenant) => tenant.id === state.tenantId)?.role;
  const canManage = ["owner", "admin"].includes(role);
  return nodes.map((node) => {
    const resources = node.resources || {};
    const cpu = resources.cpu_percent == null ? "—" : Number(resources.cpu_percent).toFixed(1) + "% CPU";
    const memory = resources.memory_total_bytes == null ? "—" : formatBytes(resources.memory_used_bytes) + " / " + formatBytes(resources.memory_total_bytes);
    const battery = resources.battery_percent == null ? "" : " · " + Number(resources.battery_percent).toFixed(0) + "% battery";
    const temperature = resources.temperature_c == null ? "" : " · " + Number(resources.temperature_c).toFixed(1) + "°C";
    const actions = canManage && node.status === "pending"
      ? '<div class="node-actions"><button type="button" class="small-action" data-node-action="approve" data-node-id="' + escapeHtml(node.id) + '">Approve</button><button type="button" class="small-action" data-node-action="reject" data-node-id="' + escapeHtml(node.id) + '">Reject</button></div>'
      : "";
    return '<tr class="node-row" tabindex="0" data-node-open="' + escapeHtml(node.id) + '"><td><strong>' + escapeHtml(node.name) + '<small class="subcell">' + escapeHtml(node.id) + "</small></td><td>" + escapeHtml(node.platform) + " · " + escapeHtml(node.architecture) + "</td><td>" + cpu + " · " + memory + battery + temperature + "</td><td>" + status(node.status) + '</td><td>' + escapeHtml(formatDate(node.last_seen_at)) + actions + "</td></tr>";
  });
}
function applicationRows(apps) {
  return apps.map((app) => "<tr><td>" + escapeHtml(app.name) + '<small class="subcell">' + escapeHtml(app.id) + "</small></td><td>" + escapeHtml(app.desired_state) + "</td><td>" + escapeHtml(formatDate(app.updated_at || app.created_at)) + "</td></tr>");
}
function deploymentRows(items) {
  return items.map((item) => "<tr><td>" + escapeHtml(item.revision) + "</td><td>" + escapeHtml(item.application_id) + "</td><td>" + escapeHtml(item.desired_state) + "</td><td>" + status(item.status) + "</td><td>" + escapeHtml(formatDate(item.created_at)) + "</td></tr>");
}
function jobRows(items) {
  return items.map((item) => "<tr><td>" + escapeHtml(item.type) + "</td><td>" + escapeHtml(item.node_id) + "</td><td>" + status(item.status) + "</td><td>" + escapeHtml(item.attempt_count) + "</td><td>" + escapeHtml(formatDate(item.updated_at || item.created_at)) + "</td></tr>");
}
function renderNodeDetails(nodeId) {
  const node = state.data.nodes.find((item) => item.id === nodeId);
  if (!node) return;
  const r = node.resources || {};
  const items = [
    ["CPU usage", r.cpu_percent == null ? "Not reported" : Number(r.cpu_percent).toFixed(1) + "%"],
    ["Memory used", r.memory_used_bytes == null ? "Not reported" : formatBytes(r.memory_used_bytes)],
    ["Memory total", r.memory_total_bytes == null ? "Not reported" : formatBytes(r.memory_total_bytes)],
    ["Storage available", r.disk_available_bytes == null ? "Not reported" : formatBytes(r.disk_available_bytes)],
    ["Storage total", r.disk_total_bytes == null ? "Not reported" : formatBytes(r.disk_total_bytes)],
    ["Load average", r.load_1m == null ? "Not reported" : Number(r.load_1m).toFixed(2)],
    ["Uptime", r.uptime_seconds == null ? "Not reported" : Math.floor(r.uptime_seconds / 3600) + " hours"],
    ["Battery", r.battery_percent == null ? "Not reported" : Number(r.battery_percent).toFixed(0) + "%"],
    ["Temperature", r.temperature_c == null ? "Not reported" : Number(r.temperature_c).toFixed(1) + " °C"]
  ];
  let panel = $("#node-details");
  if (!panel) { panel = document.createElement("section"); panel.id = "node-details"; panel.className = "panel node-details"; $("#table-content").after(panel); }
  panel.hidden = false;
  panel.innerHTML = '<div class="panel-heading"><div><h2>' + escapeHtml(node.name) + '</h2><p>' + escapeHtml(node.id) + '</p></div><button class="secondary-btn" id="close-node-details" type="button">Close</button></div><div class="node-detail-grid"><div><span>STATUS</span><b>' + escapeHtml(node.status) + '</b></div><div><span>PLATFORM</span><b>' + escapeHtml(node.platform) + ' · ' + escapeHtml(node.architecture) + '</b></div><div><span>AGENT VERSION</span><b>' + escapeHtml(node.agent_version || "—") + '</b></div><div><span>LAST HEARTBEAT</span><b>' + escapeHtml(formatDate(node.last_seen_at)) + '</b></div>' + items.map(([label,value]) => '<div><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b></div>').join("") + '</div>';
  $("#close-node-details").addEventListener("click", () => { panel.hidden = true; state.selectedNodeId = null; });
}
function renderPage() {
  const [navTitle, title, subtitle] = pageMeta[state.page] || pageMeta.overview;
  $("#breadcrumb-page").textContent = navTitle;
  $("#page-eyebrow").textContent = navTitle.toUpperCase();
  $("#page-title").textContent = title;
  $("#page-subtitle").textContent = subtitle;
  document.querySelectorAll("[data-page]").forEach((link) => link.classList.toggle("active", link.dataset.page === state.page));
  const { nodes, applications, deployments, jobs } = state.data;
  const currentRole = state.tenants.find((tenant) => tenant.id === state.tenantId)?.role;
  const enrollmentButton = $("#create-enrollment-button");
  if (enrollmentButton) enrollmentButton.hidden = !(state.page === "nodes" && ["owner", "admin"].includes(currentRole));

  const online = nodes.filter((node) => node.status === "online").length;
  const running = applications.filter((app) => app.desired_state === "running").length;
  const metrics = state.page === "overview"
    ? metric("Online nodes", online + " / " + nodes.length, "Based on server-side heartbeat status") + metric("Applications", applications.length, running + " configured to run") + metric("Deployments", deployments.length, "Stored deployment revisions") + metric("Jobs", jobs.length, "Queued and historical node jobs")
    : "";
  $("#metric-grid").innerHTML = metrics;
  const config = {
    overview: ["Compute nodes", "Latest node heartbeat and resource reports", table(["NODE", "PLATFORM", "RESOURCES", "STATUS", "LAST SEEN"], nodeRows(nodes.slice(0, 8)), "No nodes registered in this workspace.")],
    nodes: ["Compute nodes", "All registered compute nodes", table(["NODE", "PLATFORM", "RESOURCES", "STATUS", "LAST SEEN"], nodeRows(nodes), "No nodes registered in this workspace.")],
    applications: ["Applications", "Applications stored in the control-plane database", table(["APPLICATION", "DESIRED STATE", "UPDATED"], applicationRows(applications), "No applications registered in this workspace.")],
    deployments: ["Deployments", "Persisted deployment revisions", table(["REVISION", "APPLICATION ID", "DESIRED STATE", "STATUS", "CREATED"], deploymentRows(deployments), "No deployments recorded in this workspace.")],
    jobs: ["Node jobs", "Diagnostic job queue and execution state", table(["TYPE", "NODE ID", "STATUS", "ATTEMPTS", "UPDATED"], jobRows(jobs), "No jobs recorded in this workspace.")]
  }[state.page] || null;
  $("#table-title").textContent = config[0];
  $("#table-subtitle").textContent = config[1];
  $("#table-content").innerHTML = config[2];
  const diagnosticButton = $("#create-diagnostic-job");
  if (diagnosticButton) diagnosticButton.hidden = !(state.page === "jobs" && ["owner", "admin"].includes(currentRole) && nodes.some((node) => node.status === "online"));
  if (state.page === "nodes" && state.selectedNodeId) renderNodeDetails(state.selectedNodeId);
}
async function refreshData() {
  if (state.loading || !state.session) return;
  state.loading = true;
  $("#refresh-button").disabled = true;
  try { await loadData(); }
  catch (error) { dashboardMessage(error.message || "Unable to load workspace data.", true); }
  finally { state.loading = false; $("#refresh-button").disabled = false; }
}
async function openDashboard() {
  const user = await api("/api/v1/auth/me");
  state.user = user.user || state.session.user;
  $("#profile-name").textContent = state.user.display_name || state.user.email || "Account";
  $("#profile-email").textContent = state.user.email || "";
  $("#profile-avatar").textContent = (state.user.display_name || state.user.email || "C").slice(0, 1).toUpperCase();
  await loadTenants();
  await loadData();
  $("#auth-view").hidden = true;
  $("#app-view").hidden = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(refreshData, REFRESH_INTERVAL_MS);
}
async function init() {
  const configResponse = await fetch("/api/config", { cache: "no-store" });
  state.config = await configResponse.json();
  if (!state.config.authConfigured) {
    message("Supabase Auth is not configured. Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in Vercel.");
    $("#login-button").disabled = true;
    renderLogin();
    return;
  }
  renderLogin();
  state.session = readSession();
  if (state.session?.access_token && state.session?.refresh_token) {
    try { await ensureFreshSession(); await openDashboard(); }
    catch (error) { saveSession(null); $("#app-view").hidden = true; $("#auth-view").hidden = false; message(error.message || "Please sign in again.", true); }
  }
  $("#signout-button").addEventListener("click", signOut);
  $("#refresh-button").addEventListener("click", refreshData);
  $("#create-enrollment-button").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button.disabled || !state.tenantId) return;
    button.disabled = true;
    try {
      const result = await api("/api/v1/tenants/" + encodeURIComponent(state.tenantId) + "/enrollment-tokens", {
        method: "POST", body: JSON.stringify({ expires_in_minutes: 30 })
      });
      const token = result.enrollment_token?.token;
      if (!token) throw new Error("The API did not return an enrollment token.");
      window.prompt("Copy this one-time enrollment token. It will not be shown again. Expires: " + new Date(result.enrollment_token.expires_at).toLocaleString(), token);
      dashboardMessage("A one-time enrollment token was created. Use it on the Android/Termux device within 30 minutes.");
    } catch (error) {
      dashboardMessage(error.message || "Unable to create enrollment token.", true);
    } finally { button.disabled = false; }
  });
  $("#table-content").addEventListener("click", async (event) => {
    const row = event.target.closest("[data-node-open]");
    if (row && !event.target.closest("[data-node-action]")) { state.selectedNodeId = row.dataset.nodeOpen; renderNodeDetails(state.selectedNodeId); return; }
    const button = event.target.closest("[data-node-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.nodeAction;
    const nodeId = button.dataset.nodeId;
    if (!["approve", "reject"].includes(action) || !nodeId) return;
    if (action === "reject" && !window.confirm("Reject this node? Its current credentials will be revoked and it cannot reconnect.")) return;
    button.disabled = true;
    try {
      await api("/api/v1/tenants/" + encodeURIComponent(state.tenantId) + "/nodes/" + encodeURIComponent(nodeId) + "/" + action, { method: "POST" });
      dashboardMessage(action === "approve" ? "Node approved." : "Node rejected and its credentials revoked.");
      await refreshData();
    } catch (error) {
      dashboardMessage(error.message || "Unable to update node approval.", true);
      button.disabled = false;
    }
  });
  $("#create-diagnostic-job").addEventListener("click", async () => {
    const node = state.data.nodes.find((item) => item.status === "online");
    if (!node) { dashboardMessage("No online node is available for diagnostics.", true); return; }
    const type = window.prompt("Enter diagnostic type: probe or collect_metrics", "collect_metrics");
    if (!["probe", "collect_metrics"].includes(String(type || "").trim())) return;
    const button = $("#create-diagnostic-job"); button.disabled = true;
    try {
      await api("/api/v1/tenants/" + encodeURIComponent(state.tenantId) + "/jobs", { method: "POST", body: JSON.stringify({ node_id: node.id, type: String(type).trim(), payload: {}, idempotency_key: "dashboard-" + crypto.randomUUID() }) });
      dashboardMessage(type + " job queued for " + node.name + ".");
      await refreshData();
    } catch (error) { dashboardMessage(error.message || "Unable to queue diagnostic job.", true); }
    finally { button.disabled = false; }
  });
  $("#tenant-select").addEventListener("change", async (event) => {
    state.tenantId = event.target.value;
    $("#workspace-name").textContent = state.tenants.find((tenant) => tenant.id === state.tenantId)?.name || "Workspace";
    await refreshData();
  });
  document.querySelectorAll("[data-page]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault(); state.page = link.dataset.page; renderPage();
    if (window.innerWidth < 900) $("#sidebar").classList.remove("open");
  }));
  $("#menu-btn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
}
init().catch((error) => { message(error.message || "Dashboard initialization failed.", true); });
