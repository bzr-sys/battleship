import type { Doc } from "@bzr/bazaar";

export type ShotResult = { kind: "miss" | "hit" | "sunk"; ship?: string };

/** One player's moves in one game of a series. */
export type Round = {
  /** SHA-256 of fleet + salt, published before the first shot. */
  commit?: string;
  /** Squares fired at (row * 10 + column), in order. */
  shots: number[];
  /** Answers to the opponent's shots, in order. */
  answers: ShotResult[];
  /** Published when the game is over. */
  reveal?: { fleet: number[][]; salt: string };
};

/**
 * A player's half of a game, in their own `games` collection. The opponent has
 * read access to this one doc and nobody but its owner can write it. Both
 * halves of a game have the same ID.
 */
export type Half = Doc & {
  type: "half";
  visible: boolean;
  lastActive: string;
  isHost: boolean;
  /** Unset on an invite link nobody has joined yet. */
  opponentId?: string;
  /** The game of the series this player is on. */
  round: number;
  rounds: Record<number, Round>;
  linkId?: string;
  linkUrl?: string;
};

/** A game from before the split into halves. It can't be continued. */
export type OldGame = Doc & {
  type: "hosted" | "invited" | "link";
  visible: boolean;
  lastActive: string;
  guestId?: string;
  hostId?: string;
};

export type Game = Half | OldGame;

/** What the reveal showed, checked against the copy of the opponent's moves. */
export type RevealCheck = {
  hash: boolean;
  layout: boolean;
  /** How many answers were checked. */
  answers: number;
  /** The answers that don't match the revealed fleet. */
  lies: string[];
};

export type SecretRound = {
  fleet?: number[][];
  salt?: string;
  /** The opponent's moves as first seen. Later edits never overwrite them. */
  copy?: Round;
  /** Where the opponent's half stopped matching the copy. */
  edits?: string[];
  check?: RevealCheck;
  /** When this client saw the game end. */
  overAt?: string;
};

/** A player's private data for a game, in their own `secrets` collection, with no grant. Same ID as the game. */
export type Secret = Doc & {
  rounds: Record<number, SecretRound>;
};

export type SignUpIn = {
  email: string;
  password: string;
};
