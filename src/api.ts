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

export class SpaceMoltAPI {
  private baseUrl: string;
  private session: ApiSession | null = null;
  private credentials: { username: string; password: string } | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.SPACEMOLT_URL || DEFAULT_BASE_URL;
  }

  setCredentials(username: string, password: string): void {
    this.credentials = { username, password };
  }

  getSession(): ApiSession | null {
    return this.session;
  }

  async execute(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    await this.ensureSession();

    const resp = await this.doRequest(command, payload);

    // Handle session errors by refreshing and retrying
    if (resp.error) {
      const code = resp.error.code;

      if (code === "rate_limited" && resp.error.wait_seconds) {
        const wait = Math.ceil(resp.error.wait_seconds * 1000);
        log("wait", `Rate limited, waiting ${resp.error.wait_seconds}s...`);
        await sleep(wait);
        return this.execute(command, payload);
      }

      if (code === "session_invalid" || code === "session_expired") {
        log("system", "Session expired, refreshing...");
        this.session = null;
        await this.ensureSession();
        // Re-authenticate if we have credentials
        if (this.credentials) {
          await this.doRequest("login", {
            username: this.credentials.username,
            password: this.credentials.password,
          });
        }
        return this.doRequest(command, payload);
      }
    }

    // Update session info from response
    if (resp.session) {
      this.session = resp.session;
    }

    return resp;
  }

  private async ensureSession(): Promise<void> {
    if (this.session && !this.isSessionExpiring()) return;

    log("system", this.session ? "Renewing session..." : "Creating new session...");

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
    }
  }

  private isSessionExpiring(): boolean {
    if (!this.session) return true;
    const expiresAt = new Date(this.session.expiresAt).getTime();
    const now = Date.now();
    return expiresAt - now < 60_000; // Less than 60s remaining
  }

  private async doRequest(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    const url = `${this.baseUrl}/${command}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.session) {
      headers["X-Session-Id"] = this.session.id;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });

    if (!resp.ok && resp.status !== 400 && resp.status !== 429) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }

    return (await resp.json()) as ApiResponse;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
