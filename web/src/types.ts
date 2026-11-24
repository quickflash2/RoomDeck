export interface Settings {
  modules: string[];
  join_locked: boolean;
  uploads_paused: boolean;
  download_original: boolean;
  auto_display: boolean;
  quota: number;
  max_members: number;
  display_mode: string;
  display_target: string;
  display_source?: string;
  screen_mode?: string;
  reactions_disabled?: boolean;
  danmaku_mode?: string;
  display_paused: boolean;
  interval: number;
}
export interface Room {
  id: string;
  owner_id: string;
  code: string;
  name: string;
  state: string;
  ends_at: number;
  closed_at: number;
  delete_at: number;
  retention: number;
  created_at: number;
  settings: Settings;
  version: number;
  used: number;
  reserved: number;
  state_revision?: number;
}
export interface Poll {
  options: string[];
  multiple: boolean;
  max_choices: number;
  hide_results: boolean;
  closed: boolean;
  closes_at: number;
}
export interface Content {
  id: string;
  room_id: string;
  author_id: string;
  author_name: string;
  kind: string;
  title: string;
  body: string;
  filename: string;
  mime: string;
  bytes: number;
  visible: boolean;
  selected: boolean;
  created_at: number;
  poll?: Poll;
  counts?: number[];
  voters?: number;
  my_vote?: number[];
}
export interface Member {
  permissions?: string[];
  id: string;
  name: string;
  revoked: boolean;
  muted: boolean;
  online: boolean;
}
export interface Job {
  id: string;
  state: string;
  created_at: number;
  error: string;
  bytes: number;
}
export interface Snapshot {
  permissions?: string[];
  room: Room;
  contents: Content[];
  role: "host" | "guest" | "display";
  participant_id: string;
  name: string;
  online: number;
  participants_total: number;
  members: Member[];
  invite?: string;
  jobs?: Job[];
  display_online: number;
}
export interface Status {
  setup_required: boolean;
  authenticated: boolean;
  username: string;
  role: "admin" | "user" | "";
  base_url: string;
}
export interface ManagedUser {
  id: string;
  username: string;
  room_count: number;
}
export type UnoColor = "red" | "yellow" | "blue" | "green" | "wild";
export type UnoCardType =
  "number" | "skip" | "drawTwo" | "reverse" | "wild" | "wildDrawFour";
export interface UnoCard {
  id: number;
  color: UnoColor;
  type: UnoCardType;
  value: number | null;
}
export interface GamePlayer {
  id: string;
  name: string;
  alive?: boolean;
  score?: number;
  submitted?: boolean;
  word?: string;
  spy?: boolean;
  guess?: number;
  ai?: boolean;
  card_count?: number;
  uno_declared?: boolean;
}
export interface GameMine {
  word?: string;
  guess?: number;
  vote?: string;
  hand?: UnoCard[];
  drawn_card_id?: number | null;
  playable_card_ids?: number[];
}
export interface GameSummary {
  id: string;
  kind: string;
  phase: string;
  language: string;
  version: number;
  round: number;
  seats: number;
  player_count: number;
  seated: boolean;
  created_at: number;
  updated_at: number;
}
export interface GuanDanSummary {
  id: string;
  player_count: number;
  max_players: number;
  in_game: boolean;
  game_mode: string;
  host_name: string;
  available: boolean;
  created_at: number;
  last_seen_at: number;
  closed_at: number | null;
}
export interface Game {
  id: string;
  kind: string;
  phase: string;
  language: string;
  version: number;
  round: number;
  turn: number;
  players: GamePlayer[];
  candidates: string[];
  tie: boolean;
  result: string;
  die: number;
  mine?: GameMine | null;
  player_count?: number;
  current_player_id?: string;
  current_color?: UnoColor;
  direction?: 1 | -1;
  deck_count?: number;
  top_card?: UnoCard | null;
  winner_id?: string;
  log?: string[];
}
