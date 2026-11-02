<script setup lang="ts">
import { computed } from "vue";
import SonarBoard from "@/components/SonarBoard.vue";
import type { BoardCell } from "@/components/SonarBoard.vue";
import { SHIPS, SIZE, coord, firingOrder, isFinal, pad2, shipAt, sunkShips } from "@/game";
import type { Perspective, Phase } from "@/game";
import type { ShotResult } from "@/types";

const props = defineProps<{
  view: Perspective;
  phase: Phase;
  opponentName: string;
  /** The square of a shot on its way to the server. */
  sending: number | null;
  busy: boolean;
}>();

const emit = defineEmits<{ fire: [index: number]; rematch: [] }>();

const first = computed(() => props.opponentName.split(" ")[0]);
const final = computed(() => isFinal(props.phase));
const fleetKnown = computed(() => props.view.theirFleet.length === SHIPS.length);
const mySunk = computed(() => sunkShips(props.view.myFleet, props.view.theirLog));
const theirSunk = computed(() => sunkShips(props.view.theirFleet, props.view.myLog));

const targetCells = computed<BoardCell[]>(() => {
  const v = props.view;
  const last = v.myLog[v.myLog.length - 1];
  return Array.from({ length: SIZE * SIZE }, (_, i) => {
    const n = v.myLog.indexOf(i);
    const answer: ShotResult | undefined = v.myResults[n];
    const k = shipAt(v.theirFleet, i);
    let cls = "";
    let state = "not fired at";
    if (answer?.kind === "sunk" || (n >= 0 && k >= 0 && theirSunk.value[k])) {
      [cls, state] = ["sunk", `sunk${answer?.ship ? ` ${answer.ship}` : ""}`];
    } else if (answer?.kind === "hit") [cls, state] = ["hit", "hit"];
    else if (answer) [cls, state] = ["miss", "miss"];
    else if (n >= 0) [cls, state] = ["pending", "shot pending, waiting for an answer"];
    else if (props.sending === i) [cls, state] = ["pending", "firing"];
    else if (fleetKnown.value && k >= 0) [cls, state] = ["reveal", "ship you did not find"];
    else if (props.phase === "salvo" && props.sending === null) [cls, state] = ["armed", "fire here"];
    if (i === last) cls += " last";
    return { cls, label: `${coord(i)}, ${state}`, disabled: !cls.startsWith("armed") };
  });
});

const ownCells = computed<BoardCell[]>(() => {
  const v = props.view;
  const last = v.theirLog[v.theirLog.length - 1];
  return Array.from({ length: SIZE * SIZE }, (_, i) => {
    const shot = v.theirLog.includes(i);
    const k = shipAt(v.myFleet, i);
    const name = k >= 0 ? SHIPS[k].name : "ship";
    let cls = "";
    let state = "water";
    if (k >= 0 && shot && mySunk.value[k]) [cls, state] = ["sunk", `${name} sunk`];
    else if (k >= 0 && shot) [cls, state] = ["ship-hit", `${name} hit`];
    else if (k >= 0) [cls, state] = ["ship", name];
    else if (shot) [cls, state] = ["miss", "miss"];
    if (i === last) cls += " last";
    return { cls, label: `${coord(i)}, ${state}` };
  });
});

const enemyFleet = computed(() =>
  SHIPS.map((s) => ({
    name: s.name,
    size: s.size,
    sunk: props.view.myResults.some((a) => a.kind === "sunk" && a.ship === s.name),
  })),
);
const myFleet = computed(() =>
  SHIPS.map((s, k) => {
    const cells = props.view.myFleet[k] ?? [];
    return {
      name: s.name,
      size: s.size,
      sunk: mySunk.value[k],
      hits: cells.filter((i) => props.view.theirLog.includes(i)).length,
    };
  }),
);
const enemyLeft = computed(() => enemyFleet.value.filter((s) => !s.sunk).length);
const myLeft = computed(() => myFleet.value.filter((s) => !s.sunk).length);

const shots = computed(() => props.view.myLog.length);
const hits = computed(() => props.view.myResults.filter((a) => a.kind !== "miss").length);
const accuracy = computed(() => (shots.value ? `${Math.round((hits.value * 100) / shots.value)}%` : "--"));

const log = computed(() =>
  firingOrder(props.view)
    .map((e, k) => {
      const r = e.result;
      return {
        n: pad2(k + 1),
        who: e.mine ? "YOU" : first.value.toUpperCase(),
        mine: e.mine,
        at: coord(e.at),
        result: !r ? "PENDING" : r.kind === "sunk" ? `SUNK ${r.ship?.toUpperCase()}` : r.kind.toUpperCase(),
        tone: !r
          ? "text-sonar-cyan"
          : r.kind === "sunk"
            ? "text-sonar-flare-text"
            : r.kind === "hit"
              ? "text-sonar-amber"
              : "text-sonar-dim",
      };
    })
    .reverse()
    .slice(0, 8),
);

const banner = computed(() => {
  const name = props.opponentName;
  switch (props.phase) {
    case "salvo":
      return { title: "Your salvo", text: `Select a target square in ${first.value}'s waters.`, tone: "amber" };
    case "awaiting-answer":
      return {
        title: "Shot pending",
        text: `${coord(props.view.pending ?? 0)} counts once ${name}'s client answers. If they're offline, it waits. Safe to leave this screen.`,
        tone: "cyan",
      };
    case "incoming":
      return { title: "Incoming", text: `${name} is choosing a target. Safe to leave this screen.`, tone: "cyan" };
    case "awaiting-deploy":
      return {
        title: "Awaiting deployment",
        text: `${name} is still placing ships. ${props.view.iFirst ? "You fire first." : `${first.value} fires first.`}`,
        tone: "cyan",
      };
    case "reveal":
      return {
        title: "Verifying",
        text: `Game over. Waiting for ${name} to reveal their fleet so it can be checked. Without a reveal by ${new Date(
          props.view.revealBy ?? 0,
        ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, this device counts it as a forfeit.`,
        tone: "cyan",
      };
    case "won":
      return {
        title: "Victory",
        text: `${name}'s fleet destroyed in ${shots.value} shots. Fleet verified.`,
        tone: "amber",
      };
    case "forfeit":
      return {
        title: "Forfeit",
        text: `${name} never revealed their fleet, so this device counts the game as yours. Nobody can enforce that. If they reveal later, it's checked then.`,
        tone: "flare",
      };
    case "cheat":
      return {
        title: "Cheat detected",
        text: `${name}'s moves don't add up, so this device counts the game as yours.`,
        tone: "flare",
      };
    default:
      return {
        title: "Fleet lost",
        text: `${name} found every ship. Their fleet is verified and their surviving ships are outlined.`,
        tone: "flare",
      };
  }
});

const lastTheirs = computed(() => {
  const v = props.view;
  if (!v.theirLog.length) return "";
  const r = v.theirResults[v.theirLog.length - 1];
  const what = r.kind === "sunk" ? `sank your ${r.ship}` : r.kind === "hit" ? "hit" : "missed";
  return `${first.value} fired at ${coord(v.theirLog[v.theirLog.length - 1])}: ${what}`;
});

const fingerprint = (commit: string | undefined) => (commit ? `${commit.slice(0, 12)}…` : "not published");

const checks = computed(() => {
  const v = props.view;
  const c = v.check;
  return [
    { name: "Fleet hash", ok: !c || c.hash, text: !c ? "at reveal" : c.hash ? "matches" : "does not match" },
    { name: "Layout", ok: !c || c.layout, text: !c ? "at reveal" : c.layout ? "legal" : "illegal" },
    {
      name: "Answers",
      ok: !c || c.lies.length === 0,
      text: !c
        ? "at reveal"
        : c.lies.length
          ? `${c.lies.length} false of ${c.answers}`
          : `${c.answers} checked, all true`,
    },
    {
      name: "Past moves",
      ok: !v.edits.length,
      text: v.edits.length ? `${v.edits.length} changed` : "unchanged",
    },
  ];
});
</script>

<template>
  <div class="flex flex-col gap-5">
    <div
      role="status"
      class="flex flex-wrap items-center gap-x-5 gap-y-2 border px-4 py-3.5"
      :class="{
        'border-sonar-amber bg-sonar-amber-deep': banner.tone === 'amber',
        'border-sonar-line bg-sonar-panel': banner.tone === 'cyan',
        'border-sonar-flare bg-sonar-panel': banner.tone === 'flare',
      }"
    >
      <span
        class="hd text-[28px]"
        :class="{
          'text-sonar-amber': banner.tone === 'amber',
          'text-sonar-cyan': banner.tone === 'cyan',
          'text-sonar-flare-text': banner.tone === 'flare',
        }"
      >
        {{ banner.title }}
      </span>
      <span class="flex-[1_1_260px]">{{ banner.text }}</span>
      <div v-if="final" class="flex flex-wrap gap-2">
        <button class="btn-amber" :disabled="busy" @click="emit('rematch')">
          {{ busy ? "Starting…" : "Rematch" }}
        </button>
        <RouterLink :to="{ name: 'home' }" class="btn-outline">Stand down</RouterLink>
      </div>
    </div>

    <div v-if="view.problems.length" role="alert" class="border border-sonar-flare bg-sonar-panel px-4 py-3.5">
      <h2 class="hd m-0 text-[17px] text-sonar-flare-text">Cheat detected · {{ view.problems.length }}</h2>
      <ul class="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
        <li v-for="p in view.problems.slice(0, 6)" :key="p" class="break-words">{{ p }}</li>
        <li v-if="view.problems.length > 6" class="text-sonar-muted">and {{ view.problems.length - 6 }} more</li>
      </ul>
    </div>

    <div class="flex flex-wrap items-start gap-5">
      <section class="panel flex min-w-0 max-w-full flex-[0_1_auto] flex-col gap-2.5 max-sm:px-2.5">
        <div class="flex items-baseline justify-between gap-3">
          <h2 class="hd m-0 text-[17px] text-sonar-bright">Target · {{ first }}'s waters</h2>
          <span class="label">{{ enemyLeft }} contacts remain</span>
        </div>
        <SonarBoard
          :cells="targetCells"
          :label="`${first}'s waters`"
          mode="target"
          size="big"
          :sweep="phase === 'salvo' || phase === 'incoming' || phase === 'awaiting-answer'"
          @select="(i) => emit('fire', i)"
        />
        <div class="flex flex-wrap gap-6 text-[13px] text-sonar-muted">
          <span>SHOTS {{ pad2(shots) }}</span
          ><span>HITS {{ pad2(hits) }}</span
          ><span>ACCURACY {{ accuracy }}</span>
        </div>
      </section>

      <div class="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
        <div class="flex flex-wrap gap-5">
          <section class="panel flex flex-[0_1_auto] flex-col gap-2 max-sm:px-3">
            <h2 class="hd m-0 text-[15px] text-sonar-bright">Own waters</h2>
            <SonarBoard :cells="ownCells" label="Your waters" mode="view" size="small" />
            <span v-if="lastTheirs" class="max-w-[260px] text-[13px] text-sonar-muted">{{ lastTheirs }}</span>
          </section>
          <section class="panel flex flex-[1_1_180px] flex-col gap-1">
            <h2 class="hd m-0 mb-1.5 text-[15px] text-sonar-bright">Damage report</h2>
            <span class="label">{{ first }} · {{ enemyLeft }} afloat</span>
            <div
              v-for="s in enemyFleet"
              :key="`e-${s.name}`"
              class="flex min-h-[26px] items-center gap-2.5 text-[13px] uppercase tracking-[0.04em]"
              :class="s.sunk ? 'text-sonar-dim line-through' : ''"
            >
              <span class="flex-1">{{ s.name }}<span v-if="s.sunk" class="sr-only"> (sunk)</span></span>
              <span class="flex gap-0.5" aria-hidden="true">
                <span
                  v-for="n in s.size"
                  :key="n"
                  class="h-2.5 w-2.5"
                  :class="s.sunk ? 'bg-[#5A3A1A]' : 'bg-sonar-edge'"
                ></span>
              </span>
            </div>
            <span class="label mt-2">You · {{ myLeft }} afloat</span>
            <div
              v-for="s in myFleet"
              :key="`m-${s.name}`"
              class="flex min-h-[26px] items-center gap-2.5 text-[13px] uppercase tracking-[0.04em]"
              :class="s.sunk ? 'text-sonar-dim line-through' : ''"
            >
              <span class="flex-1">
                {{ s.name }}<span class="sr-only">{{ s.sunk ? " (sunk)" : s.hits ? ` (${s.hits} hits)` : "" }}</span>
              </span>
              <span class="flex gap-0.5" aria-hidden="true">
                <span
                  v-for="n in s.size"
                  :key="n"
                  class="h-2.5 w-2.5"
                  :class="s.sunk ? 'bg-[#5A3A1A]' : n <= s.hits ? 'bg-sonar-amber' : 'bg-sonar-edge'"
                ></span>
              </span>
            </div>
          </section>
        </div>

        <section class="panel flex flex-col gap-2.5">
          <h2 class="hd m-0 text-[15px] text-sonar-bright">Shot log</h2>
          <p v-if="!log.length" class="m-0 text-[13px] text-sonar-muted">No shots fired yet.</p>
          <ol v-else class="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
            <li v-for="e in log" :key="e.n" class="grid grid-cols-[28px_72px_36px_minmax(0,1fr)] gap-x-2.5">
              <span class="text-sonar-dim">{{ e.n }}</span>
              <span class="truncate" :class="e.mine ? 'text-sonar-bright' : 'text-sonar-muted'">{{ e.who }}</span>
              <span class="text-sonar-bright">{{ e.at }}</span>
              <span :class="e.tone">{{ e.result }}</span>
            </li>
          </ol>
        </section>

        <section class="panel flex flex-col gap-2.5">
          <h2 class="hd m-0 text-[15px] text-sonar-bright">Fair play</h2>
          <dl class="m-0 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
            <dt class="text-sonar-dim">Your hash</dt>
            <dd class="m-0 truncate">{{ fingerprint(view.myCommit) }}</dd>
            <dt class="truncate text-sonar-dim">{{ first }}'s hash</dt>
            <dd class="m-0 truncate">{{ fingerprint(view.theirCommit) }}</dd>
            <template v-for="c in checks" :key="c.name">
              <dt class="text-sonar-dim">{{ c.name }}</dt>
              <dd class="m-0" :class="c.ok ? '' : 'font-semibold text-sonar-flare-text'">
                {{ c.ok ? "" : "FAILED: " }}{{ c.text }}
              </dd>
            </template>
          </dl>
          <p class="m-0 text-[13px] text-sonar-muted">
            Fleets stay private until the end. {{ first }}'s client answers your shots, and your client checks every
            answer once their fleet is revealed.
          </p>
          <ul v-if="view.past.length" class="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-sonar-flare-text">
            <li v-for="p in view.past" :key="p">{{ p }}</li>
          </ul>
        </section>
      </div>
    </div>
  </div>
</template>
