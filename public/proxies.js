const rowsEl = document.getElementById("routeRows");
const summaryEl = document.getElementById("routeSummary");
const statusEl = document.getElementById("status");
const checkAllButton = document.getElementById("checkAllButton");

const REFRESH_INTERVAL_MS = 2000;
// Rows are rebuilt on refresh except while the user edits a concurrency box.
let editingRouteId = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "";
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function healthText(health) {
  const suffix = health.checking ? " (checking…)" : "";
  if (health.status === "ok") return `OK ${health.latencyMs ?? "?"}ms${suffix}`;
  if (health.status === "error") return `Error: ${health.error ?? "unknown"}${suffix}`;
  return health.checking ? "Checking…" : "Not checked";
}

function cell(content, className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  if (content instanceof Node) td.appendChild(content);
  else td.textContent = content;
  return td;
}

async function request(method, url, body) {
  const response = await fetch(url, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function updateRoute(id, patch) {
  try {
    render(await request("PATCH", `/api/proxies/${encodeURIComponent(id)}`, patch));
    setStatus(`Saved ${id}.`);
  } catch (error) {
    setStatus(`Could not save ${id}: ${error.message}`, true);
    void refresh();
  }
}

async function checkRoutes(ids) {
  checkAllButton.disabled = true;
  setStatus(ids ? `Checking ${ids.join(", ")}…` : "Reloading proxy.json and checking all routes…");
  try {
    render(await request("POST", "/api/proxies/check", ids ? { ids } : {}));
    setStatus("Check finished.");
  } catch (error) {
    setStatus(`Check failed: ${error.message}`, true);
  } finally {
    checkAllButton.disabled = false;
  }
}

function render(state) {
  if (editingRouteId !== null) return;
  summaryEl.textContent =
    `${state.activeRoutes} active route(s) · up to ${state.totalConcurrencyPerHost}` +
    ` concurrent downloads per origin host` +
    (state.lastCheckedAt
      ? ` · last check ${new Date(state.lastCheckedAt).toLocaleTimeString()}`
      : "") +
    (state.checking ? " · checking…" : "");

  rowsEl.replaceChildren(
    ...state.routes.map((route) => {
      const tr = document.createElement("tr");
      tr.dataset.active = String(route.active);

      const name = document.createElement("div");
      name.className = "route-name";
      name.textContent = route.id;
      const detail = document.createElement("div");
      detail.className = "route-detail";
      detail.textContent = [route.type, route.region, route.hasAuth ? "auth" : ""]
        .filter(Boolean)
        .join(" · ");

      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = route.settings.enabled;
      enabled.addEventListener("change", () =>
        void updateRoute(route.id, { enabled: enabled.checked })
      );

      const concurrency = document.createElement("input");
      concurrency.type = "number";
      concurrency.min = "1";
      concurrency.step = "1";
      concurrency.value = String(route.settings.concurrency);
      concurrency.className = "concurrency-input";
      concurrency.addEventListener("focus", () => {
        editingRouteId = route.id;
      });
      concurrency.addEventListener("blur", () => {
        editingRouteId = null;
      });
      concurrency.addEventListener("change", () => {
        const value = Number(concurrency.value);
        editingRouteId = null;
        if (!Number.isInteger(value) || value < 1) {
          setStatus("Concurrency must be an integer of 1 or more.", true);
          void refresh();
          return;
        }
        void updateRoute(route.id, { concurrency: value });
      });

      const checkButton = document.createElement("button");
      checkButton.type = "button";
      checkButton.className = "secondary small";
      checkButton.textContent = "Check";
      checkButton.disabled = route.health.checking === true;
      checkButton.addEventListener("click", () => void checkRoutes([route.id]));

      const nameCell = document.createElement("div");
      nameCell.append(name, detail);
      tr.append(
        cell(nameCell),
        cell(route.endpoint || "—", "mono"),
        cell(healthText(route.health), `health-${route.health.status}`),
        cell(route.health.externalIp || "—", "mono"),
        cell(route.active ? "In use" : route.inactiveReason, route.active ? "use-active" : "use-idle"),
        cell(enabled),
        cell(concurrency),
        cell(String(route.stats.inFlight)),
        cell(`${route.stats.completed} / ${route.stats.failed}`),
        cell(formatBytes(route.stats.bytes)),
        cell(checkButton)
      );
      return tr;
    })
  );
}

async function refresh() {
  try {
    render(await request("GET", "/api/proxies"));
  } catch (error) {
    setStatus(`Could not load routes: ${error.message}`, true);
  }
}

checkAllButton.addEventListener("click", () => void checkRoutes());
void refresh();
setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
