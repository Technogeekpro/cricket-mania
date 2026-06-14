import {
  Check,
  ChevronRight,
  ClipboardList,
  RotateCcw,
  Shield,
  Swords,
  Trophy,
  Users,
} from "lucide-react";
import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

type Skill = "Bat" | "Bowl" | "WK";
type Screen = "setup" | "draft" | "teams" | "score";
type TeamKey = "a" | "b";
type ExtraType = "WD" | "NB" | "B" | "LB";

type Player = {
  id: string;
  name: string;
  skills: Skill[];
};

type Delivery = {
  id: string;
  label: string;
  runs: number;
  legal: boolean;
  wicket?: boolean;
  extra?: ExtraType;
};

type ScoreState = {
  battingTeam: TeamKey;
  runs: number;
  wickets: number;
  legalBalls: number;
  strikerId: string;
  nonStrikerId: string;
  bowlerId: string;
  nextBatterIndex: number;
  deliveries: Delivery[];
};

type AppState = {
  screen: Screen;
  playerText: string;
  players: Player[];
  teamSize: number;
  captainAId: string;
  captainBId: string;
  teams: Record<TeamKey, string[]>;
  currentPick: TeamKey;
  score: ScoreState | null;
};

const starterNames = [
  "Arjun",
  "Sameer",
  "Rohit",
  "Vikash",
  "Imran",
  "Karan",
  "Ravi",
  "Nilesh",
  "Deepak",
  "Manoj",
  "Amit",
  "Faiz",
];

const TEAM_SIZES = [5, 6, 7, 8, 10, 11];
const STORAGE_KEY = "cricket-mania-mobile-state-v1";

const skillPatterns: Skill[][] = [
  ["Bat", "Bowl"],
  ["Bat"],
  ["Bowl", "Bat"],
  ["Bat", "WK"],
  ["Bowl"],
  ["Bat", "Bowl"],
  ["Bat"],
  ["Bowl", "WK"],
];

const namesToPlayers = (text: string): Player[] => {
  const names = text
    .split(/\n|,/)
    .map((name) => name.trim())
    .filter(Boolean);

  const uniqueNames = Array.from(new Set(names));

  return uniqueNames.map((name, index) => ({
    id: `player-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || index}-${index}`,
    name,
    skills: skillPatterns[index % skillPatterns.length],
  }));
};

const makeDefaultState = (): AppState => {
  const playerText = starterNames.join("\n");
  const players = namesToPlayers(playerText);

  return {
    screen: "setup",
    playerText,
    players,
    teamSize: 6,
    captainAId: players[0]?.id ?? "",
    captainBId: players[1]?.id ?? "",
    teams: { a: [], b: [] },
    currentPick: "a",
    score: null,
  };
};

const safeLoadState = (): AppState => {
  if (typeof window === "undefined") {
    return makeDefaultState();
  }

  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      return makeDefaultState();
    }

    const parsed = JSON.parse(saved) as AppState;
    if (!Array.isArray(parsed.players) || parsed.players.length < 2) {
      return makeDefaultState();
    }

    return parsed;
  } catch {
    return makeDefaultState();
  }
};

const getOvers = (legalBalls: number) => `${Math.floor(legalBalls / 6)}.${legalBalls % 6}`;
const otherTeam = (team: TeamKey): TeamKey => (team === "a" ? "b" : "a");

export function App() {
  const [state, setState] = usePersistentState();

  const playerMap = new Map(state.players.map((player) => [player.id, player]));
  const captainA = playerMap.get(state.captainAId);
  const captainB = playerMap.get(state.captainBId);
  const teamsReady = state.teams.a.length === state.teamSize && state.teams.b.length === state.teamSize;
  const draftStarted = state.teams.a.length > 0 || state.teams.b.length > 0;
  const requiredPlayers = state.teamSize * 2;
  const hasEnoughPlayers = state.players.length >= requiredPlayers;
  const captainsReady = Boolean(captainA && captainB && state.captainAId !== state.captainBId);
  const setupReady = hasEnoughPlayers && captainsReady;

  function updatePlayersFromText() {
    const players = namesToPlayers(state.playerText);
    const nextCaptainA = players.find((player) => player.name === captainA?.name)?.id ?? players[0]?.id ?? "";
    const nextCaptainB =
      players.find((player) => player.name === captainB?.name && player.id !== nextCaptainA)?.id ??
      players.find((player) => player.id !== nextCaptainA)?.id ??
      "";

    setState((current) => ({
      ...current,
      players,
      captainAId: nextCaptainA,
      captainBId: nextCaptainB,
      teams: { a: [], b: [] },
      currentPick: "a",
      score: null,
    }));
  }

  function startDraft() {
    if (!setupReady) {
      return;
    }

    setState((current) => ({
      ...current,
      screen: "draft",
      teams: {
        a: [current.captainAId],
        b: [current.captainBId],
      },
      currentPick: "a",
      score: null,
    }));
  }

  function pickPlayer(playerId: string) {
    setState((current) => {
      if (current.teams.a.includes(playerId) || current.teams.b.includes(playerId)) {
        return current;
      }

      const active = current.currentPick;
      if (current.teams[active].length >= current.teamSize) {
        return current;
      }

      const nextTeams = {
        ...current.teams,
        [active]: [...current.teams[active], playerId],
      };
      const nextTeam = otherTeam(active);
      const nextPick = nextTeams[nextTeam].length < current.teamSize ? nextTeam : active;
      const complete = nextTeams.a.length === current.teamSize && nextTeams.b.length === current.teamSize;

      return {
        ...current,
        teams: nextTeams,
        currentPick: nextPick,
        screen: complete ? "teams" : current.screen,
      };
    });
  }

  function removePick(team: TeamKey, playerId: string) {
    if (playerId === state.captainAId || playerId === state.captainBId) {
      return;
    }

    setState((current) => ({
      ...current,
      teams: {
        ...current.teams,
        [team]: current.teams[team].filter((id) => id !== playerId),
      },
      currentPick: team,
      score: null,
      screen: "draft",
    }));
  }

  function startScoring() {
    if (!teamsReady) {
      return;
    }

    const battingIds = state.teams.a;
    const bowlingIds = state.teams.b;

    setState((current) => ({
      ...current,
      screen: "score",
      score: {
        battingTeam: "a",
        runs: 0,
        wickets: 0,
        legalBalls: 0,
        strikerId: battingIds[0],
        nonStrikerId: battingIds[1],
        bowlerId: bowlingIds[0],
        nextBatterIndex: 2,
        deliveries: [],
      },
    }));
  }

  function addDelivery(runs: number, options: { extra?: ExtraType; wicket?: boolean } = {}) {
    setState((current) => {
      if (!current.score) {
        return current;
      }

      const legal = options.extra !== "WD" && options.extra !== "NB";
      const isExtra = Boolean(options.extra);
      const deliveryRuns = isExtra ? runs + 1 : runs;
      const legalBalls = current.score.legalBalls + (legal ? 1 : 0);
      const battingIds = current.teams[current.score.battingTeam];
      const maxWickets = Math.max(0, battingIds.length - 1);
      const wicketAllowed = Boolean(options.wicket && current.score.wickets < maxWickets);
      const wickets = current.score.wickets + (wicketAllowed ? 1 : 0);
      let strikerId = current.score.strikerId;
      let nonStrikerId = current.score.nonStrikerId;
      let nextBatterIndex = current.score.nextBatterIndex;

      if (wicketAllowed && nextBatterIndex < battingIds.length) {
        strikerId = battingIds[nextBatterIndex];
        nextBatterIndex += 1;
      } else if (!wicketAllowed && legal && runs % 2 === 1) {
        [strikerId, nonStrikerId] = [nonStrikerId, strikerId];
      }

      if (legal && legalBalls % 6 === 0) {
        [strikerId, nonStrikerId] = [nonStrikerId, strikerId];
      }

      const label = options.wicket
        ? "W"
        : options.extra
          ? `${options.extra}${runs > 0 ? `+${runs}` : ""}`
          : String(runs);

      const delivery: Delivery = {
        id: `${Date.now()}-${current.score.deliveries.length}`,
        label,
        runs: deliveryRuns,
        legal,
        wicket: wicketAllowed,
        extra: options.extra,
      };

      return {
        ...current,
        score: {
          ...current.score,
          runs: current.score.runs + deliveryRuns,
          wickets,
          legalBalls,
          strikerId,
          nonStrikerId,
          nextBatterIndex,
          deliveries: [delivery, ...current.score.deliveries].slice(0, 30),
        },
      };
    });
  }

  function resetMatch() {
    setState(makeDefaultState());
  }

  return (
    <main className="page-shell">
      <section className="phone-shell" aria-label="Cricket Mania mobile app">
        <header className="app-header">
          <div className="top-bar">
            <button className="icon-button" aria-label="Menu">
              <ClipboardList size={22} />
            </button>
            <h1>
              Cricket <span>Mania</span>
            </h1>
            <button className="icon-button" aria-label="Reset app" onClick={resetMatch}>
              <RotateCcw size={21} />
            </button>
          </div>
          <div className="match-strip">
            <strong>Turf Match</strong>
            <span>{state.players.length} Players</span>
            <span>{state.teamSize}v{state.teamSize}</span>
          </div>
        </header>

        <StepTracker screen={state.screen} draftStarted={draftStarted} teamsReady={teamsReady} />

        <div className="screen-body">
          {state.screen === "setup" && (
            <SetupScreen
              state={state}
              setupReady={setupReady}
              hasEnoughPlayers={hasEnoughPlayers}
              requiredPlayers={requiredPlayers}
              onState={setState}
              onApplyPlayers={updatePlayersFromText}
              onStartDraft={startDraft}
            />
          )}

          {state.screen === "draft" && (
            <DraftScreen
              state={state}
              playerMap={playerMap}
              teamsReady={teamsReady}
              onPickPlayer={pickPlayer}
              onRemovePick={removePick}
              onStartScoring={startScoring}
            />
          )}

          {state.screen === "teams" && (
            <TeamsScreen
              state={state}
              playerMap={playerMap}
              onBackToDraft={() => setState((current) => ({ ...current, screen: "draft" }))}
              onStartScoring={startScoring}
            />
          )}

          {state.screen === "score" && state.score && (
            <ScoreScreen
              state={state}
              playerMap={playerMap}
              onDelivery={addDelivery}
              onBackToTeams={() => setState((current) => ({ ...current, screen: "teams" }))}
            />
          )}
        </div>

        <nav className="bottom-nav" aria-label="Primary">
          <NavButton
            icon={<Users size={22} />}
            label="Players"
            active={state.screen === "setup" || state.screen === "draft"}
            onClick={() => setState((current) => ({ ...current, screen: draftStarted ? "draft" : "setup" }))}
          />
          <NavButton
            icon={<Shield size={22} />}
            label="Teams"
            active={state.screen === "teams"}
            disabled={!draftStarted}
            onClick={() => setState((current) => ({ ...current, screen: "teams" }))}
          />
          <NavButton
            icon={<Swords size={22} />}
            label="Score"
            active={state.screen === "score"}
            disabled={!teamsReady}
            onClick={() => (state.score ? setState((current) => ({ ...current, screen: "score" })) : startScoring())}
          />
        </nav>
      </section>
    </main>
  );
}

function usePersistentState() {
  const [state, setState] = useState<AppState>(safeLoadState);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  return [state, setState] as const;
}

function StepTracker({
  screen,
  draftStarted,
  teamsReady,
}: {
  screen: Screen;
  draftStarted: boolean;
  teamsReady: boolean;
}) {
  const steps = [
    { id: "setup", label: "Setup", helper: "Players", complete: draftStarted },
    { id: "draft", label: "Pick", helper: "Draft teams", complete: teamsReady },
    { id: "score", label: "Score", helper: "Start match", complete: screen === "score" },
  ] as const;

  return (
    <section className="stepper" aria-label="Match setup progress">
      {steps.map((step, index) => {
        const active = step.id === screen || (step.id === "draft" && screen === "teams");
        return (
          <div className={`step ${active ? "active" : ""} ${step.complete ? "complete" : ""}`} key={step.id}>
            <div className="step-line" />
            <div className="step-number">{step.complete ? <Check size={16} /> : index + 1}</div>
            <strong>{step.label}</strong>
            <span>{step.helper}</span>
          </div>
        );
      })}
    </section>
  );
}

function SetupScreen({
  state,
  setupReady,
  hasEnoughPlayers,
  requiredPlayers,
  onState,
  onApplyPlayers,
  onStartDraft,
}: {
  state: AppState;
  setupReady: boolean;
  hasEnoughPlayers: boolean;
  requiredPlayers: number;
  onState: Dispatch<SetStateAction<AppState>>;
  onApplyPlayers: () => void;
  onStartDraft: () => void;
}) {
  return (
    <section className="stack">
      <div className="hero-card">
        <div>
          <p className="eyebrow">Quick gully setup</p>
          <h2>Make fair teams before the first ball.</h2>
        </div>
        <Trophy size={42} />
      </div>

      <label className="field-card">
        <span>Paste or type player names</span>
        <textarea
          value={state.playerText}
          rows={8}
          onChange={(event) => onState((current) => ({ ...current, playerText: event.target.value }))}
        />
      </label>
      <button className="secondary-action" onClick={onApplyPlayers}>
        Update player list
      </button>

      <section className="panel">
        <div className="panel-title">
          <h3>Match size</h3>
          <span>{state.players.length} available</span>
        </div>
        <div className="segmented-grid">
          {TEAM_SIZES.map((size) => (
            <button
              className={state.teamSize === size ? "selected" : ""}
              key={size}
              onClick={() =>
                onState((current) => ({
                  ...current,
                  teamSize: size,
                  teams: { a: [], b: [] },
                  score: null,
                }))
              }
            >
              {size}v{size}
            </button>
          ))}
        </div>
        {!hasEnoughPlayers && <p className="warning">Need {requiredPlayers} players for this match size.</p>}
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Choose captains</h3>
          <span>Locked into teams</span>
        </div>
        <div className="captain-selectors">
          <label>
            <span>Captain A</span>
            <select
              value={state.captainAId}
              onChange={(event) =>
                onState((current) => ({
                  ...current,
                  captainAId: event.target.value,
                  teams: { a: [], b: [] },
                  score: null,
                }))
              }
            >
              {state.players.map((player) => (
                <option value={player.id} key={player.id}>
                  {player.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Captain B</span>
            <select
              value={state.captainBId}
              onChange={(event) =>
                onState((current) => ({
                  ...current,
                  captainBId: event.target.value,
                  teams: { a: [], b: [] },
                  score: null,
                }))
              }
            >
              {state.players.map((player) => (
                <option value={player.id} key={player.id}>
                  {player.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {state.captainAId === state.captainBId && <p className="warning">Pick two different captains.</p>}
      </section>

      <button className="sticky-action" disabled={!setupReady} onClick={onStartDraft}>
        Start captain draft <ChevronRight size={20} />
      </button>
    </section>
  );
}

function DraftScreen({
  state,
  playerMap,
  teamsReady,
  onPickPlayer,
  onRemovePick,
  onStartScoring,
}: {
  state: AppState;
  playerMap: Map<string, Player>;
  teamsReady: boolean;
  onPickPlayer: (playerId: string) => void;
  onRemovePick: (team: TeamKey, playerId: string) => void;
  onStartScoring: () => void;
}) {
  const currentCaptain = playerMap.get(state.currentPick === "a" ? state.captainAId : state.captainBId);
  const availablePlayers = state.players.filter(
    (player) => !state.teams.a.includes(player.id) && !state.teams.b.includes(player.id),
  );

  return (
    <section className="stack">
      <div className="captain-grid">
        <CaptainPanel
          tone="green"
          title="Captain"
          captain={playerMap.get(state.captainAId)}
          count={state.teams.a.length}
          teamSize={state.teamSize}
        />
        <div className="turn-card">
          <span>picks next</span>
          <strong>{currentCaptain?.name ?? "Captain"}</strong>
          <div className="turn-dots" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
        <CaptainPanel
          tone="blue"
          title="Captain"
          captain={playerMap.get(state.captainBId)}
          count={state.teams.b.length}
          teamSize={state.teamSize}
        />
      </div>

      <div className="team-chip-grid">
        <DraftedTeam
          name={`${playerMap.get(state.captainAId)?.name ?? "Team A"} XI`}
          ids={state.teams.a}
          team="a"
          playerMap={playerMap}
          onRemove={onRemovePick}
        />
        <DraftedTeam
          name={`${playerMap.get(state.captainBId)?.name ?? "Team B"} XI`}
          ids={state.teams.b}
          team="b"
          playerMap={playerMap}
          onRemove={onRemovePick}
        />
      </div>

      <div className="tip-row">Teams stay balanced because captains pick turn by turn.</div>

      <section className="panel player-list">
        <div className="panel-title">
          <h3>Available players ({availablePlayers.length})</h3>
          <span>Tap to pick</span>
        </div>
        {availablePlayers.map((player) => (
          <button className="player-row" key={player.id} onClick={() => onPickPlayer(player.id)}>
            <Avatar name={player.name} />
            <span className="player-main">
              <strong>{player.name}</strong>
              <SkillChips skills={player.skills} />
            </span>
            <span className="plus-button">+</span>
          </button>
        ))}
        {availablePlayers.length === 0 && <p className="empty-note">All players are drafted.</p>}
      </section>

      <section className="score-ready-card">
        <div className="bat-icon" aria-hidden="true">
          <span />
        </div>
        <div>
          <h3>{teamsReady ? "Ready to score?" : "Finish both teams"}</h3>
          <p>
            {teamsReady
              ? "Lock the XIs and start the gully scorecard."
              : `Both sides need ${state.teamSize} players before scoring starts.`}
          </p>
        </div>
        <button disabled={!teamsReady} onClick={onStartScoring}>
          Start
        </button>
      </section>
    </section>
  );
}

function TeamsScreen({
  state,
  playerMap,
  onBackToDraft,
  onStartScoring,
}: {
  state: AppState;
  playerMap: Map<string, Player>;
  onBackToDraft: () => void;
  onStartScoring: () => void;
}) {
  return (
    <section className="stack">
      <div className="hero-card">
        <div>
          <p className="eyebrow">Teams locked</p>
          <h2>Check the XIs, then start scoring.</h2>
        </div>
        <Shield size={42} />
      </div>
      <FullTeamCard title={`${playerMap.get(state.captainAId)?.name ?? "Team A"} XI`} ids={state.teams.a} playerMap={playerMap} />
      <FullTeamCard title={`${playerMap.get(state.captainBId)?.name ?? "Team B"} XI`} ids={state.teams.b} playerMap={playerMap} />
      <div className="dual-actions">
        <button className="secondary-action" onClick={onBackToDraft}>
          Edit picks
        </button>
        <button className="primary-action" onClick={onStartScoring}>
          Start scoring
        </button>
      </div>
    </section>
  );
}

function ScoreScreen({
  state,
  playerMap,
  onDelivery,
  onBackToTeams,
}: {
  state: AppState;
  playerMap: Map<string, Player>;
  onDelivery: (runs: number, options?: { extra?: ExtraType; wicket?: boolean }) => void;
  onBackToTeams: () => void;
}) {
  const score = state.score!;
  const battingCaptain = playerMap.get(score.battingTeam === "a" ? state.captainAId : state.captainBId);
  const striker = playerMap.get(score.strikerId);
  const nonStriker = playerMap.get(score.nonStrikerId);
  const bowler = playerMap.get(score.bowlerId);

  return (
    <section className="stack score-screen">
      <div className="score-hero">
        <span>{battingCaptain?.name ?? "Team"} XI batting</span>
        <strong>
          {score.runs}/{score.wickets}
        </strong>
        <small>{getOvers(score.legalBalls)} overs</small>
      </div>

      <div className="crease-grid">
        <PlayerStat label="Striker" value={striker?.name ?? "-"} highlight />
        <PlayerStat label="Non-striker" value={nonStriker?.name ?? "-"} />
        <PlayerStat label="Bowler" value={bowler?.name ?? "-"} />
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>Runs</h3>
          <span>Legal ball</span>
        </div>
        <div className="run-grid">
          {[0, 1, 2, 3, 4, 6].map((run) => (
            <button key={run} onClick={() => onDelivery(run)}>
              {run}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Gully extras</h3>
          <span>Quick add</span>
        </div>
        <div className="extras-grid">
          <button onClick={() => onDelivery(0, { extra: "WD" })}>Wide</button>
          <button onClick={() => onDelivery(0, { extra: "NB" })}>No ball</button>
          <button onClick={() => onDelivery(0, { extra: "B" })}>Bye</button>
          <button onClick={() => onDelivery(0, { extra: "LB" })}>Leg bye</button>
          <button className="danger" onClick={() => onDelivery(0, { wicket: true })}>
            Wicket
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Recent balls</h3>
          <span>{score.deliveries.length} balls</span>
        </div>
        <div className="ball-strip">
          {score.deliveries.slice(0, 12).map((delivery) => (
            <span className={delivery.wicket ? "wicket-ball" : ""} key={delivery.id}>
              {delivery.label}
            </span>
          ))}
          {score.deliveries.length === 0 && <p className="empty-note">Score the first ball to start the feed.</p>}
        </div>
      </section>

      <button className="secondary-action" onClick={onBackToTeams}>
        View teams
      </button>
    </section>
  );
}

function CaptainPanel({
  tone,
  title,
  captain,
  count,
  teamSize,
}: {
  tone: "green" | "blue";
  title: string;
  captain?: Player;
  count: number;
  teamSize: number;
}) {
  return (
    <section className={`captain-panel ${tone}`}>
      <Avatar name={captain?.name ?? "Captain"} />
      <div>
        <span>{title}</span>
        <strong>{captain?.name ?? "-"}</strong>
        <p>
          {count} / {teamSize} picks
        </p>
      </div>
      <progress value={count} max={teamSize} />
    </section>
  );
}

function DraftedTeam({
  name,
  ids,
  team,
  playerMap,
  onRemove,
}: {
  name: string;
  ids: string[];
  team: TeamKey;
  playerMap: Map<string, Player>;
  onRemove: (team: TeamKey, playerId: string) => void;
}) {
  return (
    <section className="drafted-team">
      <header>
        <strong>{name}</strong>
        <span>{ids.length}</span>
      </header>
      <div>
        {ids.map((id) => (
          <button key={id} onClick={() => onRemove(team, id)}>
            {playerMap.get(id)?.name}
          </button>
        ))}
      </div>
    </section>
  );
}

function FullTeamCard({ title, ids, playerMap }: { title: string; ids: string[]; playerMap: Map<string, Player> }) {
  return (
    <section className="panel full-team">
      <div className="panel-title">
        <h3>{title}</h3>
        <span>{ids.length} players</span>
      </div>
      {ids.map((id, index) => {
        const player = playerMap.get(id);
        return (
          <div className="team-row" key={id}>
            <span>{index + 1}</span>
            <Avatar name={player?.name ?? "P"} />
            <strong>{player?.name}</strong>
            <SkillChips skills={player?.skills ?? []} />
          </div>
        );
      })}
    </section>
  );
}

function PlayerStat({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`player-stat ${highlight ? "highlight" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="avatar" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function SkillChips({ skills }: { skills: Skill[] }) {
  return (
    <span className="skill-row">
      {skills.map((skill) => (
        <i className={`skill ${skill.toLowerCase()}`} key={skill}>
          {skill}
        </i>
      ))}
    </span>
  );
}

function NavButton({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={active ? "active" : ""} disabled={disabled} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
