import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface Credentials {
  username: string;
  password: string;
  empire: string;
  playerId: string;
}

export class SessionManager {
  readonly dir: string;
  private credentialsPath: string;
  private todoPath: string;

  constructor(sessionName: string, baseDir: string) {
    this.dir = join(baseDir, "sessions", sessionName);
    this.credentialsPath = join(this.dir, "CREDENTIALS.md");
    this.todoPath = join(this.dir, "TODO.md");
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  loadCredentials(): Credentials | null {
    if (!existsSync(this.credentialsPath)) return null;
    const text = readFileSync(this.credentialsPath, "utf-8");
    const get = (label: string): string => {
      const match = text.match(new RegExp(`- ${label}:\\s*(.+)`));
      return match ? match[1].trim() : "";
    };
    const username = get("Username");
    const password = get("Password");
    const empire = get("Empire");
    const playerId = get("Player ID");
    if (!username || !password) return null;
    return { username, password, empire, playerId };
  }

  saveCredentials(creds: Credentials): void {
    const text = [
      "# SpaceMolt Credentials",
      "",
      `- Username: ${creds.username}`,
      `- Password: ${creds.password}`,
      `- Empire: ${creds.empire}`,
      `- Player ID: ${creds.playerId}`,
      "",
    ].join("\n");
    writeFileSync(this.credentialsPath, text, "utf-8");
  }

  loadTodo(): string {
    if (!existsSync(this.todoPath)) return "";
    return readFileSync(this.todoPath, "utf-8");
  }

  saveTodo(content: string): void {
    writeFileSync(this.todoPath, content, "utf-8");
  }
}
