import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { SpaceMoltAPI } from "./api.js";

// ── Data model ──────────────────────────────────────────────

export interface CatalogItem {
  id: string;
  name: string;
  category?: string;
  [key: string]: unknown;
}

export interface CatalogShip {
  id: string;
  name: string;
  class?: string;
  tier?: number;
  [key: string]: unknown;
}

export interface CatalogSkill {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface CatalogRecipe {
  id: string;
  name: string;
  category?: string;
  components?: Array<{ item_id?: string; name?: string; quantity?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface CatalogData {
  version: 1;
  lastFetched: string | null;
  items: Record<string, CatalogItem>;
  ships: Record<string, CatalogShip>;
  skills: Record<string, CatalogSkill>;
  recipes: Record<string, CatalogRecipe>;
}

// ── CatalogStore singleton ──────────────────────────────────

const DATA_DIR = join(process.cwd(), "data");
const CATALOG_FILE = join(DATA_DIR, "catalog.json");
const SAVE_DEBOUNCE_MS = 5000;
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

class CatalogStore {
  private data: CatalogData;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.data = this.load();
  }

  // ── Persistence ─────────────────────────────────────────

  private load(): CatalogData {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    if (existsSync(CATALOG_FILE)) {
      try {
        const raw = readFileSync(CATALOG_FILE, "utf-8");
        return JSON.parse(raw) as CatalogData;
      } catch {
        // Corrupt file — start fresh
      }
    }
    return { version: 1, lastFetched: null, items: {}, ships: {}, skills: {}, recipes: {} };
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  private writeToDisk(): void {
    if (!this.dirty) return;
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(CATALOG_FILE, JSON.stringify(this.data, null, 2) + "\n", "utf-8");
    this.dirty = false;
  }

  /** Flush pending writes to disk immediately. Call on shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeToDisk();
  }

  // ── Staleness check ───────────────────────────────────────

  /** True if catalog data is missing or older than 24 hours. */
  isStale(): boolean {
    if (!this.data.lastFetched) return true;
    const age = Date.now() - new Date(this.data.lastFetched).getTime();
    return age > STALE_MS;
  }

  // ── Fetch from API ────────────────────────────────────────

  /** Paginate all 4 catalog types and store results. */
  async fetchAll(api: SpaceMoltAPI): Promise<void> {
    const types = ["items", "ships", "skills", "recipes"] as const;
    const results: Record<string, Record<string, unknown>> = {
      items: {},
      ships: {},
      skills: {},
      recipes: {},
    };

    for (const type of types) {
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages) {
        const resp = await api.execute("catalog", { type, page, page_size: 50 });
        if (resp.error) break;

        const data = resp.result as Record<string, unknown> | undefined;
        if (!data) break;

        // Extract items array from various response shapes
        const entries = extractArray(data, type);

        for (const entry of entries) {
          const id = (entry.id as string) || (entry.item_id as string) || (entry.recipe_id as string) || (entry.skill_id as string) || (entry.ship_id as string) || "";
          if (id) {
            // Normalize: ensure id field is set
            entry.id = id;
            results[type][id] = entry;
          }
        }

        totalPages = (data.total_pages as number) || (data.totalPages as number) || 1;
        page++;
      }
    }

    this.data.items = results.items as Record<string, CatalogItem>;
    this.data.ships = results.ships as Record<string, CatalogShip>;
    this.data.skills = results.skills as Record<string, CatalogSkill>;
    this.data.recipes = results.recipes as Record<string, CatalogRecipe>;
    this.data.lastFetched = new Date().toISOString();

    this.dirty = true;
    this.writeToDisk();

    const counts = [
      `${Object.keys(this.data.items).length} items`,
      `${Object.keys(this.data.ships).length} ships`,
      `${Object.keys(this.data.skills).length} skills`,
      `${Object.keys(this.data.recipes).length} recipes`,
    ];
    return void counts; // logged by caller
  }

  // ── Lookup methods ────────────────────────────────────────

  getItem(id: string): CatalogItem | undefined {
    return this.data.items[id];
  }

  getShip(id: string): CatalogShip | undefined {
    return this.data.ships[id];
  }

  getSkill(id: string): CatalogSkill | undefined {
    return this.data.skills[id];
  }

  getRecipe(id: string): CatalogRecipe | undefined {
    return this.data.recipes[id];
  }

  /** Resolve a human-readable name for any catalog ID. Falls back to formatted ID. */
  resolveItemName(id: string): string {
    const entry = this.data.items[id] || this.data.ships[id] || this.data.skills[id] || this.data.recipes[id];
    if (entry?.name) return entry.name as string;
    return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Return full catalog data for WS broadcast / REST endpoint. */
  getAll(): { items: Record<string, CatalogItem>; ships: Record<string, CatalogShip>; skills: Record<string, CatalogSkill>; recipes: Record<string, CatalogRecipe>; lastFetched: string | null } {
    return {
      items: this.data.items,
      ships: this.data.ships,
      skills: this.data.skills,
      recipes: this.data.recipes,
      lastFetched: this.data.lastFetched,
    };
  }

  /** Summary string for logging. */
  getSummary(): string {
    return `${Object.keys(this.data.items).length} items, ${Object.keys(this.data.ships).length} ships, ${Object.keys(this.data.skills).length} skills, ${Object.keys(this.data.recipes).length} recipes`;
  }
}

/** Extract an array of entries from a catalog API response. */
function extractArray(data: Record<string, unknown>, type: string): Array<Record<string, unknown>> {
  // Direct array response
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  // Keyed by type name
  if (Array.isArray(data[type])) return data[type] as Array<Record<string, unknown>>;
  // Common alternate keys
  for (const key of ["items", "catalog", "results", "data", "entries", "list"]) {
    if (Array.isArray(data[key])) return data[key] as Array<Record<string, unknown>>;
  }
  return [];
}

/** Singleton instance shared across the application. */
export const catalogStore = new CatalogStore();
