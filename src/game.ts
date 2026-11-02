// Board rules and derived game state. Everything here is pure so the views
// and the store can share it.
import type { Half, RevealCheck, Round, Secret, SecretRound, ShotResult } from "@/types";

export const SIZE = 10;
export const ROWS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
export const COLS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// The order of SHIPS is the order of the fleet arrays.
export const SHIPS = [
  { id: "carrier", name: "Carrier", size: 5 },
  { id: "battleship", name: "Battleship", size: 4 },
  { id: "destroyer", name: "Destroyer", size: 3 },
  { id: "submarine", name: "Submarine", size: 3 },
  { id: "patrol_boat", name: "Patrol boat", size: 2 },
] as const;

export type Orientation = "h" | "v";

/** A square as one number: row * 10 + column. */
export const cellIndex = (row: number, col: number) => row * SIZE + col;
export const coord = (i: number) => `${ROWS[Math.floor(i / SIZE)]}${(i % SIZE) + 1}`;

/** The squares a ship of `size` covers from (row, col), or null if it leaves the board. */
export function shipCells(size: number, row: number, col: number, o: Orientation): number[] | null {
  if (o === "h" ? col + size > SIZE : row + size > SIZE) return null;
  return Array.from({ length: size }, (_, k) => (o === "h" ? cellIndex(row, col + k) : cellIndex(row + k, col)));
}

/** Places every ship at random without overlaps. */
export function randomFleet(): number[][] {
  const taken = new Set<number>();
  return SHIPS.map((ship) => {
    for (;;) {
      const o: Orientation = Math.random() < 0.5 ? "h" : "v";
      const cells = shipCells(ship.size, Math.floor(Math.random() * SIZE), Math.floor(Math.random() * SIZE), o);
      if (cells && !cells.some((i) => taken.has(i))) {
        cells.forEach((i) => taken.add(i));
        return cells;
      }
    }
  });
}

const NO_SECRET: SecretRound = {};

/** One player's round; empty if they haven't started it or the doc is malformed. */
export function roundOf(half: Half | null | undefined, r: number): Round {
  const x = half?.rounds?.[r];
  return {
    ...x,
    shots: Array.isArray(x?.shots) ? x!.shots : [],
    answers: Array.isArray(x?.answers) ? x!.answers : [],
  };
}

/** The index in SHIPS of the ship on square `i`, or -1. */
export function shipAt(fleet: number[][], i: number): number {
  return fleet.findIndex((cells) => cells?.includes(i));
}

/** What a shot at `i` did, given the target's fleet and all shots fired at it so far. */
export function shotResult(fleet: number[][], shots: number[], i: number): ShotResult {
  const k = shipAt(fleet, i);
  if (k < 0) return { kind: "miss" };
  if (fleet[k].every((j) => shots.includes(j))) return { kind: "sunk", ship: SHIPS[k].name };
  return { kind: "hit" };
}

/** Like shotResult, but as of the moment the `n`th logged shot landed. */
export function loggedShotResult(fleet: number[][], log: number[], n: number): ShotResult {
  return shotResult(fleet, log.slice(0, n + 1), log[n]);
}

/** Which ships of `fleet` are sunk, in SHIPS order. */
export function sunkShips(fleet: number[][], shots: number[]): boolean[] {
  return SHIPS.map((_, k) => !!fleet[k]?.length && fleet[k].every((i) => shots.includes(i)));
}

const sunkCount = (answers: ShotResult[]) => new Set(answers.filter((a) => a?.kind === "sunk").map((a) => a.ship)).size;

/** True when `answers` reports the whole fleet sunk. */
const fleetSunk = (answers: ShotResult[]) => sunkCount(answers) >= SHIPS.length;

/** The guest fires first, then the loser of the last game. */
export function firesFirst(half: Half, theirs: Half | null | undefined, r: number): boolean {
  if (r > 1) {
    if (fleetSunk(roundOf(half, r - 1).answers)) return true;
    if (fleetSunk(roundOf(theirs, r - 1).answers)) return false;
  }
  return !half.isHost;
}

/** The opponent's shots this client should answer now. A shot fired out of turn waits for its turn. */
export function shotsDue(half: Half, theirs: Half | null | undefined, r: number): number[] {
  const my = roundOf(half, r);
  const their = roundOf(theirs, r);
  const answered = Math.min(their.answers.length, my.shots.length);
  return their.shots.slice(0, answered + (firesFirst(half, theirs, r) ? 0 : 1));
}

/** True once a whole fleet is reported sunk, or every square has been fired at and answered. */
export function roundOver(my: Round, their: Round): boolean {
  const all = SIZE * SIZE;
  const played =
    Math.min(my.shots.length, their.answers.length) >= all || Math.min(their.shots.length, my.answers.length) >= all;
  return fleetSunk(my.answers) || fleetSunk(their.answers) || played;
}

export type Phase =
  | "deploy"
  | "awaiting-deploy"
  | "salvo"
  /** My shot is out, and the target hasn't answered. */
  | "awaiting-answer"
  | "incoming"
  /** Game over, and the opponent's fleet hasn't been revealed. */
  | "reveal"
  | "won"
  | "lost"
  /** The opponent didn't reveal in time. */
  | "forfeit"
  /** The opponent's moves or reveal don't add up. */
  | "cheat";

/** How long the opponent has to reveal before this client treats it as a forfeit. */
export const REVEAL_GRACE_MS = 60 * 60 * 1000;

const isCheat = (s: SecretRound) =>
  !!s.edits?.length || (!!s.check && (!s.check.hash || !s.check.layout || s.check.lies.length > 0));

function phaseOfRound(half: Half, theirs: Half | null | undefined, secret: SecretRound, r: number, now: number): Phase {
  const my = roundOf(half, r);
  const their = roundOf(theirs, r);
  if (!my.commit) return "deploy";
  if (!their.commit) return "awaiting-deploy";
  if (roundOver(my, their)) {
    if (isCheat(secret)) return "cheat";
    if (secret.check) return fleetSunk(my.answers) ? "lost" : "won";
    if (secret.overAt && now - Date.parse(secret.overAt) > REVEAL_GRACE_MS) return "forfeit";
    return "reveal";
  }
  if (my.shots.length > their.answers.length) return "awaiting-answer";
  return my.shots.length + (firesFirst(half, theirs, r) ? 0 : 1) === my.answers.length ? "salvo" : "incoming";
}

/** The game is decided on this client: nothing more to wait for. */
export const isFinal = (phase: Phase) => ["won", "lost", "forfeit", "cheat"].includes(phase);

/** Everything about a game from one player's side. */
export type Perspective = {
  isHost: boolean;
  round: number;
  phase: Phase;
  setup: boolean;
  opponentSetup: boolean;
  /** My own ship squares, in SHIPS order. */
  myFleet: number[][];
  /** Their ship squares, once revealed with a legal layout. */
  theirFleet: number[][];
  myCommit?: string;
  theirCommit?: string;
  /** My shots at their waters, and their answers so far. */
  myLog: number[];
  myResults: ShotResult[];
  /** Their shots at my waters that I've answered, and my answers. */
  theirLog: number[];
  theirResults: ShotResult[];
  /** The square of my shot still waiting for an answer. */
  pending: number | null;
  iFirst: boolean;
  myScore: number;
  theirScore: number;
  check?: RevealCheck;
  edits: string[];
  /** What this client has caught in this game. */
  problems: string[];
  /** Earlier games of the series that didn't end cleanly. */
  past: string[];
  /** When this client stops waiting for their reveal, in ms. */
  revealBy: number | null;
};

export function perspective(half: Half, theirs: Half | null | undefined, secret: Secret | undefined, now: number) {
  const r = half.round;
  const my = roundOf(half, r);
  const their = roundOf(theirs, r);
  const s = secret?.rounds?.[r] ?? NO_SECRET;

  let myScore = 0;
  let theirScore = 0;
  const past: string[] = [];
  for (let n = 1; n <= r; n++) {
    const phase = phaseOfRound(half, theirs, secret?.rounds?.[n] ?? NO_SECRET, n, now);
    if (phase === "won" || phase === "forfeit" || phase === "cheat") myScore++;
    if (phase === "lost") theirScore++;
    if (n < r && phase === "cheat") past.push(`Game ${n}: cheat detected`);
    if (n < r && phase === "forfeit") past.push(`Game ${n}: fleet never revealed, counted as a forfeit`);
  }

  const answers = their.answers.slice(0, my.shots.length).map((a): ShotResult => a ?? { kind: "miss" });
  const check = s.check;
  const edits = s.edits ?? [];
  const problems = [...edits];
  if (check && !check.hash) problems.push("Revealed fleet doesn't match the hash published before the first shot");
  if (check && !check.layout) problems.push("Revealed fleet isn't a legal layout");
  if (check) problems.push(...check.lies);

  const revealed = their.reveal?.fleet;
  const phase = phaseOfRound(half, theirs, s, r, now);
  const view: Perspective = {
    isHost: half.isHost,
    round: r,
    phase,
    setup: !!my.commit,
    opponentSetup: !!their.commit,
    myFleet: s.fleet ?? [],
    theirFleet: check?.layout && revealed ? revealed : [],
    myCommit: my.commit,
    theirCommit: their.commit,
    myLog: my.shots,
    myResults: answers,
    theirLog: their.shots.slice(0, my.answers.length),
    theirResults: my.answers,
    pending: my.shots.length > answers.length ? my.shots[answers.length] : null,
    iFirst: firesFirst(half, theirs, r),
    myScore,
    theirScore,
    check,
    edits,
    problems,
    past,
    revealBy: phase === "reveal" && s.overAt ? Date.parse(s.overAt) + REVEAL_GRACE_MS : null,
  };
  return view;
}

export type LogEntry = { mine: boolean; at: number; result: ShotResult | null };

/** Both players' shots in firing order. Shots alternate from whoever fired first. */
export function firingOrder(v: Perspective): LogEntry[] {
  const entries: LogEntry[] = [];
  const add = (mine: boolean, n: number) => {
    if (mine && n < v.myLog.length) entries.push({ mine, at: v.myLog[n], result: v.myResults[n] ?? null });
    if (!mine && n < v.theirLog.length) entries.push({ mine, at: v.theirLog[n], result: v.theirResults[n] ?? null });
  };
  for (let n = 0; n < Math.max(v.myLog.length, v.theirLog.length); n++) {
    add(v.iFirst, n);
    add(!v.iFirst, n);
  }
  return entries;
}

/** "2 min ago" style age of an ISO timestamp. */
export function ago(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export const pad2 = (n: number) => String(n).padStart(2, "0");
