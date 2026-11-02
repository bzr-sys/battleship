// Commit, copy and reveal: how one client catches the other cheating.
import { SHIPS, SIZE, coord, loggedShotResult } from "@/game";
import type { RevealCheck, Round, ShotResult } from "@/types";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const newSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)));

export async function commitment(fleet: number[][], salt: string): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(fleet) + salt);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

/** Five ships of the right sizes, straight, on the board, not overlapping. */
export function legalFleet(fleet: unknown): fleet is number[][] {
  if (!Array.isArray(fleet) || fleet.length !== SHIPS.length) return false;
  const taken = new Set<number>();
  return SHIPS.every((ship, k) => {
    const cells: unknown = fleet[k];
    if (!Array.isArray(cells) || cells.length !== ship.size) return false;
    const step = cells[1] - cells[0];
    if (step !== 1 && step !== SIZE) return false;
    return cells.every((c, n) => {
      if (!Number.isInteger(c) || c < 0 || c >= SIZE * SIZE || taken.has(c)) return false;
      taken.add(c);
      if (c !== cells[0] + n * step) return false;
      return step === SIZE || Math.floor(c / SIZE) === Math.floor(cells[0] / SIZE);
    });
  });
}

const sameAnswer = (a: ShotResult | undefined, b: ShotResult | undefined) => a?.kind === b?.kind && a?.ship === b?.ship;
const words = (a: ShotResult | undefined) =>
  !a?.kind ? "nothing" : a.kind === "sunk" && a.ship ? `sunk ${a.ship}` : a.kind;

/**
 * Compares the opponent's half with this client's copy. The copy only ever
 * grows: new moves are added and past ones stay as first seen.
 */
export function mergeCopy(copy: Round | undefined, live: Round): { copy: Round; edits: string[] } {
  const c: Round = copy ?? { shots: [], answers: [] };
  const edits: string[] = [];
  if (c.commit && c.commit !== live.commit) edits.push("Fleet hash changed after it was published");
  c.shots.forEach((s, n) => {
    if (s !== live.shots[n]) {
      const now = live.shots[n] === undefined ? "removed" : `changed to ${coord(live.shots[n])}`;
      edits.push(`Shot ${n + 1} at ${coord(s)} ${now}`);
    }
  });
  c.answers.forEach((a, n) => {
    if (!sameAnswer(a, live.answers[n]))
      edits.push(`Answer ${n + 1} changed from ${words(a)} to ${words(live.answers[n])}`);
  });
  if (c.reveal && JSON.stringify(c.reveal) !== JSON.stringify(live.reveal)) {
    edits.push("Revealed fleet changed after it was published");
  }
  const merged: Round = {
    shots: [...c.shots, ...live.shots.slice(c.shots.length)],
    answers: [...c.answers, ...live.answers.slice(c.answers.length)],
  };
  const commit = c.commit ?? live.commit;
  const reveal = c.reveal ?? live.reveal;
  if (commit) merged.commit = commit;
  if (reveal) merged.reveal = reveal;
  return { copy: merged, edits };
}

/** Checks a revealed fleet against the commit and every answer given to `myShots`. */
export async function checkReveal(copy: Round, myShots: number[]): Promise<RevealCheck> {
  const reveal = copy.reveal;
  const fleet = reveal?.fleet;
  const hash =
    !!reveal &&
    !!copy.commit &&
    typeof reveal.salt === "string" &&
    copy.commit === (await commitment(fleet!, reveal.salt));
  const layout = legalFleet(fleet);
  const lies: string[] = [];
  const answered = copy.answers.slice(0, myShots.length);
  if (layout) {
    answered.forEach((a, n) => {
      const truth = loggedShotResult(fleet, myShots, n);
      if (!sameAnswer(a, truth)) lies.push(`${coord(myShots[n])}: answered ${words(a)}, was ${words(truth)}`);
    });
  }
  return { hash, layout, answers: layout ? answered.length : 0, lies };
}
