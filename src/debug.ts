import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const LOG_FILE = join(DATA_DIR, "debug.log");

let enabled = true;

export function setDebugLog(on: boolean): void {
  enabled = on;
}

export function debugLog(source: string, message: string, data?: unknown): void {
  if (!enabled) return;
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  const timestamp = new Date().toISOString();
  let line = `${timestamp} [${source}] ${message}`;
  if (data !== undefined) {
    try {
      line += " " + JSON.stringify(data);
    } catch {
      line += " [unserializable]";
    }
  }
  line += "\n";
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // ignore write errors
  }
}
