<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";

import { useBazaarStore } from "@/stores/bazaar";
import { pad2 } from "@/game";
import FleetSetup from "@/components/FleetSetup.vue";
import BattleStation from "@/components/BattleStation.vue";

const store = useBazaarStore();
const route = useRoute();

const gameId = computed(() => String(route.params.gameId));
const engagement = computed(() => store.engagements.find((e) => e.id === gameId.value));
const opponent = computed(() => (engagement.value ? store.people[engagement.value.opponentId] : undefined));
const opponentName = computed(() => opponent.value?.name || "Opponent");

// A game created a moment ago may not have reached the lobby list yet.
const searching = ref(true);
const searchTimer = setTimeout(() => (searching.value = false), 4000);
onUnmounted(() => clearTimeout(searchTimer));

const busy = ref(false);
const sending = ref<number | null>(null);
const error = ref("");

// A shot is sent once it shows up in my half.
watch(
  () => engagement.value?.view.myLog,
  (log) => {
    if (sending.value !== null && log?.includes(sending.value)) sending.value = null;
  },
);

async function lockFleet(fleet: number[][]) {
  const e = engagement.value;
  if (!e || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await store.lockFleet(e, fleet);
  } catch (err) {
    console.log(err);
    error.value = "Could not lock in your fleet. Check your connection and try again.";
  } finally {
    busy.value = false;
  }
}

async function fire(i: number) {
  const e = engagement.value;
  if (!e || e.phase !== "salvo" || sending.value !== null || e.view.myLog.includes(i)) return;
  sending.value = i;
  error.value = "";
  try {
    await store.fire(e, i);
  } catch (err) {
    console.log(err);
    sending.value = null;
    error.value = "That shot did not go through. Try again.";
  }
}

async function rematch() {
  const e = engagement.value;
  if (!e || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await store.rematch(e);
  } catch (err) {
    console.log(err);
    error.value = "Could not start a new game. Try again.";
  } finally {
    busy.value = false;
  }
}

// Each game of a series gets a fresh setup screen.
const round = computed(() => engagement.value?.view.round ?? 1);
</script>

<template>
  <div>
    <div class="border-b border-sonar-line bg-sonar-panel">
      <div class="mx-auto flex min-h-[56px] max-w-[1240px] flex-wrap items-center gap-x-5 gap-y-1 px-4 py-1.5 sm:px-6">
        <RouterLink
          :to="{ name: 'home' }"
          class="inline-flex min-h-[44px] items-center gap-1.5 tracking-[0.1em] text-sonar-cyan no-underline hover:text-sonar-cyan-hi"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <path d="M15 18l-6-6 6-6"></path>
          </svg>
          ENGAGEMENTS
        </RouterLink>
        <template v-if="engagement">
          <span class="hd text-lg text-sonar-bright">vs {{ opponentName }}</span>
          <span class="text-sonar-dim">
            <template v-if="opponent?.handle">@{{ opponent.handle }} · </template>engagement {{ round }}
          </span>
          <span
            v-if="engagement.phase === 'deploy'"
            class="ml-auto inline-flex items-center gap-2"
            :class="engagement.view.opponentSetup ? 'text-sonar-cyan' : 'text-sonar-muted'"
          >
            <span
              class="h-2 w-2 rounded-full"
              :class="engagement.view.opponentSetup ? 'bg-sonar-cyan shadow-[0_0_8px_#46E3D2]' : 'bg-sonar-edge'"
            ></span>
            {{ engagement.view.opponentSetup ? "ENEMY FLEET DEPLOYED" : "ENEMY DEPLOYING" }}
          </span>
          <span
            v-else
            class="ml-auto inline-flex items-baseline gap-2.5"
            :aria-label="`Series score: you ${engagement.view.myScore}, ${opponentName} ${engagement.view.theirScore}`"
          >
            <span class="label">Series</span>
            <span class="hd text-[22px] text-sonar-bright">
              {{ pad2(engagement.view.myScore) }}–{{ pad2(engagement.view.theirScore) }}
            </span>
          </span>
        </template>
      </div>
    </div>

    <main class="mx-auto max-w-[1240px] px-4 pb-12 pt-6 sm:px-6">
      <p v-if="error" role="alert" class="mb-4 mt-0 border border-sonar-flare px-4 py-3 text-sonar-flare-text">
        {{ error }}
      </p>

      <section v-if="!engagement" class="panel mx-auto max-w-[560px]" role="status">
        <template v-if="searching">
          <h1 class="hd m-0 text-xl text-sonar-bright">Locating engagement…</h1>
        </template>
        <template v-else>
          <h1 class="hd m-0 text-xl text-sonar-bright">Engagement not found</h1>
          <p class="mb-4 text-sonar-muted">This game is hidden, was removed, or belongs to another account.</p>
          <RouterLink :to="{ name: 'home' }" class="btn-outline">Back to engagements</RouterLink>
        </template>
      </section>

      <section v-else-if="engagement.theirs === null" class="panel mx-auto max-w-[560px]">
        <h1 class="hd m-0 text-xl text-sonar-bright">Game unavailable</h1>
        <p class="mb-4 text-sonar-muted">{{ opponentName }} removed this game, or it is no longer shared with you.</p>
        <RouterLink :to="{ name: 'home' }" class="btn-outline">Back to engagements</RouterLink>
      </section>

      <FleetSetup
        v-else-if="engagement.phase === 'deploy'"
        :key="`setup-${round}`"
        :opponent-name="opponentName"
        :opponent-ready="engagement.view.opponentSetup"
        :busy="busy"
        @lock="lockFleet"
      />

      <BattleStation
        v-else
        :view="engagement.view"
        :phase="engagement.phase"
        :opponent-name="opponentName"
        :sending="sending"
        :busy="busy"
        @fire="fire"
        @rematch="rematch"
      />
    </main>
  </div>
</template>
