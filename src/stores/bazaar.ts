import { ref, computed, reactive, watch } from "vue";
import type { ComputedRef } from "vue";
import { defineStore } from "pinia";
import { bzr } from "@/bazaar";
import type { Half, Secret, SecretRound } from "@/types/index";
import { loggedShotResult, perspective, roundOf, roundOver, shotsDue } from "@/game";
import type { Perspective, Phase } from "@/game";
import { checkReveal, commitment, mergeCopy, newSalt } from "@/fairplay";

import { arrayMirrorSubscribeListener, GranteeType, PermissionType } from "@bzr/bazaar";
import type { DeepPartial, User, GrantedPermission } from "@bzr/bazaar";

export const GAMES_COLLECTION_NAME = "games";
export const SECRETS_COLLECTION_NAME = "secrets";
export const HALF_GAME_TYPE = "half";

/** A game as the signed-in user sees it. */
export type Engagement = {
  /** The ID of both players' halves (used in the URL). */
  id: string;
  half: Half;
  /** The opponent's half: undefined until it can be read, null if it was removed. */
  theirs: Half | null | undefined;
  secret: Secret | undefined;
  isHost: boolean;
  opponentId: string;
  lastActive: string;
  view: Perspective;
  phase: Phase;
};

export const useBazaarStore = defineStore("bazaar", () => {
  const loaded = ref(false);
  const authenticated = ref(false);
  const user = ref({
    id: "",
    handle: "",
    name: "",
  } as User);
  const games = ref([] as Half[]);
  const secrets = ref([] as Secret[]);
  const people = reactive({} as Record<string, User | null>);
  const now = ref(Date.now());
  setInterval(() => (now.value = Date.now()), 30_000);

  // The opponents' halves, from their databases: game ID -> live copy.
  const opponents = reactive({} as Record<string, Half | null>);
  const watching = new Set<string>();

  const gamesCollection = bzr.collection<Half>(GAMES_COLLECTION_NAME);
  const secretsCollection = bzr.collection<Secret>(SECRETS_COLLECTION_NAME);

  function ensurePerson(userId: string) {
    if (!userId || userId in people) return;
    people[userId] = null;
    bzr.social
      .getUser({ userId })
      .then((u: User) => {
        people[userId] = u;
      })
      .catch((err) => console.log("Could not load user", userId, err));
  }

  async function watchOpponent(gameId: string, ownerId: string) {
    if (watching.has(gameId)) return;
    watching.add(gameId);
    try {
      const ctx = await bzr.createContext({ ownerId });
      await ctx.collection<Half>(GAMES_COLLECTION_NAME).subscribeOne(gameId, {
        onInitial: (doc) => {
          if (doc) opponents[gameId] = doc;
        },
        onAdd: (doc) => {
          opponents[gameId] = doc;
        },
        onChange: (_old, doc) => {
          opponents[gameId] = doc;
        },
        onDelete: () => {
          opponents[gameId] = null;
        },
      });
    } catch (err) {
      watching.delete(gameId);
      console.log("Could not load game from", ownerId, err);
    }
  }

  const engagements: ComputedRef<Engagement[]> = computed(() => {
    const out: Engagement[] = [];
    for (const half of games.value) {
      if (!half.visible || !half.opponentId) continue;
      const theirs = opponents[half.id];
      const secret = secrets.value.find((s) => s.id === half.id);
      const view = perspective(half, theirs, secret, now.value);
      out.push({
        id: half.id,
        half,
        theirs,
        secret,
        isHost: half.isHost,
        opponentId: half.opponentId,
        lastActive: theirs && theirs.lastActive > half.lastActive ? theirs.lastActive : half.lastActive,
        view,
        phase: view.phase,
      });
    }
    return out;
  });

  const links = computed(() => games.value.filter((g) => g.visible && !g.opponentId));

  // Keep opponent names loaded for everything in the lobby.
  watch(
    () => games.value.map((g) => g.opponentId).join(),
    () => {
      for (const g of games.value) ensurePerson(g.opponentId ?? "");
    },
  );

  // A guest makes their half when they get the host's grant.
  const joining = new Set<string>();
  async function join(gameId: string, hostId: string) {
    if (joining.has(gameId)) return;
    joining.add(gameId);
    try {
      if (!secrets.value.some((s) => s.id === gameId)) {
        await secretsCollection.insertOne({ id: gameId, rounds: {} });
      }
      // The grant first: if the insert fails, the next sign-in tries again.
      await bzr.permissions.create({
        collectionName: GAMES_COLLECTION_NAME,
        granteeType: GranteeType.USER,
        granteeId: hostId,
        types: [PermissionType.READ],
        filter: { id: gameId },
      });
      await gamesCollection.insertOne({
        id: gameId,
        type: HALF_GAME_TYPE,
        visible: true,
        lastActive: "$now",
        isHost: false,
        opponentId: hostId,
        round: 1,
        rounds: {},
      });
    } finally {
      joining.delete(gameId);
    }
  }

  async function checkGranted(g: GrantedPermission) {
    const gameId = g.permission?.filter?.id;
    if (g.permission?.collectionName !== GAMES_COLLECTION_NAME || typeof gameId !== "string") return;
    try {
      const mine = games.value.find((x) => x.id === gameId);
      if (mine) {
        // The opponent's half for a game of ours. On a link, whoever got in is the opponent.
        if (mine.opponentId && mine.opponentId !== g.ownerId) return;
        if (!mine.opponentId) await gamesCollection.updateOne(gameId, { opponentId: g.ownerId, lastActive: "$now" });
      } else {
        const ctx = await bzr.createContext({ ownerId: g.ownerId });
        const host = await ctx.collection<Half>(GAMES_COLLECTION_NAME).getOne(gameId);
        // Not a game to join, or meant for someone else.
        if (!host?.isHost || (host.opponentId && host.opponentId !== user.value.id)) return;
        await join(gameId, g.ownerId);
      }
      watchOpponent(gameId, g.ownerId);
    } catch (err) {
      console.log("Could not process grant", g.id, err);
    }
  }

  /**
   * What this client does on its own whenever anything changes, whichever
   * screen is open: copy the opponent's moves, check them, answer their shots,
   * reveal at the end, follow them to a rematch.
   */
  async function settleOnce(e: Engagement) {
    const { half, theirs, secret, id } = e;
    if (!secret) return;
    const r = half.round;
    const updates: Record<number, SecretRound> = {};

    if (theirs) {
      const seen = new Set([...Object.keys(theirs.rounds ?? {}), ...Object.keys(secret.rounds ?? {})].map(Number));
      for (const n of seen) {
        const s = secret.rounds?.[n] ?? {};
        const live = roundOf(theirs, n);
        const { copy, edits } = mergeCopy(s.copy, live);
        const allEdits = [...new Set([...(s.edits ?? []), ...edits])];
        const u: SecretRound = {};
        if (JSON.stringify(copy) !== JSON.stringify(s.copy ?? { shots: [], answers: [] })) u.copy = copy;
        if (allEdits.length !== (s.edits ?? []).length) u.edits = allEdits;
        // A reveal before the end is checked again as more answers come in.
        const shots = roundOf(half, n).shots;
        const answered = Math.min(copy.answers.length, shots.length);
        if (copy.reveal && (!s.check || (s.check.layout && s.check.answers < answered))) {
          u.check = await checkReveal(copy, shots);
        }
        if (Object.keys(u).length) updates[n] = u;
      }
    }

    const my = roundOf(half, r);
    const their = roundOf(theirs, r);
    const fleet = secret.rounds?.[r]?.fleet;
    const over = !!my.commit && !!their.commit && roundOver(my, their);
    if (over && !secret.rounds?.[r]?.overAt) updates[r] = { ...updates[r], overAt: new Date().toISOString() };
    if (Object.keys(updates).length) await secretsCollection.updateOne(id, { rounds: updates } as DeepPartial<Secret>);

    if (!my.commit || !fleet) return;
    const due = shotsDue(half, theirs, r);
    if (!over && due.length > my.answers.length) {
      const answers = due.map((_, n) => my.answers[n] ?? loggedShotResult(fleet, due, n));
      await writeHalf(id, { rounds: { [r]: { answers } } });
    } else if (over && !my.reveal) {
      await writeHalf(id, { rounds: { [r]: { reveal: { fleet, salt: secret.rounds[r].salt! } } } });
    } else if (over && theirs && theirs.round > r) {
      await writeHalf(id, { round: theirs.round });
    }
  }

  const settling = new Map<string, boolean>();
  function settle(id: string) {
    if (settling.has(id)) {
      settling.set(id, true);
      return;
    }
    const e = engagements.value.find((x) => x.id === id);
    if (!e) return;
    settling.set(id, false);
    settleOnce(e)
      .catch((err) => console.log("Could not update game", id, err))
      .finally(() => {
        const again = settling.get(id);
        settling.delete(id);
        if (again) settle(id);
      });
  }

  watch(engagements, (list) => {
    for (const e of list) settle(e.id);
  });

  let signingIn = false;
  async function autoSignIn() {
    if (bzr.isLoggedIn()) {
      if (signingIn || authenticated.value) return;
      signingIn = true;
      try {
        user.value = await bzr.social.getUser();
        authenticated.value = true;

        await secretsCollection.subscribeAll({}, arrayMirrorSubscribeListener(secrets.value));
        // Only this format: older docs in the collection are ignored.
        await gamesCollection.subscribeAll({ type: HALF_GAME_TYPE }, arrayMirrorSubscribeListener(games.value));

        await bzr.permissions.granted.subscribe(
          { collectionName: GAMES_COLLECTION_NAME },
          {
            onAdd: (newDoc) => {
              checkGranted(newDoc);
            },
            onChange: (_oldDoc, newDoc) => {
              checkGranted(newDoc);
            },
          },
        );
        const granted = await bzr.permissions.granted.list({ collectionName: GAMES_COLLECTION_NAME });
        for (const g of granted) {
          checkGranted(g);
        }

        loaded.value = true;
      } catch (e: unknown) {
        console.error("Error during auto signin", e);
      } finally {
        signingIn = false;
      }
    } else {
      loaded.value = true;
    }
  }

  /** Makes the host's half and its private doc. */
  async function newHalf(opponentId?: string) {
    const id = await secretsCollection.insertOne({ rounds: {} });
    await gamesCollection.insertOne({
      id,
      type: HALF_GAME_TYPE,
      visible: true,
      lastActive: "$now",
      isHost: true,
      ...(opponentId ? { opponentId } : {}),
      round: 1,
      rounds: {},
    });
    return id;
  }

  async function createGame(userId: string) {
    const gameId = await newHalf(userId);
    await bzr.permissions.create({
      collectionName: GAMES_COLLECTION_NAME,
      granteeType: GranteeType.USER,
      granteeId: userId,
      types: [PermissionType.READ],
      filter: {
        id: gameId,
      },
    });
    return gameId;
  }

  async function createLink() {
    const gameId = await newHalf();
    const link = await bzr.permissions.links.create(
      {
        collectionName: GAMES_COLLECTION_NAME,
        types: [PermissionType.READ],
        filter: {
          id: gameId,
        },
      },
      "Link for new game",
      1,
    );
    await gamesCollection.updateOne(gameId, { linkId: link.id, linkUrl: link.url });
    return link.url;
  }

  async function hideGame(gameId: string) {
    await gamesCollection.updateOne(gameId, { visible: false });
  }

  async function writeHalf(id: string, update: DeepPartial<Half>) {
    await gamesCollection.updateOne(id, { ...update, lastActive: "$now" });
  }

  /** Keeps the fleet private and publishes only its hash. */
  async function lockFleet(e: Engagement, fleet: number[][]) {
    const r = e.half.round;
    const salt = newSalt();
    const commit = await commitment(fleet, salt);
    await secretsCollection.updateOne(e.id, { rounds: { [r]: { fleet, salt } } } as DeepPartial<Secret>);
    await writeHalf(e.id, { rounds: { [r]: { commit, shots: [], answers: [] } } });
  }

  async function fire(e: Engagement, i: number) {
    const r = e.half.round;
    await writeHalf(e.id, { rounds: { [r]: { shots: [...e.view.myLog, i] } } });
  }

  /** Starts the next game of the series. The opponent's client follows. */
  async function rematch(e: Engagement) {
    await writeHalf(e.id, { round: e.half.round + 1 });
  }

  return {
    loaded,
    authenticated,
    user,
    games,
    people,
    engagements,
    links,
    autoSignIn,
    createGame,
    createLink,
    hideGame,
    lockFleet,
    fire,
    rematch,
  };
});
