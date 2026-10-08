import { existsSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import net from "net";
import path from "path";
import { socksDispatcher } from "fetch-socks";
import { SocksClientError } from "socks";
import { Agent, type Dispatcher, fetch } from "undici";

/**
 * Egress routes for origin downloads: the server's own connection ("direct")
 * plus every proxy in proxy.json. Each route has its own per-origin-host
 * concurrency limit and request spacing, so adding proxies with distinct
 * external IPs multiplies download parallelism without raising the load any
 * single IP puts on an origin. Routes sharing an external IP (found by a
 * health check against PROXY_IP_CHECK_URL) are grouped and only one of them
 * is used.
 */

export const DIRECT_ROUTE_ID = "direct";

type ProxyEntry = {
  type?: string;
  hostname?: string;
  port?: number;
  region?: string;
  auth?: { id?: string; password?: string } | null;
};

export type RouteSettings = { enabled: boolean; concurrency: number };

export type RouteHealth = {
  status: "unchecked" | "ok" | "error";
  /** A check is running; `status` keeps the previous result until it ends. */
  checking?: boolean;
  externalIp?: string;
  latencyMs?: number;
  error?: string;
  checkedAt?: number;
};

type RouteStats = {
  inFlight: number;
  completed: number;
  failed: number;
  bytes: number;
  consecutiveFailures: number;
};

type Route = {
  id: string;
  kind: "direct" | "proxy";
  type: string;
  endpoint?: string;
  region?: string;
  hasAuth: boolean;
  dispatcher?: Dispatcher;
  configError?: string;
  /** proxy.json entry as JSON, to keep routes whose entry did not change. */
  signature?: string;
  settings: RouteSettings;
  health: RouteHealth;
  stats: RouteStats;
  inFlightByHost: Map<string, number>;
  inactiveReason: string | null;
};

export type RouteLease = {
  routeId: string;
  dispatcher: Dispatcher;
  /** Records the outcome and frees the slot; extra calls are ignored. */
  release(outcome: "ok" | "failed" | "network-error", bytes?: number): void;
};

type Waiter = {
  avoid?: string;
  resolve: (route: Route) => void;
  reject: (error: Error) => void;
};

/** Consecutive connection failures after which a proxy is taken out of use. */
const MAX_CONSECUTIVE_FAILURES = 3;

export function isProxyConnectError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (current instanceof SocksClientError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export class EgressPool {
  private routes: Route[] = [];

  private readonly waiters = new Map<string, Waiter[]>();

  private readonly nextAllowedAt = new Map<string, number>();

  private readonly throttleQueue = new Map<string, Promise<void>>();

  private roundRobin = 0;

  private checking: Promise<void> | null = null;

  private lastCheckedAt?: number;

  private storedSettings: Record<string, Partial<RouteSettings>> = {};

  constructor(
    private readonly options: {
      configPath: string;
      settingsPath: string;
      defaultConcurrency: number;
      minIntervalMs: number;
      ipCheckUrl: string;
      checkTimeoutMs: number;
    }
  ) {
    this.storedSettings = this.readSettingsFile();
    this.loadConfig();
  }

  /** Re-read proxy.json and rebuild routes, keeping state for unchanged ones. */
  loadConfig(): void {
    const previous = new Map(this.routes.map((route) => [route.id, route]));
    const routes: Route[] = [
      previous.get(DIRECT_ROUTE_ID) ??
        this.newRoute({
          id: DIRECT_ROUTE_ID,
          kind: "direct",
          type: "DIRECT",
          hasAuth: false,
          dispatcher: new Agent(),
        }),
    ];

    for (const [id, entry] of Object.entries(this.readConfigFile())) {
      if (id === DIRECT_ROUTE_ID) continue;
      const type = String(entry?.type ?? "").toUpperCase();
      const endpoint = `${entry?.hostname ?? "?"}:${entry?.port ?? "?"}`;
      const signature = JSON.stringify(entry);
      const old = previous.get(id);
      if (old && old.signature === signature) {
        routes.push(old);
        continue;
      }
      void old?.dispatcher?.close().catch(() => undefined);

      let dispatcher: Dispatcher | undefined;
      let configError: string | undefined;
      if (type !== "SOCKS5" && type !== "SOCKS4") {
        configError = `Unsupported proxy type: ${entry?.type ?? "(missing)"}`;
      } else if (!entry.hostname || !Number.isInteger(entry.port)) {
        configError = "hostname and port are required";
      } else {
        dispatcher = socksDispatcher({
          type: type === "SOCKS5" ? 5 : 4,
          host: entry.hostname,
          port: entry.port as number,
          userId: entry.auth?.id,
          password: entry.auth?.password,
        });
      }
      const route = this.newRoute({
        id,
        kind: "proxy",
        type,
        endpoint,
        region: entry?.region,
        hasAuth: Boolean(entry?.auth),
        dispatcher,
        configError,
      });
      route.signature = signature;
      if (configError) route.health = { status: "error", error: configError };
      routes.push(route);
    }

    for (const old of previous.values()) {
      if (!routes.includes(old)) void old.dispatcher?.close().catch(() => undefined);
    }
    this.routes = routes;
    this.recompute();
  }

  /** Checks routes (all by default) and resolves when every check finished. */
  async check(ids?: string[]): Promise<void> {
    if (this.checking) await this.checking;
    const targets = this.routes.filter(
      (route) => !route.configError && (!ids || ids.includes(route.id))
    );
    for (const route of targets) route.health = { ...route.health, checking: true };
    this.checking = Promise.all(targets.map((route) => this.checkRoute(route))).then(
      () => {
        this.lastCheckedAt = Date.now();
        this.checking = null;
        this.recompute();
      }
    );
    this.recompute();
    await this.checking;
  }

  async updateSettings(id: string, patch: Partial<RouteSettings>): Promise<boolean> {
    const route = this.routes.find((item) => item.id === id);
    if (!route) return false;
    if (typeof patch.enabled === "boolean") route.settings.enabled = patch.enabled;
    if (Number.isInteger(patch.concurrency) && (patch.concurrency as number) >= 1) {
      route.settings.concurrency = patch.concurrency as number;
    }
    this.storedSettings[id] = { ...route.settings };
    await writeFile(
      this.options.settingsPath,
      `${JSON.stringify({ routes: this.storedSettings }, null, 2)}\n`
    );
    this.recompute();
    return true;
  }

  snapshot() {
    const activeRoutes = this.routes.filter((route) => route.inactiveReason === null);
    return {
      configPath: this.options.configPath,
      ipCheckUrl: this.options.ipCheckUrl,
      checking: this.checking !== null,
      lastCheckedAt: this.lastCheckedAt,
      activeRoutes: activeRoutes.length,
      totalConcurrencyPerHost: activeRoutes.reduce(
        (sum, route) => sum + route.settings.concurrency,
        0
      ),
      routes: this.routes.map((route) => ({
        id: route.id,
        kind: route.kind,
        type: route.type,
        endpoint: route.endpoint,
        region: route.region,
        hasAuth: route.hasAuth,
        settings: route.settings,
        health: route.health,
        active: route.inactiveReason === null,
        inactiveReason: route.inactiveReason,
        stats: {
          inFlight: route.stats.inFlight,
          completed: route.stats.completed,
          failed: route.stats.failed,
          bytes: route.stats.bytes,
        },
      })),
    };
  }

  /**
   * Waits for a free slot for `host` on an active route and applies that
   * route's request spacing. `avoid` steers a retry away from the route that
   * just failed when another one is available.
   */
  async acquire(host: string, avoid?: string): Promise<RouteLease> {
    if (!this.routes.some((route) => route.inactiveReason === null) && this.checking) {
      await this.checking;
    }
    const route = await new Promise<Route>((resolve, reject) => {
      const free = this.pickRoute(host, avoid);
      if (free) {
        this.take(free, host);
        resolve(free);
        return;
      }
      if (!this.routes.some((item) => item.inactiveReason === null)) {
        reject(new Error("No active download route (check proxy settings)"));
        return;
      }
      const queue = this.waiters.get(host) ?? [];
      queue.push({ avoid, resolve, reject });
      this.waiters.set(host, queue);
    });
    await this.throttle(route.id, host);

    let released = false;
    return {
      routeId: route.id,
      dispatcher: route.dispatcher as Dispatcher,
      release: (outcome, bytes = 0) => {
        if (released) return;
        released = true;
        this.finish(route, host, outcome, bytes);
      },
    };
  }

  private newRoute(
    base: Pick<Route, "id" | "kind" | "type" | "hasAuth"> &
      Partial<Pick<Route, "endpoint" | "region" | "dispatcher" | "configError">>
  ): Route {
    const stored = this.storedSettings[base.id] ?? {};
    return {
      ...base,
      settings: {
        enabled: stored.enabled ?? true,
        concurrency:
          Number.isInteger(stored.concurrency) && (stored.concurrency as number) >= 1
            ? (stored.concurrency as number)
            : this.options.defaultConcurrency,
      },
      health: { status: "unchecked" },
      stats: { inFlight: 0, completed: 0, failed: 0, bytes: 0, consecutiveFailures: 0 },
      inFlightByHost: new Map(),
      inactiveReason: "unchecked",
    };
  }

  private readConfigFile(): Record<string, ProxyEntry> {
    if (!existsSync(this.options.configPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.options.configPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected an object of name -> proxy");
      }
      return parsed as Record<string, ProxyEntry>;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `Ignoring ${this.options.configPath}: ${error instanceof Error ? error.message : error}`
      );
      return {};
    }
  }

  private readSettingsFile(): Record<string, Partial<RouteSettings>> {
    if (!existsSync(this.options.settingsPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.options.settingsPath, "utf8")) as {
        routes?: Record<string, Partial<RouteSettings>>;
      };
      return parsed.routes ?? {};
    } catch {
      return {};
    }
  }

  private async checkRoute(route: Route): Promise<void> {
    const started = Date.now();
    try {
      const res = await fetch(this.options.ipCheckUrl, {
        dispatcher: route.dispatcher,
        signal: AbortSignal.timeout(this.options.checkTimeoutMs),
        headers: { "User-Agent": "curl/8" },
      });
      if (!res.ok) throw new Error(`IP check returned HTTP ${res.status}`);
      const ip = (await res.text()).trim();
      if (!net.isIP(ip)) throw new Error(`IP check returned no IP: ${ip.slice(0, 60)}`);
      route.health = {
        status: "ok",
        externalIp: ip,
        latencyMs: Date.now() - started,
        checkedAt: Date.now(),
      };
      route.stats.consecutiveFailures = 0;
    } catch (error) {
      const cause = (error as { cause?: unknown })?.cause;
      const message =
        cause instanceof Error
          ? cause.message
          : error instanceof Error
            ? error.message
            : String(error);
      route.health = { status: "error", error: message, checkedAt: Date.now() };
    }
  }

  /**
   * Active routes: enabled, healthy (direct is used even when its IP check
   * failed), and the first of each external-IP group. Within a group direct
   * wins, then the lowest latency, then the name.
   */
  private recompute(): void {
    const groups = new Map<string, Route[]>();
    for (const route of this.routes) {
      if (!route.settings.enabled) {
        route.inactiveReason = "disabled";
      } else if (route.kind === "proxy" && route.health.status !== "ok") {
        route.inactiveReason = route.health.status === "error" ? "unhealthy" : "unchecked";
      } else {
        route.inactiveReason = null;
        const ip = route.health.externalIp;
        if (ip) groups.set(ip, [...(groups.get(ip) ?? []), route]);
      }
    }
    for (const members of groups.values()) {
      members.sort(
        (a, b) =>
          Number(b.kind === "direct") - Number(a.kind === "direct") ||
          (a.health.latencyMs ?? Infinity) - (b.health.latencyMs ?? Infinity) ||
          a.id.localeCompare(b.id)
      );
      for (const duplicate of members.slice(1)) {
        duplicate.inactiveReason = `same IP as ${members[0].id}`;
      }
    }
    this.drainAll();
  }

  private pickRoute(host: string, avoid?: string): Route | undefined {
    const candidates = this.routes.filter(
      (route) =>
        route.inactiveReason === null &&
        (route.inFlightByHost.get(host) ?? 0) < route.settings.concurrency
    );
    if (candidates.length === 0) return undefined;
    const preferred = candidates.filter((route) => route.id !== avoid);
    const pool = preferred.length > 0 ? preferred : candidates;
    // Least loaded relative to its limit; round-robin breaks ties.
    this.roundRobin = (this.roundRobin + 1) % pool.length;
    const rotated = [...pool.slice(this.roundRobin), ...pool.slice(0, this.roundRobin)];
    return rotated.reduce((best, route) =>
      (route.inFlightByHost.get(host) ?? 0) / route.settings.concurrency <
      (best.inFlightByHost.get(host) ?? 0) / best.settings.concurrency
        ? route
        : best
    );
  }

  private take(route: Route, host: string): void {
    route.inFlightByHost.set(host, (route.inFlightByHost.get(host) ?? 0) + 1);
    route.stats.inFlight += 1;
  }

  private finish(
    route: Route,
    host: string,
    outcome: "ok" | "failed" | "network-error",
    bytes: number
  ): void {
    const remaining = (route.inFlightByHost.get(host) ?? 1) - 1;
    if (remaining > 0) route.inFlightByHost.set(host, remaining);
    else route.inFlightByHost.delete(host);
    route.stats.inFlight -= 1;
    route.stats.bytes += bytes;
    if (outcome === "ok") {
      route.stats.completed += 1;
      route.stats.consecutiveFailures = 0;
    } else {
      route.stats.failed += 1;
    }
    if (outcome === "network-error" && route.kind === "proxy") {
      route.stats.consecutiveFailures += 1;
      if (
        route.stats.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
        route.health.status === "ok"
      ) {
        route.health = {
          ...route.health,
          status: "error",
          error: `${route.stats.consecutiveFailures} consecutive connection failures`,
          checkedAt: Date.now(),
        };
        // eslint-disable-next-line no-console
        console.warn(
          `[${new Date().toISOString()}] proxy-disabled ${route.id}: ${route.health.error}`
        );
        this.recompute();
        return;
      }
    }
    this.drain(host);
  }

  private drainAll(): void {
    for (const host of [...this.waiters.keys()]) this.drain(host);
  }

  private drain(host: string): void {
    const queue = this.waiters.get(host);
    if (!queue) return;
    if (!this.routes.some((route) => route.inactiveReason === null)) {
      this.waiters.delete(host);
      for (const waiter of queue) {
        waiter.reject(new Error("No active download route (check proxy settings)"));
      }
      return;
    }
    while (queue.length > 0) {
      const route = this.pickRoute(host, queue[0].avoid);
      if (!route) break;
      const waiter = queue.shift() as Waiter;
      this.take(route, host);
      waiter.resolve(route);
    }
    if (queue.length === 0) this.waiters.delete(host);
  }

  /** Spaces request starts per (route, host) by ORIGIN_MIN_INTERVAL_MS. */
  private async throttle(routeId: string, host: string): Promise<void> {
    const interval = this.options.minIntervalMs;
    if (!Number.isFinite(interval) || interval <= 0) return;
    const key = `${routeId} ${host}`;
    const previous = this.throttleQueue.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.throttleQueue.set(key, previous.then(() => current));
    await previous;
    try {
      const waitMs = Math.max(0, (this.nextAllowedAt.get(key) ?? 0) - Date.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.nextAllowedAt.set(key, Date.now() + interval);
    } finally {
      release();
      if (this.throttleQueue.get(key) === current) this.throttleQueue.delete(key);
    }
  }
}

export function egressPoolFromEnv(defaults: {
  defaultConcurrency: number;
  minIntervalMs: number;
}): EgressPool {
  return new EgressPool({
    configPath: path.resolve(process.env.PROXY_CONFIG || "proxy.json"),
    settingsPath: path.resolve(process.env.PROXY_SETTINGS || "proxy-settings.json"),
    ipCheckUrl: process.env.PROXY_IP_CHECK_URL || "https://ifconfig.me/ip",
    checkTimeoutMs: Number(process.env.PROXY_CHECK_TIMEOUT_MS || "15000") || 15_000,
    ...defaults,
  });
}
