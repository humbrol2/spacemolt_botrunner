import { log, logError } from "./ui.js";

export interface ApiSession {
  id: string;
  playerId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApiResponse {
  result?: unknown;
  notifications?: unknown[];
  session?: ApiSession;
  error?: { code: string; message: string; wait_seconds?: number } | null;
}

const DEFAULT_BASE_URL = "https://game.spacemolt.com/api/v1";

// Commands with sub-actions that route through v2 endpoints instead of v1.
// v1: POST /api/v1/{command} { action: "sub", ...params }
// v2: POST /api/v2/spacemolt_{command}/{action} { ...params }
const V2_ROUTED_COMMANDS = new Set(["facility"]);

// Commands that always route directly to v2 (no sub-action needed).
// v2: POST /api/v2/spacemolt_{command} { ...params }
// These return enriched data (e.g. v2_get_ship returns full module objects).
const V2_DIRECT_COMMANDS = new Set([
  "v2_get_ship", "v2_get_cargo", "v2_get_player",
  "v2_get_queue", "v2_get_skills", "v2_get_missions",
]);
const MAX_RECONNECT_ATTEMPTS = 6;
const RECONNECT_BASE_DELAY = 5_000; // 5s, 10s, 20s, 40s, 80s, 160s

export class SpaceMoltAPI {
  readonly baseUrl: string;
  private session: ApiSession | null = null;
  private v2Session: ApiSession | null = null;
  private credentials: { username: string; password: string } | null = null;
  private _rateLimitRetries = 0;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.SPACEMOLT_URL || DEFAULT_BASE_URL;
  }

  setCredentials(username: string, password: string): void {
    this.credentials = { username, password };
  }

  getSession(): ApiSession | null {
    return this.session;
  }

  /** Check if a command will route to a v2 endpoint. */
  private isV2Command(command: string, payload?: Record<string, unknown>): boolean {
    return V2_DIRECT_COMMANDS.has(command)
      || (V2_ROUTED_COMMANDS.has(command) && !!payload?.action && typeof payload.action === "string");
  }

  async execute(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    const needsV2 = this.isV2Command(command, payload);
    try {
      await this.ensureSession();
      if (needsV2) await this.ensureV2Session();
    } catch {
      return { error: { code: "connection_failed", message: "Could not connect to server" } };
    }

    let resp: ApiResponse;
    try {
      resp = await this.doRequest(command, payload);
    } catch {
      // Network error — server may have restarted mid-request
      log("system", "Connection lost, reconnecting...");
      this.session = null;
      this.v2Session = null;
      try {
        await this.ensureSession();
        if (needsV2) await this.ensureV2Session();
        resp = await this.doRequest(command, payload);
      } catch {
        return { error: { code: "connection_failed", message: "Could not reconnect to server" } };
      }
    }

    // Handle session/auth errors by refreshing and retrying
    if (resp.error) {
      const code = resp.error.code;

      if (code === "rate_limited") {
        const secs = resp.error.wait_seconds || 10;
        this._rateLimitRetries++;
        if (this._rateLimitRetries >= 5) {
          log("error", `Rate limited ${this._rateLimitRetries} times, giving up on ${command}`);
          this._rateLimitRetries = 0;
          return resp;
        }
        log("wait", `Rate limited — sleeping ${secs}s... (retry ${this._rateLimitRetries}/5)`);
        await sleep(Math.ceil(secs * 1000));
        return this.execute(command, payload);
      }

      if (code === "session_invalid" || code === "session_expired" || code === "not_authenticated") {
        log("system", `Session expired (${needsV2 ? "v2" : "v1"}), refreshing...`);
        if (needsV2) {
          this.v2Session = null;
          await this.ensureV2Session();
        } else {
          this.session = null;
          await this.ensureSession();
        }
        return this.doRequest(command, payload);
      }
    }

    // Reset rate-limit counter on success
    this._rateLimitRetries = 0;

    // Update session info from response
    if (resp.session) {
      if (needsV2) {
        this.v2Session = resp.session;
      } else {
        this.session = resp.session;
      }
    }

    return resp;
  }

  private async ensureSession(): Promise<void> {
    if (this.session && !this.isSessionExpiring()) return;

    log("system", this.session ? "Renewing session..." : "Creating new session...");

    // Retry with backoff — server may be restarting
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(`${this.baseUrl}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        if (!resp.ok) {
          throw new Error(`Failed to create session: ${resp.status} ${resp.statusText}`);
        }

        const data = (await resp.json()) as ApiResponse;
        if (data.session) {
          this.session = data.session;
          log("system", `Session created: ${this.session.id.slice(0, 8)}...`);
        } else {
          throw new Error("No session in response");
        }

        // Re-authenticate if we have credentials
        if (this.credentials) {
          log("system", `Logging in as ${this.credentials.username}...`);
          const loginResp = await this.doRequest("login", {
            username: this.credentials.username,
            password: this.credentials.password,
          });
          if (loginResp.error) {
            logError(`Login failed: ${loginResp.error.message}`);
          } else {
            log("system", "Logged in successfully");
          }
          // Login may return a new session — capture it
          if (loginResp.session) {
            this.session = loginResp.session;
          }
        }
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempt);
        log("system", `Server unreachable (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS}), retrying in ${delay / 1000}s...`);
        await sleep(delay);
      }
    }
    throw lastError || new Error("Failed to connect to server");
  }

  private isSessionExpiring(): boolean {
    if (!this.session) return true;
    const expiresAt = new Date(this.session.expiresAt).getTime();
    const now = Date.now();
    return expiresAt - now < 60_000; // Less than 60s remaining
  }

  private isV2SessionExpiring(): boolean {
    if (!this.v2Session) return true;
    const expiresAt = new Date(this.v2Session.expiresAt).getTime();
    const now = Date.now();
    return expiresAt - now < 60_000;
  }

  /** Create and authenticate a v2 session (separate session store from v1). */
  private async ensureV2Session(): Promise<void> {
    if (this.v2Session && !this.isV2SessionExpiring()) return;

    const v2Base = this.baseUrl.replace("/api/v1", "/api/v2");
    log("system", this.v2Session ? "Renewing v2 session..." : "Creating v2 session...");

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(`${v2Base}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        if (!resp.ok) {
          throw new Error(`Failed to create v2 session: ${resp.status} ${resp.statusText}`);
        }

        const data = (await resp.json()) as ApiResponse;
        if (data.session) {
          // Normalize v2 snake_case fields
          const s = data.session as Record<string, unknown>;
          if (s.created_at && !s.createdAt) {
            s.createdAt = s.created_at;
            s.expiresAt = s.expires_at;
            s.playerId = s.player_id;
          }
          this.v2Session = data.session;
          log("system", `v2 session created: ${this.v2Session.id.slice(0, 8)}...`);
        } else {
          throw new Error("No session in v2 response");
        }

        // Authenticate on v2
        if (this.credentials) {
          const loginResp = await fetch(`${v2Base}/spacemolt_auth/login`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Session-Id": this.v2Session.id,
            },
            body: JSON.stringify({
              username: this.credentials.username,
              password: this.credentials.password,
            }),
          });

          const loginData = (await loginResp.json()) as ApiResponse & { structuredContent?: unknown };
          if (loginData.structuredContent !== undefined) {
            loginData.result = loginData.structuredContent;
          }
          if (loginData.error) {
            logError(`v2 login failed: ${loginData.error.message}`);
          } else {
            log("system", "v2 session authenticated");
          }
          // Capture updated session from login response
          if (loginData.session) {
            const ls = loginData.session as Record<string, unknown>;
            if (ls.created_at && !ls.createdAt) {
              ls.createdAt = ls.created_at;
              ls.expiresAt = ls.expires_at;
              ls.playerId = ls.player_id;
            }
            this.v2Session = loginData.session;
          }
        }
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempt);
        log("system", `v2 server unreachable (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS}), retrying in ${delay / 1000}s...`);
        await sleep(delay);
      }
    }
    throw lastError || new Error("Failed to connect to v2 server");
  }

  private async doRequest(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    // Route commands with sub-actions through v2 endpoints where each action
    // is a separate path: /api/v2/spacemolt_{command}/{action}
    // This fixes facility commands where v1 doesn't pass parameters correctly.
    let url: string;
    let body = payload;

    if (V2_DIRECT_COMMANDS.has(command)) {
      // Route directly to v2 endpoint (no sub-action)
      // Strip v2_ prefix from command name — it's just a naming convention,
      // the actual endpoint is /api/v2/spacemolt_{base_command}
      const v2Base = this.baseUrl.replace("/api/v1", "/api/v2");
      const v2Command = command.replace(/^v2_/, "");
      url = `${v2Base}/spacemolt_${v2Command}`;
    } else if (payload?.action && typeof payload.action === "string" && V2_ROUTED_COMMANDS.has(command)) {
      const action = payload.action as string;
      const v2Base = this.baseUrl.replace("/api/v1", "/api/v2");
      url = `${v2Base}/spacemolt_${command}/${action}`;
      // Keep full payload in body — v2 endpoint needs all params for validation
      body = payload;
    } else {
      url = `${this.baseUrl}/${command}`;
    }

    // Use v2 session for v2 endpoints, v1 session for v1
    const isV2 = url.includes("/api/v2/");
    const activeSession = isV2 ? this.v2Session : this.session;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (activeSession) {
      headers["X-Session-Id"] = activeSession.id;
    }

    // fetch() only throws on network errors (DNS, connection refused, etc.)
    // Any HTTP response — even 4xx/5xx — means the server is reachable.
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // 401 = session gone (server restarted, etc.) — return as session error
    if (resp.status === 401) {
      return {
        error: { code: "session_invalid", message: "Unauthorized — session lost" },
      };
    }

    // Try to parse JSON for any status code. If the server returned an HTTP
    // response (even an error), the connection is fine — don't throw.
    try {
      const data = (await resp.json()) as ApiResponse & { structuredContent?: unknown };
      // v2 returns structured data in structuredContent; prefer it over result
      // (v2 result is a human-readable text summary, structuredContent is the raw JSON)
      if (data.structuredContent !== undefined) {
        data.result = data.structuredContent;
      }
      // Normalize v2 session fields (snake_case → camelCase)
      if (data.session) {
        const s = data.session as Record<string, unknown>;
        if (s.created_at && !s.createdAt) {
          s.createdAt = s.created_at;
          s.expiresAt = s.expires_at;
          s.playerId = s.player_id;
        }
      }
      return data as ApiResponse;
    } catch {
      // Non-JSON response (e.g. HTML error page, empty body)
      return {
        error: { code: "http_error", message: `HTTP ${resp.status}: ${resp.statusText}` },
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
