/**
 * SpaceMolt game type definitions.
 *
 * Based on the SpaceMolt_User client (https://github.com/leopoko/SpaceMolt_User)
 * and verified against actual API responses.
 */

// ── Primitives ───────────────────────────────────────────────

/** Security levels: "null" is a STRING meaning UNREGULATED, not JS null. */
export type SecurityLevel = "high" | "medium" | "low" | "null";
export type PlayerStatus = "active" | "docked" | "dead" | "traveling";
export type EventType = "combat" | "trade" | "nav" | "system" | "chat" | "error" | "info";
export type ChatChannel = "global" | "faction" | "local" | "system" | "private";
export type MissionStatus = "available" | "active" | "complete" | "failed";
export type OrderType = "buy" | "sell";
export type BattleZone = "outer" | "mid" | "inner" | "engaged";
export type BattleStance = "fire" | "evade" | "brace" | "flee";
export type BattleActionType = "advance" | "retreat" | "stance" | "target" | "engage";
export type CommissionStatus = "pending" | "building" | "ready" | "cancelled";

// ── Player ───────────────────────────────────────────────────

export interface Player {
  id: string;
  username: string;
  empire: string;
  credits: number;
  status?: PlayerStatus;
  current_system?: string;
  current_poi?: string;
  /** ABSENT when undocked (not null — check with != null). */
  docked_at_base?: string | null;
  home_base?: string;
  /** Legacy alias for current_system. */
  system_id?: string;
  /** Legacy alias for current_poi. */
  poi_id?: string | null;
  location?: string;
  primary_color?: string;
  secondary_color?: string;
  anonymous?: boolean;
  is_cloaked?: boolean;
  status_message?: string;
  clan_tag?: string;
  current_ship_id?: string;
  skills?: Skill[] | Record<string, unknown>;
  skill_xp?: Record<string, number>;
  experience?: number;
  stats?: PlayerStats;
  discovered_systems?: Record<string, { system_id: string; discovered_at: string }>;
  faction_id?: string | null;
  missions?: Mission[];
  achievements?: Achievement[];
  insurance?: boolean;
  created_at?: string;
  last_login_at?: string;
  last_active_at?: string;
}

export interface PlayerStats {
  credits_earned: number;
  credits_spent: number;
  ships_destroyed: number;
  ships_lost: number;
  pirates_destroyed: number;
  bases_destroyed: number;
  ore_mined: number;
  items_crafted: number;
  trades_completed: number;
  systems_explored: number;
  distance_traveled: number;
  time_played: number;
}

// ── Ship ─────────────────────────────────────────────────────

export interface Ship {
  id: string;
  name: string;
  class_id?: string;
  type?: string;
  class?: string;
  owner_id?: string;
  hull: number;
  max_hull: number;
  shield?: number;
  max_shield?: number;
  /** Legacy alias for shield/max_shield. */
  shields?: number;
  max_shields?: number;
  shield_recharge?: number;
  armor?: number;
  speed?: number;
  fuel: number;
  max_fuel: number;
  cargo_used?: number;
  cargo_capacity?: number;
  /** Legacy alias for cargo_capacity. */
  max_cargo?: number;
  cpu_used?: number;
  cpu_capacity?: number;
  /** Legacy alias for cpu_capacity. */
  cpu_max?: number;
  power_used?: number;
  power_capacity?: number;
  /** Legacy alias for power_capacity. */
  power_max?: number;
  weapon_slots?: number;
  defense_slots?: number;
  utility_slots?: number;
  modules: string[];
  cargo: CargoItem[];
  created_at?: string;
}

// ── Module ───────────────────────────────────────────────────

export interface Module {
  id: string;
  name: string;
  type: string;
  type_id?: string;
  cpu_usage?: number;
  power_usage?: number;
  /** Legacy alias for cpu_usage. */
  cpu_cost?: number;
  /** Legacy alias for power_usage. */
  power_cost?: number;
  active?: boolean;
  wear: number;
  wear_status?: string;
  quality?: number;
  quality_grade?: string;
  mining_power?: number;
  mining_range?: number;
  stats?: Record<string, number>;
}

// ── Cargo / Items ────────────────────────────────────────────

export interface CargoItem {
  item_id: string;
  name?: string;
  quantity: number;
  volume?: number;
  value?: number;
}

// ── Skill ────────────────────────────────────────────────────

export interface Skill {
  skill_id?: string;
  id?: string;
  name: string;
  level: number;
  xp?: number;
  xp_next?: number;
  description?: string;
}

// ── Star System ──────────────────────────────────────────────

export interface GameSystemInfo {
  id: string;
  name: string;
  security_level: SecurityLevel;
  security_status?: string;
  description?: string;
  pois: GamePOI[];
  connections: SystemConnection[];
  nearby_players: NearbyPlayer[];
  wrecks: GameWreck[];
  drones: Drone[];
}

export interface SystemConnection {
  system_id: string;
  system_name: string;
  security_level?: SecurityLevel | null;
  /** Fuel cost for this jump — useful for fuel-optimal route planning. */
  jump_cost?: number | null;
  distance?: number | null;
}

export interface GamePOI {
  id: string;
  name: string;
  type: string;
  base: BaseInfo | null;
  player_count: number;
  has_base?: boolean;
  base_id?: string | null;
  base_name?: string | null;
  online?: number;
  position?: { x: number; y: number };
}

// ── Nearby Player ────────────────────────────────────────────

export interface NearbyPlayer {
  id?: string;
  player_id?: string;
  username: string;
  ship_type?: string;
  ship_class?: string;
  faction_id?: string | null;
  visible?: boolean;
  primary_color?: string;
  secondary_color?: string;
  anonymous?: boolean;
  in_combat?: boolean;
}

// ── Travel ───────────────────────────────────────────────────

export interface TravelState {
  in_progress: boolean;
  destination_id: string | null;
  destination_name: string | null;
  arrival_tick: number | null;
  current_tick: number;
  type: "travel" | "jump" | null;
}

// ── Base / Station ───────────────────────────────────────────

export interface BaseServices {
  cloning?: boolean;
  crafting?: boolean;
  insurance?: boolean;
  market?: boolean;
  missions?: boolean;
  refuel?: boolean;
  repair?: boolean;
  shipyard?: boolean;
  storage?: boolean;
}

export interface BaseCondition {
  total_service_infra?: number;
  satisfied_count?: number;
  satisfaction_pct?: number;
  condition?: string;
  condition_text?: string;
  health?: number;
  max_health?: number;
  status?: string;
}

export interface BaseInfo {
  id: string;
  poi_id?: string;
  name: string;
  type: "outpost" | "station" | "fortress" | "shipyard" | string;
  owner_id?: string | null;
  owner_name?: string | null;
  faction_id?: string | null;
  services: BaseServices | string[];
  hull?: number;
  max_hull?: number;
  defense_level?: number;
  public_access?: boolean;
  description?: string;
  empire?: string;
  facilities?: string[];
  has_drones?: boolean;
  condition?: BaseCondition;
}

// ── Market / Trading ─────────────────────────────────────────

export interface MarketOrderEntry {
  price_each: number;
  quantity: number;
  source?: string;
}

export interface MarketItem {
  item_id: string;
  item_name: string;
  best_buy: number;
  best_sell: number;
  spread?: number;
  buy_orders: MarketOrderEntry[];
  sell_orders: MarketOrderEntry[];
}

export interface MarketData {
  base: string;
  items: MarketItem[];
}

export interface MyOrder {
  order_id: string;
  order_type: OrderType;
  item_id: string;
  item_name: string;
  price_each: number;
  quantity: number;
  remaining: number;
  listing_fee: number;
  created_at: string;
}

// ── Crafting ─────────────────────────────────────────────────

export interface RecipeInput {
  item_id: string;
  quantity: number;
}

export interface RecipeOutput {
  item_id: string;
  quantity: number;
  quality_mod?: boolean;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  category?: string;
  inputs: RecipeInput[];
  outputs: RecipeOutput[];
  required_skills: Record<string, number>;
  crafting_time: number;
  base_quality?: number;
  skill_quality_mod?: number;
}

// ── Missions ─────────────────────────────────────────────────

export interface MissionObjective {
  type: string;
  target?: string;
  quantity?: number;
  progress?: number;
  complete?: boolean;
}

export interface MissionRewards {
  credits?: number;
  items?: CargoItem[];
  xp?: Record<string, number>;
}

export interface Mission {
  id: string;
  name: string;
  description: string;
  status: MissionStatus;
  objectives: MissionObjective[];
  rewards: MissionRewards;
  giver?: { name: string; title?: string };
  dialog?: { offer?: string; accept?: string; decline?: string; complete?: string };
  chain_next?: string;
  destination?: string;
  destination_name?: string;
  expires_at?: number;
}

// ── Combat ───────────────────────────────────────────────────

export interface CombatEvent {
  tick: number;
  attacker: string;
  defender: string;
  damage: number;
  damage_type: string;
  shield_damage: number;
  hull_damage: number;
  result: "hit" | "miss" | "destroyed";
}

export interface ScanResult {
  targets: NearbyPlayer[];
  wrecks: GameWreck[];
  drones: Drone[];
  anomalies: string[];
}

export interface TargetScanResult {
  target_id: string;
  success: boolean;
  revealed_info: string[] | null;
  tick?: number;
  username?: string;
  ship_class?: string;
  cloaked?: boolean;
  hull?: number;
  shield?: number;
  faction_id?: string;
}

// ── Wreck & Drone ────────────────────────────────────────────

export interface GameWreck {
  id: string;
  ship_type: string;
  loot: CargoItem[];
  expires_at: number;
  owner?: string;
  wreck_type?: string;
}

export interface Drone {
  id: string;
  owner_id: string;
  owner_name: string;
  type: string;
  hull: number;
  max_hull: number;
  bandwidth: number;
}

// ── Battle ───────────────────────────────────────────────────

export interface BattleParticipant {
  player_id: string;
  username: string;
  ship_class?: string;
  side_id: number;
  zone: BattleZone;
  stance: BattleStance;
  target_id?: string;
  hull_pct?: number;
  shield_pct?: number;
  hull_percent?: number;
  shield_percent?: number;
  is_fleeing?: boolean;
  is_destroyed?: boolean;
  damage_dealt?: number;
  damage_taken?: number;
  kill_count?: number;
  survived?: boolean;
}

export interface BattleSide {
  side_id: number;
  player_count?: number;
  members?: string[];
}

export interface BattleStatus {
  battle_id: string;
  tick?: number;
  system_id?: string;
  sides: BattleSide[];
  participants: BattleParticipant[];
  your_side_id?: number;
  your_zone?: BattleZone;
  your_stance?: BattleStance;
  your_target_id?: string;
  auto_pilot?: boolean;
}

// ── Faction ──────────────────────────────────────────────────

export interface Faction {
  id: string;
  name: string;
  tag?: string;
  description: string;
  charter?: string;
  leader_id: string;
  leader_name?: string;
  leader_username?: string;
  member_count?: number;
  members?: FactionMember[];
  wars?: FactionWar[];
  allies?: string[];
  credits?: number;
  standing?: number;
  owned_bases?: number;
  primary_color?: string;
  secondary_color?: string;
  is_member?: boolean;
  is_ally?: boolean;
  is_enemy?: boolean;
  at_war?: boolean;
  created_at?: string;
}

export interface FactionMember {
  player_id: string;
  username: string;
  role: "leader" | "officer" | "member";
  joined_at: number;
}

export interface FactionWar {
  faction_id: string;
  faction_name: string;
  started_at: number;
  kills: number;
  losses: number;
}

// ── Achievements ─────────────────────────────────────────────

export interface Achievement {
  id: string;
  name: string;
  description: string;
  unlocked: boolean;
  unlocked_at: number | null;
}

// ── Shipyard ─────────────────────────────────────────────────

export interface ShowroomShip {
  ship_class: string;
  name: string;
  category?: string;
  scale?: number;
  price: number;
  stock?: number;
  hull?: number;
  shield?: number;
  fuel?: number;
  cargo_capacity?: number;
  cpu_capacity?: number;
  power_capacity?: number;
  weapon_slots?: number;
  defense_slots?: number;
  utility_slots?: number;
  armor?: number;
  speed?: number;
  description?: string;
}

export interface CommissionQuote {
  ship_class: string;
  ship_name?: string;
  credits_only_total?: number;
  provide_materials_total?: number;
  labor_cost?: number;
  material_cost?: number;
  player_credits?: number;
  can_commission?: boolean;
  can_afford_credits_only?: boolean;
  can_afford_provide_materials?: boolean;
  build_materials?: { item_id: string; name?: string; quantity: number }[];
  build_time?: number;
  shipyard_tier_here?: number;
  shipyard_tier_required?: number;
  blockers?: string[];
  message?: string;
}

export interface ShipCatalogEntry {
  id: string;
  name: string;
  description: string;
  class: string;
  category: string;
  empire: string;
  empire_name: string;
  tier: number;
  scale: number;
  price: number;
  lore: string;
  base_hull: number;
  base_shield: number;
  base_shield_recharge: number;
  base_armor: number;
  base_speed: number;
  base_fuel: number;
  cargo_capacity: number;
  cpu_capacity: number;
  power_capacity: number;
  weapon_slots: number;
  defense_slots: number;
  utility_slots: number;
  shipyard_tier: number;
  build_materials: { item_id: string; item_name: string; quantity: number }[];
  flavor_tags: string[];
}

// ── WebSocket ────────────────────────────────────────────────

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export interface WelcomePayload {
  version: string;
  tick_rate: number;
  motd: string;
  server_time: number;
  current_tick?: number;
}

export interface StateUpdatePayload {
  tick?: number;
  player?: Player;
  ship?: Ship;
  modules?: Module[] | null;
  nearby?: NearbyPlayer[];
  in_combat?: boolean;
}

// ── Catalog ──────────────────────────────────────────────────

export interface CatalogRequest {
  type: "ships" | "skills" | "recipes" | "items";
  page?: number;
  per_page?: number;
  search?: string;
  category?: string;
}

export interface CatalogResponse<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

// ── Storage ──────────────────────────────────────────────────

export interface StorageData {
  credits: number;
  items: CargoItem[];
  base_id?: string;
  base_name?: string;
}
