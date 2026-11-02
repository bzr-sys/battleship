# Bazaar Battleship

The classic two-player Battleship game, built as a [Bazaar](https://bzr.dev) example app. There is no app backend and no referee: each player keeps their half of a game in their own Bazaar database and shares it read-only with the opponent. See [Fair play](#fair-play).

**Live app: https://bzr-sys.github.io/battleship/**

## Features

- Sign up or log in with a Bazaar account
- Challenge another Bazaar user directly (**Challenge a player**), or open a one-time invite link (**Open an invite link**) to send to anyone
- Deploy your five ships by clicking or tapping (**R** or **Rotate** turns a ship, **Auto-deploy** places them all), then take turns firing at your opponent's waters
- A shot log, last-shot markers and a damage report show what was hit and sunk
- Rematches keep a running series score per opponent
- Games update live for both players, and the lobby shows whose turn it is in every game
- Fleets stay hidden, and each client checks the other at the end: a shot stays pending until the target's client answers, and the screen says when a cheat is detected

## How it uses Bazaar

| Bazaar feature          | Used for                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Collections (`games`)   | Each player's half of a game: fleet hash, shots, answers, and at the end fleet and salt           |
| Collections (`secrets`) | Private, no grant: the player's fleet and salt, and their own copy of the opponent's moves        |
| Permissions             | Each player grants the other `read` on their half (`filter: { id: gameId }`). Nobody has `update` |
| Shareable links         | **Open an invite link** makes a single-use link with `read` on the host's half                    |
| Granted permissions     | A grant from the host makes the guest create their half and grant `read` back                     |
| Contexts                | Each client reads the opponent's half from the opponent's database                                |
| Subscriptions           | Both players get moves in real time                                                               |

The Bazaar setup is in `src/bazaar.ts`, the game rules in `src/game.ts`, the checks in `src/fairplay.ts`, the data handling in `src/stores/bazaar.ts`, and the screens in `src/views/` and `src/components/`.

## Fair play

Nothing but the two clients runs a game, so nothing can force a client to be honest. The design makes cheating either impossible or visible:

1. Before the first shot, each player publishes `SHA-256(fleet + salt)`. The fleet and salt stay in `secrets`.
2. The target's client answers each shot with hit, miss or sunk, on its own, whichever screen is open. Until it does, the shot is pending.
3. When the game ends, both publish fleet and salt. Each client checks the hash, a legal layout and every answer it got.
4. Each client copies the opponent's moves to `secrets` as it sees them, and flags any later difference.

| Cheat                        | Result                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| Peeking at the other's fleet | Prevented: no grant on `secrets`, and only a hash in `games`                           |
| Changing the other's moves   | Prevented: each half has one writer                                                    |
| Editing your own past moves  | Detected, as soon as the other client sees it. Undoing the edit doesn't clear the flag |
| Lying about a hit            | Detected at the end, not prevented                                                     |
| Refusing to reveal           | A forfeit on the other client after an hour, unenforceable. A later reveal is checked  |

A detected cheat or forfeit counts as a win for the honest player, on their client only. There's no shared result, so the two series scores can differ.

Games from before this design are listed under **Old games** in the lobby. They can be hidden but not continued, and their scores no longer count.

## Tech stack

Vue 3, Vite, Pinia, Vue Router (hash history), Tailwind CSS, and the [`@bzr/bazaar`](https://www.npmjs.com/package/@bzr/bazaar) SDK.

## Run locally

You need Node.js 24 or newer (required by the mock server) and pnpm 9 (`npm install -g pnpm@9`, or `corepack enable`).

In development the app talks to a local Bazaar mock server on `http://localhost:3377` instead of the real service (see `src/bazaar.ts`). The mock is installed as a dev dependency ([`@bzr/bazaar-mock`](https://www.npmjs.com/package/@bzr/bazaar-mock)).

```sh
pnpm install

# Terminal 1: start the mock server and register the app's dev URL
pnpm exec bzr -u http://localhost:5173/battleship/

# Terminal 2: start the app against the mock app ID "test"
VITE_APP_ID=test pnpm dev
```

Open http://localhost:5173/battleship/ and click **Sign up or Log in**. In the popup:

1. Enter any email address and click **Log In or Sign Up**. There is no password or code.
2. First time only: pick a handle (at least 4 letters or digits) and a name, then click **Complete Setup**.
3. Click **Authorize**.

To play against yourself, open a second browser profile or a private window and sign up with a different email. Both players use the same mock server.

Notes:

- The mock keeps its data in memory, so restarting it wipes all users and games.
- The redirect URL has to match exactly. If Vite starts on a port other than 5173, restart the mock with that URL (`pnpm exec bzr -u http://localhost:<port>/battleship/`).
- `pnpm exec bzr -h` lists the other mock options (app ID, port, extra redirect URIs).

### Scripts

| Command           | What it does                                     |
| ----------------- | ------------------------------------------------ |
| `pnpm dev`        | Start the Vite dev server with hot reload        |
| `pnpm build`      | Type-check and build for production into `dist/` |
| `pnpm preview`    | Serve the production build locally               |
| `pnpm type-check` | Run `vue-tsc`                                    |
| `pnpm lint`       | Run ESLint (with `--fix`)                        |
| `pnpm format`     | Format `src/` with Prettier                      |

## Deployment

Every push to `main` runs `.github/workflows/build_battleship.yml`. It builds the app with the production Bazaar app ID (`VITE_APP_ID`) and publishes `dist/` to GitHub Pages at https://bzr-sys.github.io/battleship/.

The Pages path is set by `base` in `vite.config.ts`. If you deploy somewhere else, change `base`, and register the new URL as a redirect URI for the app in the [Bazaar dashboard](https://cloud.bzr.dev).
