import {
  Activity,
  Camera,
  ChevronRight,
  ClipboardList,
  Flag,
  Gauge,
  LogOut,
  Mail,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Share2,
  Shield,
  Target,
  UserCog,
  UserCheck,
  Swords,
  Trophy,
  UserPlus,
  UserX,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import grassGroundLineupUrl from "./assets/grass-ground-lineup.jpg";
import { supabase } from "./lib/supabase";
import type { AppRole, CaptainTeam, Delivery, Match, MatchPlayer, Profile, TeamKey, UserRole, WinnerTeam } from "./lib/database.types";

type Tab = "scoreboard" | "players" | "team" | "umpire" | "manage";
type ExtraType = "WD" | "NB" | "B" | "LB";

type CareerMatch = {
  matchId: string;
  title: string;
  createdAt: string;
  teamKey: "pool" | "a" | "b";
  result: "won" | "lost" | "tie" | "pending";
  runs: number;
  balls: number;
  wickets: number;
};

type CareerStats = {
  played: number;
  wins: number;
  losses: number;
  ties: number;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  wicketsTaken: number;
  ballsBowled: number;
  runsConceded: number;
  recent: CareerMatch[];
};

type LineupGroup = "WICKET-KEEPERS" | "BATTERS" | "ALL-ROUNDERS" | "BOWLERS";

const TEAM_SIZES = [5, 6, 7, 8, 10, 11];
const PRODUCTION_URL = "https://cricket-mania-tau.vercel.app/";
const AVATAR_BUCKET = "profile-photos";
const TEAM_LOGOS_BUCKET = "team-logos";
const PENDING_AVATAR_KEY = "cricket-mania-pending-avatar-v1";

const getAuthRedirectUrl = () => {
  if (typeof window === "undefined") {
    return PRODUCTION_URL;
  }

  const origin = window.location.origin;
  if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
    return origin;
  }

  return `${origin}/`;
};

const getOvers = (legalBalls: number) => `${Math.floor(legalBalls / 6)}.${legalBalls % 6}`;

const formatRate = (value: number) => (Number.isFinite(value) && value > 0 ? value.toFixed(2) : "0.00");

const runRate = (runs: number, legalBalls: number) => (legalBalls > 0 ? (runs * 6) / legalBalls : 0);

const strikeRate = (runs: number, balls: number) => (balls > 0 ? (runs / balls) * 100 : 0);

const requiredRunRate = (target: number, runs: number, totalBalls: number, legalBalls: number) => {
  const ballsLeft = totalBalls - legalBalls;
  return ballsLeft > 0 ? ((target - runs) * 6) / ballsLeft : 0;
};

const teamLabel = (key: TeamKey, match?: Match | null) =>
  match
    ? (key === "a" ? match.team_a_name : match.team_b_name) || (key === "a" ? "First team" : "Second team")
    : key === "a"
      ? "First team"
      : "Second team";
const teamLogoUrl = (key: TeamKey, match: Match) => (key === "a" ? match.team_a_logo_url : match.team_b_logo_url);
const matchResultNote = (match: Match) =>
  match.result_note?.replace(/^Team A/, teamLabel("a", match)).replace(/^Team B/, teamLabel("b", match)) ?? null;
const otherTeam = (key: TeamKey): TeamKey => (key === "a" ? "b" : "a");

const LINEUP_GROUPS: LineupGroup[] = ["WICKET-KEEPERS", "BATTERS", "ALL-ROUNDERS", "BOWLERS"];

const playerSkillText = (skills: string[]) => (skills.length > 0 ? skills.join(" · ") : "Player");

const shortPlayerName = (name: string) => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return name;
  }
  return `${parts[0].slice(0, 1)} ${parts.slice(1).join(" ")}`;
};

const getLineupGroup = (skills: string[]): LineupGroup => {
  const normalized = skills.join(" ").toLowerCase();
  if (/\b(wk|keeper|wicket)\b/.test(normalized)) {
    return "WICKET-KEEPERS";
  }
  if (/\b(all|all-rounder|allrounder|ar)\b/.test(normalized)) {
    return "ALL-ROUNDERS";
  }
  if (/\b(bowl|bowler)\b/.test(normalized)) {
    return "BOWLERS";
  }
  return "BATTERS";
};

const playerImpact = (player: MatchPlayer) =>
  player.runs_scored +
  player.fours * 2 +
  player.sixes * 3 +
  player.wickets_taken * 25 +
  Math.floor(player.balls_bowled / 6) * 2 -
  Math.floor(player.runs_conceded / 12);

async function shareContent(
  payload: { title: string; text: string; url?: string },
  onFallback?: (message: string) => void,
) {
  const url = payload.url ?? PRODUCTION_URL;

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ title: payload.title, text: payload.text, url });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
    }
  }

  try {
    await navigator.clipboard.writeText(`${payload.text} ${url}`.trim());
    onFallback?.("Copied to clipboard.");
  } catch {
    onFallback?.("Sharing is not supported on this device.");
  }
}

type PendingAvatar = {
  email: string;
  dataUrl: string;
};

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const dataUrlToBlob = async (dataUrl: string) => {
  const response = await fetch(dataUrl);
  return response.blob();
};

const compressSquareAvatar = (file: File) =>
  new Promise<Blob>((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Please choose an image file."));
      return;
    }

    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      const sx = (image.naturalWidth - side) / 2;
      const sy = (image.naturalHeight - side) / 2;
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 512;
      const context = canvas.getContext("2d");

      if (!context) {
        reject(new Error("Could not process this image."));
        return;
      }

      context.drawImage(image, sx, sy, side, side, 0, 0, 512, 512);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Could not compress this image."));
            return;
          }
          resolve(blob);
        },
        "image/webp",
        0.82,
      );
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not read this image."));
    };

    image.src = objectUrl;
  });

async function uploadAvatarBlob(userId: string, blob: Blob, oldPath?: string | null) {
  const path = `${userId}/avatar-${Date.now()}.webp`;
  const { error: uploadError } = await supabase.storage.from(AVATAR_BUCKET).upload(path, blob, {
    contentType: "image/webp",
    cacheControl: "31536000",
    upsert: false,
  });

  if (uploadError) {
    throw uploadError;
  }

  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  const publicUrl = `${data.publicUrl}?v=${Date.now()}`;
  const { data: profile, error: updateError } = await supabase
    .from("profiles")
    .update({ avatar_url: publicUrl, avatar_path: path })
    .eq("id", userId)
    .select()
    .single();

  if (updateError) {
    throw updateError;
  }

  if (oldPath && oldPath !== path) {
    await supabase.storage.from(AVATAR_BUCKET).remove([oldPath]);
  }

  return profile as Profile;
}

async function uploadTeamLogoBlob(userId: string, scope: string, blob: Blob) {
  const path = `${userId}/team-${scope}-${Date.now()}.webp`;
  const { error: uploadError } = await supabase.storage.from(TEAM_LOGOS_BUCKET).upload(path, blob, {
    contentType: "image/webp",
    cacheControl: "31536000",
    upsert: false,
  });

  if (uploadError) {
    throw uploadError;
  }

  const { data } = supabase.storage.from(TEAM_LOGOS_BUCKET).getPublicUrl(path);
  return { path, publicUrl: `${data.publicUrl}?v=${Date.now()}` };
}

function formatErrorMessage(error: unknown, fallback: string): string {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object") {
    const obj = error as Record<string, unknown>;
    const message = (obj.message ?? obj.error ?? obj.msg) as string | undefined;
    const code = (obj.statusCode ?? obj.status ?? obj.code) as string | number | undefined;
    if (message) return code ? `${message} (${code})` : message;
    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") return json;
    } catch {
      // ignore
    }
  }
  return fallback;
}

const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [role, setRole] = useState<AppRole>("player");
  const [matches, setMatches] = useState<Match[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [matchPlayers, setMatchPlayers] = useState<MatchPlayer[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [roles, setRoles] = useState<UserRole[]>([]);
  const [captainTeams, setCaptainTeams] = useState<CaptainTeam[]>([]);
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("scoreboard");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [career, setCareer] = useState<CareerStats | null>(null);

  const activeMatch = useMemo(
    () => matches.find((match) => match.id === activeMatchId) ?? matches[0] ?? null,
    [activeMatchId, matches],
  );

  const isAdmin = role === "admin";
  const isCaptain = role === "captain";
  const captainTeamKey =
    activeMatch?.captain_a_id === session?.user.id ? "a" : activeMatch?.captain_b_id === session?.user.id ? "b" : null;
  const ownedCaptainTeam = captainTeams.find((team) => team.captain_id === session?.user.id) ?? null;
  const showTeamTab = !isAdmin && (isCaptain || Boolean(captainTeamKey));

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (mounted) {
        setSession(data.session);
        setAuthLoading(false);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setProfile(null);
      setRole("player");
      setNotice("");
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setMatches([]);
      setDeliveries([]);
      setMatchPlayers([]);
      setProfiles([]);
      setRoles([]);
      setCaptainTeams([]);
      return;
    }

    void loadAppData(session.user.id);
  }, [session?.user]);

  useEffect(() => {
    if (!session?.user) {
      return;
    }

    const channel = supabase
      .channel("cricket-mania-scoreboard")
      .on("postgres_changes", { event: "*", schema: "public", table: "matches" }, () => {
        void loadMatches();
        if (session.user) {
          void loadMyCareer(session.user.id);
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "deliveries" }, () => {
        if (activeMatch?.id) {
          void loadDeliveries(activeMatch.id);
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "match_players" }, () => {
        if (activeMatch?.id) {
          void loadMatchPlayers(activeMatch.id);
        }
        if (session.user) {
          void loadMyCareer(session.user.id);
        }
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "captain_teams" }, () => {
        void loadCaptainTeams();
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session?.user, activeMatch?.id]);

  useEffect(() => {
    if (activeMatch?.id) {
      void Promise.all([loadDeliveries(activeMatch.id), loadMatchPlayers(activeMatch.id)]);
    }
  }, [activeMatch?.id]);

  useEffect(() => {
    if ((tab === "umpire" || tab === "manage") && !isAdmin) {
      setTab("scoreboard");
      return;
    }
    if (tab === "team" && !showTeamTab) {
      setTab("scoreboard");
      return;
    }
    if (tab === "players" && isAdmin) {
      setTab("umpire");
    }
  }, [isAdmin, showTeamTab, tab]);

  useEffect(() => {
    if (isAdmin && tab === "scoreboard") {
      setTab("umpire");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  async function loadAppData(userId: string) {
    setBusy(true);
    try {
      const [profileResult, roleResult] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", userId).maybeSingle(),
        supabase.from("user_roles").select("*").eq("user_id", userId).maybeSingle(),
      ]);

      if (profileResult.error) {
        console.error("[profile load failed]", profileResult.error);
        setNotice(formatErrorMessage(profileResult.error, "Could not load profile."));
      }
      if (roleResult.error) {
        console.error("[role load failed]", roleResult.error);
      }

      const profileData = profileResult.data;
      const roleData = roleResult.data;

      let nextProfile = (profileData ?? null) as Profile | null;
      nextProfile = await uploadPendingAvatarIfNeeded(userId, nextProfile);
      setProfile(nextProfile);
      if (nextProfile?.is_banned) {
        setRole("player");
        setMatches([]);
        setDeliveries([]);
        setMatchPlayers([]);
        setProfiles([]);
        setRoles([]);
        setCaptainTeams([]);
        return;
      }
      setRole(roleData?.role ?? "player");

      await loadMyCareer(userId);

      const loadedMatches = await loadMatches();
      const assignedAsCaptain = loadedMatches.some(
        (match) => match.captain_a_id === userId || match.captain_b_id === userId,
      );
      if (roleData?.role === "admin" || roleData?.role === "captain" || assignedAsCaptain) {
        await loadPlayerProfiles(roleData?.role === "admin");
      }
      if (roleData?.role === "admin" || roleData?.role === "captain" || assignedAsCaptain) {
        await loadCaptainTeams();
      }
    } finally {
      setBusy(false);
    }
  }

  async function loadCaptainTeams() {
    const { data, error } = await supabase.from("captain_teams").select("*").order("created_at", { ascending: false });
    if (error) {
      setNotice(error.message);
      return [];
    }

    setCaptainTeams(data ?? []);
    return data ?? [];
  }

  async function loadMatches() {
    const { data, error } = await supabase.from("matches").select("*").order("created_at", { ascending: false });
    if (error) {
      setNotice(error.message);
      return [];
    }

    setMatches(data ?? []);
    setActiveMatchId((current) => current ?? data?.[0]?.id ?? null);
    return data ?? [];
  }

  async function loadDeliveries(matchId: string) {
    const { data, error } = await supabase
      .from("deliveries")
      .select("*")
      .eq("match_id", matchId)
      .order("created_at", { ascending: false })
      .limit(120);

    if (error) {
      setNotice(error.message);
      return;
    }

    setDeliveries(data ?? []);
  }

  async function loadMatchPlayers(matchId: string) {
    const { data, error } = await supabase
      .from("match_players")
      .select("*")
      .eq("match_id", matchId)
      .order("created_at", { ascending: true });

    if (error) {
      setNotice(error.message);
      return;
    }

    setMatchPlayers(data ?? []);
  }

  async function loadPlayerProfiles(includeRoles = isAdmin) {
    const { data: profileRows, error: profileError } = await supabase
      .from("profiles")
      .select("*")
      .order("created_at", { ascending: false });

    if (profileError) {
      setNotice(profileError.message);
      return;
    }

    setProfiles(profileRows ?? []);

    if (!includeRoles) {
      return;
    }

    const { data: roleRows, error: roleError } = await supabase.from("user_roles").select("*");

    if (roleError) {
      setNotice(roleError.message);
      return;
    }

    setRoles(roleRows ?? []);
  }

  async function loadAdminLists() {
    await Promise.all([loadPlayerProfiles(true), loadCaptainTeams()]);
  }

  async function loadMyCareer(userId: string) {
    const { data: rows, error } = await supabase
      .from("match_players")
      .select("*")
      .eq("profile_id", userId);

    if (error) {
      setNotice(error.message);
      return;
    }

    const appearances = (rows ?? []) as MatchPlayer[];
    if (appearances.length === 0) {
      setCareer({
        played: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        wicketsTaken: 0,
        ballsBowled: 0,
        runsConceded: 0,
        recent: [],
      });
      return;
    }

    const matchIds = Array.from(new Set(appearances.map((row) => row.match_id)));
    const { data: matchRows, error: matchError } = await supabase
      .from("matches")
      .select("id, title, status, winner_team, created_at")
      .in("id", matchIds);

    if (matchError) {
      setNotice(matchError.message);
      return;
    }

    const matchById = new Map((matchRows ?? []).map((row) => [row.id, row]));
    const stats: CareerStats = {
      played: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      wicketsTaken: 0,
      ballsBowled: 0,
      runsConceded: 0,
      recent: [],
    };

    for (const row of appearances) {
      stats.runs += row.runs_scored;
      stats.balls += row.balls_faced;
      stats.fours += row.fours;
      stats.sixes += row.sixes;
      stats.wicketsTaken += row.wickets_taken;
      stats.ballsBowled += row.balls_bowled;
      stats.runsConceded += row.runs_conceded;

      const match = matchById.get(row.match_id) as
        | { id: string; title: string; status: string; winner_team: WinnerTeam | null; created_at: string }
        | undefined;
      if (!match) {
        continue;
      }

      let result: CareerMatch["result"] = "pending";
      if (match.status === "completed") {
        stats.played += 1;
        if (match.winner_team === "tie") {
          stats.ties += 1;
          result = "tie";
        } else if (match.winner_team && match.winner_team === row.team_key) {
          stats.wins += 1;
          result = "won";
        } else if (match.winner_team) {
          stats.losses += 1;
          result = "lost";
        }
      }

      stats.recent.push({
        matchId: match.id,
        title: match.title,
        createdAt: match.created_at,
        teamKey: row.team_key,
        result,
        runs: row.runs_scored,
        balls: row.balls_faced,
        wickets: row.wickets_taken,
      });
    }

    stats.recent.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    stats.recent = stats.recent.slice(0, 8);
    setCareer(stats);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setTab("scoreboard");
  }

  async function createMatch(formData: FormData) {
    if (!session?.user || !isAdmin) {
      return;
    }

    const title = String(formData.get("title") ?? "Turf Match").trim() || "Turf Match";
    const venue = String(formData.get("venue") ?? "Local Turf").trim() || "Local Turf";
    const teamSize = Number(formData.get("teamSize") ?? 6);
    const totalOvers = Math.max(1, Math.min(50, Math.round(Number(formData.get("totalOvers") ?? 6) || 6)));
    const teamAId = String(formData.get("teamAId") ?? "");
    const teamBId = String(formData.get("teamBId") ?? "");
    const tossWinner: TeamKey = String(formData.get("tossWinner") ?? "a") === "b" ? "b" : "a";
    const teamA = captainTeams.find((team) => team.id === teamAId && team.captain_id);
    const teamB = captainTeams.find((team) => team.id === teamBId && team.captain_id);

    if (!teamA || !teamB) {
      setNotice("Choose two captain-created teams.");
      return;
    }

    if (teamA.id === teamB.id || teamA.captain_id === teamB.captain_id) {
      setNotice("Choose two different teams.");
      return;
    }

    setBusy(true);
    const { data, error } = await supabase
      .from("matches")
      .insert({
        title,
        venue,
        team_size: teamSize,
        status: "setup",
        total_overs: totalOvers,
        captain_a_id: teamA.captain_id,
        captain_b_id: teamB.captain_id,
        team_a_name: teamA.name,
        team_b_name: teamB.name,
        team_a_logo_url: teamA.logo_url,
        team_b_logo_url: teamB.logo_url,
        team_a_logo_path: teamA.logo_path,
        team_b_logo_path: teamB.logo_path,
        toss_winner: tossWinner,
        draft_turn: tossWinner,
        first_batting_team: tossWinner,
        batting_team_key: tossWinner,
        current_innings: 1,
        created_by: session.user.id,
      })
      .select()
      .single();

    setBusy(false);

    if (error) {
      setNotice(error.message);
      return;
    }

    setNotice(`Match created. ${teamLabel(tossWinner, data as Match)} won the toss and picks first.`);
    setActiveMatchId(data.id);

    const captainRows = [
      { profile: profiles.find((item) => item.id === teamA.captain_id), team: teamA, team_key: "a" as const },
      { profile: profiles.find((item) => item.id === teamB.captain_id), team: teamB, team_key: "b" as const },
    ].map(({ profile, team, team_key }) => ({
      match_id: data.id,
      profile_id: profile?.id ?? team.captain_id,
      display_name: profile?.display_name ?? `${team.name} Captain`,
      team_key,
      is_captain: true,
      skills: profile?.skills ?? [],
      avatar_url: profile?.avatar_url ?? null,
    }));

    const { error: playerError } = await supabase.from("match_players").insert(captainRows);
    if (playerError) {
      setNotice(playerError.message);
    }

    await loadMatches();
    await loadMatchPlayers(data.id);
  }

  async function setCrease(values: { striker_id?: string | null; non_striker_id?: string | null; bowler_id?: string | null }) {
    if (!activeMatch || !isAdmin) {
      return;
    }

    const update: Partial<Match> = { ...values };
    if (values.striker_id !== undefined) {
      update.striker_name = matchPlayers.find((item) => item.id === values.striker_id)?.display_name ?? null;
    }
    if (values.non_striker_id !== undefined) {
      update.non_striker_name = matchPlayers.find((item) => item.id === values.non_striker_id)?.display_name ?? null;
    }
    if (values.bowler_id !== undefined) {
      update.bowler_name = matchPlayers.find((item) => item.id === values.bowler_id)?.display_name ?? null;
    }

    const { error } = await supabase.from("matches").update(update).eq("id", activeMatch.id);
    if (error) {
      setNotice(error.message);
      return;
    }

    await loadMatches();
  }

  async function scoreDelivery(runs: number, options: { extra?: ExtraType; wicket?: boolean } = {}) {
    if (!activeMatch || !session?.user || !isAdmin) {
      return;
    }

    setBusy(true);
    const { error } = await supabase.rpc("score_match_delivery", {
      p_match_id: activeMatch.id,
      p_runs: runs,
      p_extra: options.extra ?? null,
      p_wicket: Boolean(options.wicket),
    });
    setBusy(false);

    if (error) {
      setNotice(formatErrorMessage(error, "Unable to update score."));
      return;
    }

    await Promise.all([loadMatches(), loadDeliveries(activeMatch.id), loadMatchPlayers(activeMatch.id)]);
  }

  async function undoLastDelivery() {
    if (!activeMatch || !isAdmin) {
      return;
    }

    setBusy(true);
    const { error } = await supabase.rpc("undo_last_match_delivery", {
      p_match_id: activeMatch.id,
    });
    setBusy(false);

    if (error) {
      setNotice(formatErrorMessage(error, "Unable to undo last ball."));
      return;
    }

    setNotice("Last ball undone.");
    await Promise.all([loadMatches(), loadDeliveries(activeMatch.id), loadMatchPlayers(activeMatch.id)]);
  }

  async function endInnings() {
    if (!activeMatch || !isAdmin) {
      return;
    }

    if (activeMatch.current_innings === 2) {
      await finishMatch();
      return;
    }

    setBusy(true);
    const { error } = await supabase
      .from("matches")
      .update({
        innings1_runs: activeMatch.runs,
        innings1_wickets: activeMatch.wickets,
        innings1_balls: activeMatch.legal_balls,
        target: activeMatch.runs + 1,
        current_innings: 2,
        batting_team_key: otherTeam(activeMatch.batting_team_key),
        runs: 0,
        wickets: 0,
        legal_balls: 0,
        striker_id: null,
        non_striker_id: null,
        bowler_id: null,
        striker_name: null,
        non_striker_name: null,
        bowler_name: null,
        status: "live",
      })
      .eq("id", activeMatch.id);
    setBusy(false);

    if (error) {
      setNotice(error.message);
      return;
    }

    setNotice(`Innings break — target ${activeMatch.runs + 1}. Pick the chasing openers.`);
    await loadMatches();
  }

  async function finishMatch() {
    if (!activeMatch || !isAdmin) {
      return;
    }

    const first = activeMatch.innings1_runs;
    const second = activeMatch.runs;
    const chasingTeam = activeMatch.batting_team_key;
    const defendingTeam = otherTeam(chasingTeam);
    const chasingSquad = matchPlayers.filter((item) => item.team_key === chasingTeam).length;

    let winner: WinnerTeam;
    let note: string;
    if (second > first) {
      winner = chasingTeam;
      const wicketsLeft = Math.max(0, chasingSquad - 1 - activeMatch.wickets);
      note = `${teamLabel(chasingTeam, activeMatch)} won by ${wicketsLeft} wicket${wicketsLeft === 1 ? "" : "s"}`;
    } else if (second === first) {
      winner = "tie";
      note = "Match tied";
    } else {
      winner = defendingTeam;
      const margin = first - second;
      note = `${teamLabel(defendingTeam, activeMatch)} won by ${margin} run${margin === 1 ? "" : "s"}`;
    }

    setBusy(true);
    const { error } = await supabase
      .from("matches")
      .update({ winner_team: winner, result_note: note, status: "completed" })
      .eq("id", activeMatch.id);
    setBusy(false);

    if (error) {
      setNotice(error.message);
      return;
    }

    setNotice(note);
    await loadMatches();
  }

  async function resetScore() {
    if (!activeMatch || !isAdmin) {
      return;
    }

    setBusy(true);
    const [{ error: deleteError }, { error: matchError }, { error: playerError }] = await Promise.all([
      supabase.from("deliveries").delete().eq("match_id", activeMatch.id),
      supabase
        .from("matches")
        .update({
          runs: 0,
          wickets: 0,
          legal_balls: 0,
          status: "setup",
          current_innings: 1,
          batting_team_key: activeMatch.first_batting_team,
          target: null,
          innings1_runs: 0,
          innings1_wickets: 0,
          innings1_balls: 0,
          striker_id: null,
          non_striker_id: null,
          bowler_id: null,
          striker_name: null,
          non_striker_name: null,
          bowler_name: null,
          winner_team: null,
          result_note: null,
        })
        .eq("id", activeMatch.id),
      supabase
        .from("match_players")
        .update({
          runs_scored: 0,
          balls_faced: 0,
          fours: 0,
          sixes: 0,
          is_out: false,
          dismissal: null,
          balls_bowled: 0,
          runs_conceded: 0,
          wickets_taken: 0,
        })
        .eq("match_id", activeMatch.id),
    ]);
    setBusy(false);

    if (deleteError || matchError || playerError) {
      setNotice(deleteError?.message ?? matchError?.message ?? playerError?.message ?? "Unable to reset score.");
      return;
    }

    await Promise.all([loadMatches(), loadDeliveries(activeMatch.id), loadMatchPlayers(activeMatch.id)]);
  }

  async function claimTeam(teamKey: TeamKey) {
    if (!activeMatch || !isCaptain) {
      return;
    }

    setBusy(true);
    const { error } = await supabase.rpc("claim_match_team", {
      p_match_id: activeMatch.id,
      p_team_key: teamKey,
    });
    setBusy(false);

    if (error) {
      setNotice(formatErrorMessage(error, "Unable to claim team."));
      return;
    }

    setNotice(`${teamLabel(teamKey, activeMatch)} claimed.`);
    await Promise.all([loadMatches(), loadMatchPlayers(activeMatch.id)]);
  }

  async function addTeamPlayer(profileId: string) {
    const teamKey = captainTeamKey;
    if (!activeMatch || !teamKey) {
      return;
    }

    setBusy(true);
    const { error } = await supabase.rpc("draft_match_player", {
      p_match_id: activeMatch.id,
      p_team_key: teamKey,
      p_profile_id: profileId,
    });
    setBusy(false);

    if (error) {
      setNotice(formatErrorMessage(error, "Unable to add player."));
      return;
    }

    await Promise.all([loadMatches(), loadMatchPlayers(activeMatch.id)]);
  }

  async function updateProfileBan(profileId: string, banned: boolean) {
    if (!isAdmin || profileId === session?.user.id) {
      return;
    }

    const { error } = await supabase
      .from("profiles")
      .update({
        is_banned: banned,
        banned_at: banned ? new Date().toISOString() : null,
        banned_by: banned ? session?.user.id : null,
      })
      .eq("id", profileId);

    if (error) {
      setNotice(error.message);
      return;
    }

    await loadAdminLists();
  }

  async function saveCaptainTeam(values: { name: string; logoFile?: File | null }) {
    if (!session?.user || !isCaptain) {
      return;
    }

    const oldLogoPath = ownedCaptainTeam?.logo_path ?? null;
    setBusy(true);
    try {
      let logo: { path: string; publicUrl: string } | null = null;
      if (values.logoFile) {
        const blob = await compressSquareAvatar(values.logoFile);
        logo = await uploadTeamLogoBlob(session.user.id, "captain", blob);
      }

      const { data, error } = await supabase.rpc("save_captain_team", {
        p_name: values.name,
        p_logo_url: logo?.publicUrl ?? null,
        p_logo_path: logo?.path ?? null,
      });

      if (error) {
        throw error;
      }

      const savedTeam = (Array.isArray(data) ? data[0] : data) as CaptainTeam;
      if (!savedTeam) {
        throw new Error("Team was not saved.");
      }
      if (activeMatch && captainTeamKey) {
        const { error: brandingError } = await supabase.rpc("update_match_team_branding", {
          p_match_id: activeMatch.id,
          p_team_key: captainTeamKey,
          p_team_name: savedTeam.name,
          p_logo_url: savedTeam.logo_url,
          p_logo_path: savedTeam.logo_path,
        });

        if (brandingError) {
          throw brandingError;
        }
      }

      if (logo && oldLogoPath && oldLogoPath !== logo.path) {
        await supabase.storage.from(TEAM_LOGOS_BUCKET).remove([oldLogoPath]);
      }

      setNotice("Team saved.");
      await Promise.all([loadCaptainTeams(), loadMatches()]);
    } catch (error) {
      setNotice(formatErrorMessage(error, "Unable to save team."));
    } finally {
      setBusy(false);
    }
  }

  async function exitCaptainTeam(teamId: string) {
    if (!isCaptain) {
      return;
    }

    setBusy(true);
    const { error } = await supabase.rpc("exit_captain_team", {
      p_team_id: teamId,
    });
    setBusy(false);

    if (error) {
      setNotice(formatErrorMessage(error, "Unable to exit team."));
      return;
    }

    setNotice("You exited the team. Another captain can join it now.");
    await loadCaptainTeams();
  }

  async function joinCaptainTeam(teamId: string) {
    if (!isCaptain) {
      return;
    }

    setBusy(true);
    const { error } = await supabase.rpc("join_captain_team", {
      p_team_id: teamId,
    });
    setBusy(false);

    if (error) {
      setNotice(formatErrorMessage(error, "Unable to join team."));
      return;
    }

    setNotice("Team joined.");
    await loadCaptainTeams();
  }

  async function updateRole(profileId: string, nextRole: AppRole) {
    if (!isAdmin || profileId === session?.user.id) {
      return;
    }

    const { error } = await supabase.from("user_roles").update({ role: nextRole }).eq("user_id", profileId);
    if (error) {
      setNotice(error.message);
      return;
    }

    await loadAdminLists();
  }

  async function resetAllData() {
    if (!isAdmin) {
      return;
    }

    const confirmed = window.confirm(
      "Reset everything? This deletes all matches, scoreboards, deliveries, and team squads. Player accounts and roles are kept. This cannot be undone.",
    );
    if (!confirmed) {
      return;
    }

    setBusy(true);
    const { error } = await supabase.rpc("reset_app_data");
    setBusy(false);

    if (error) {
      setNotice(formatErrorMessage(error, "Unable to reset app data."));
      return;
    }

    setActiveMatchId(null);
    setMatches([]);
    setDeliveries([]);
    setMatchPlayers([]);
    setNotice("All match data has been reset. Player accounts kept.");
    if (session?.user) {
      void loadMyCareer(session.user.id);
    }
  }

  async function uploadPendingAvatarIfNeeded(userId: string, currentProfile: Profile | null) {
    const saved = window.localStorage.getItem(PENDING_AVATAR_KEY);
    if (!saved || !session?.user.email) {
      return currentProfile;
    }

    try {
      const pending = JSON.parse(saved) as PendingAvatar;
      if (pending.email.toLowerCase() !== session.user.email.toLowerCase()) {
        return currentProfile;
      }

      const blob = await dataUrlToBlob(pending.dataUrl);
      const updatedProfile = await uploadAvatarBlob(userId, blob, currentProfile?.avatar_path);
      window.localStorage.removeItem(PENDING_AVATAR_KEY);
      setNotice("Profile photo saved.");
      return updatedProfile;
    } catch (error) {
      console.error("[pending avatar upload failed]", error);
      setNotice(formatErrorMessage(error, "Unable to save pending profile photo."));
      return currentProfile;
    }
  }

  async function updateOwnAvatar(file: File) {
    if (!session?.user) {
      return;
    }

    setBusy(true);
    try {
      const blob = await compressSquareAvatar(file);
      const updatedProfile = await uploadAvatarBlob(session.user.id, blob, profile?.avatar_path);
      setProfile(updatedProfile);
      setNotice("Profile photo updated.");
    } catch (error) {
      const message = formatErrorMessage(error, "Unable to update profile photo.");
      console.error("[avatar upload failed]", error);
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  if (authLoading) {
    return (
      <main className="page-shell">
        <section className="phone-shell center-shell">
          <Activity className="spin" size={28} />
          <p>Opening Cricket Mania...</p>
        </section>
      </main>
    );
  }

  if (!session) {
    return <AuthScreen />;
  }

  if (profile?.is_banned) {
    return <BannedScreen profile={profile} onSignOut={signOut} />;
  }

  return (
    <main className="page-shell">
      <section className="phone-shell" aria-label="Cricket Mania mobile web app">
        <header className="app-header sticky-top">
          <div className="top-bar">
            <button className="icon-button" aria-label="Scoreboard" onClick={() => setTab("scoreboard")}>
              <ClipboardList size={22} />
            </button>
            <h1>
              Cricket <span>Mania</span>
            </h1>
            <button className="icon-button" aria-label="Sign out" onClick={signOut}>
              <LogOut size={21} />
            </button>
          </div>
          <div className="match-strip">
            <strong>{activeMatch?.title ?? "No Match"}</strong>
            <span>{activeMatch ? `${activeMatch.runs}/${activeMatch.wickets}` : "0/0"}</span>
            <span>
              {activeMatch ? `${getOvers(activeMatch.legal_balls)}/${activeMatch.total_overs} ov` : "0.0 ov"}
            </span>
            <span>
              {activeMatch ? `CRR ${formatRate(runRate(activeMatch.runs, activeMatch.legal_balls))}` : "CRR 0.00"}
            </span>
          </div>
          <div className="account-strip">
            <span>{profile?.display_name ?? session.user.email}</span>
            <strong>{role}</strong>
          </div>
        </header>

        <div className="screen-body">
          {notice && (
            <button className="notice" onClick={() => setNotice("")}>
              {notice}
            </button>
          )}

          {tab === "scoreboard" && !isAdmin && (
            <ScoreboardView
              match={activeMatch}
              deliveries={deliveries}
              matches={matches}
              matchPlayers={matchPlayers}
              onSelectMatch={setActiveMatchId}
              onShare={(message) => setNotice(message)}
            />
          )}

          {tab === "players" && !isAdmin && (
            <PlayerView
              profile={profile}
              role={role}
              career={career}
              busy={busy}
              onAvatarChange={updateOwnAvatar}
              onShare={(message) => setNotice(message)}
              onRefresh={() => session.user && loadAppData(session.user.id)}
            />
          )}

          {tab === "team" && showTeamTab && (
            <CaptainTeamView
              busy={busy}
              match={activeMatch}
              profiles={profiles}
              captainTeams={captainTeams}
              ownedCaptainTeam={ownedCaptainTeam}
              matchPlayers={matchPlayers}
              teamKey={captainTeamKey}
              currentUserId={session.user.id}
              onClaimTeam={claimTeam}
              onAddPlayer={addTeamPlayer}
              onSaveCaptainTeam={saveCaptainTeam}
              onExitCaptainTeam={exitCaptainTeam}
              onJoinCaptainTeam={joinCaptainTeam}
              onRefresh={() => {
                void loadCaptainTeams();
                void loadPlayerProfiles(isAdmin);
                if (activeMatch?.id) {
                  void loadMatchPlayers(activeMatch.id);
                }
              }}
            />
          )}

          {tab === "umpire" && isAdmin && (
            <UmpireView
              busy={busy}
              match={activeMatch}
              deliveries={deliveries}
              matchPlayers={matchPlayers}
              onScore={scoreDelivery}
              onUndo={undoLastDelivery}
              onReset={resetScore}
              onSetCrease={setCrease}
              onEndInnings={endInnings}
              onShare={(message) => setNotice(message)}
              onGoToManage={() => setTab("manage")}
            />
          )}

          {tab === "manage" && isAdmin && (
            <ManageView
              busy={busy}
              match={activeMatch}
              profiles={profiles}
              roles={roles}
              captainTeams={captainTeams}
              currentUserId={session.user.id}
              onCreateMatch={createMatch}
              onUpdateRole={updateRole}
              onToggleBan={updateProfileBan}
              onRefreshPlayers={loadAdminLists}
              onResetAll={resetAllData}
              onGoToUmpire={() => setTab("umpire")}
            />
          )}
        </div>

        <nav className="bottom-nav sticky-bottom" aria-label="Primary">
          {!isAdmin && (
            <NavButton
              icon={<Trophy size={22} />}
              label="Score"
              active={tab === "scoreboard"}
              onClick={() => setTab("scoreboard")}
            />
          )}
          {!isAdmin && (
            <NavButton
              icon={<Users size={22} />}
              label="Profile"
              active={tab === "players"}
              onClick={() => setTab("players")}
            />
          )}
          {showTeamTab && (
            <NavButton
              icon={<Swords size={22} />}
              label="Team"
              active={tab === "team"}
              onClick={() => setTab("team")}
            />
          )}
          {isAdmin && (
            <NavButton
              icon={<Gauge size={22} />}
              label="Umpire"
              active={tab === "umpire"}
              onClick={() => setTab("umpire")}
            />
          )}
          {isAdmin && (
            <NavButton
              icon={<Shield size={22} />}
              label="Manage"
              active={tab === "manage"}
              onClick={() => setTab("manage")}
            />
          )}
        </nav>
      </section>
    </main>
  );
}

function AuthScreen() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState("");

  async function submitAuth(formData: FormData) {
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const displayName = String(formData.get("displayName") ?? "").trim();

    setBusy(true);
    setMessage("");

    let pendingAvatarDataUrl = "";
    if (mode === "signup" && avatarFile) {
      try {
        const avatarBlob = await compressSquareAvatar(avatarFile);
        pendingAvatarDataUrl = await blobToDataUrl(avatarBlob);
      } catch (error) {
        setBusy(false);
        setMessage(error instanceof Error ? error.message : "Could not process profile photo.");
        return;
      }
    }

    const result =
      mode === "signup"
        ? await supabase.auth.signUp({
            email,
            password,
            options: {
              emailRedirectTo: getAuthRedirectUrl(),
              data: { display_name: displayName || email.split("@")[0] },
            },
          })
        : await supabase.auth.signInWithPassword({ email, password });

    setBusy(false);

    if (result.error) {
      setMessage(result.error.message);
      return;
    }

    if (pendingAvatarDataUrl) {
      window.localStorage.setItem(
        PENDING_AVATAR_KEY,
        JSON.stringify({ email: email.toLowerCase(), dataUrl: pendingAvatarDataUrl } satisfies PendingAvatar),
      );
    }

    setMessage(mode === "signup" ? "Account created. Check your email if confirmation is enabled." : "Logged in.");
  }

  async function signInWithGoogle() {
    setBusy(true);
    setMessage("");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: getAuthRedirectUrl(),
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) {
      setBusy(false);
      setMessage(error.message);
    }
    // On success Supabase redirects to Google; the browser will navigate away.
  }

  function previewAvatar(file: File | null) {
    setAvatarFile(file);
    if (!file) {
      setAvatarPreview("");
      return;
    }

    const url = URL.createObjectURL(file);
    setAvatarPreview(url);
  }

  return (
    <main className="page-shell">
      <section className="phone-shell auth-shell">
        <header className="auth-header">
          <div className="brand-ball" aria-hidden="true" />
          <h1>
            Cricket <span>Mania</span>
          </h1>
          <p>Mobile scoreboard for turf and gully cricket players.</p>
        </header>

        <form
          className="auth-card"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAuth(new FormData(event.currentTarget));
          }}
        >
          <div className="auth-tabs">
            <button type="button" className={mode === "login" ? "selected" : ""} onClick={() => setMode("login")}>
              Login
            </button>
            <button type="button" className={mode === "signup" ? "selected" : ""} onClick={() => setMode("signup")}>
              Create
            </button>
          </div>

          <button type="button" className="google-action" disabled={busy} onClick={() => void signInWithGoogle()}>
            <GoogleIcon />
            <span>{mode === "signup" ? "Sign up with Google" : "Continue with Google"}</span>
          </button>

          <div className="auth-divider" aria-hidden="true">
            <span>or use email</span>
          </div>

          {mode === "signup" && (
            <>
              <label className="avatar-picker">
                <span className="avatar-preview">
                  {avatarPreview ? <img src={avatarPreview} alt="Selected profile preview" /> : <Camera size={26} />}
                </span>
                <span>
                  Profile photo
                  <small>1:1 square, compressed before upload</small>
                </span>
                <input
                  aria-label="Profile photo"
                  accept="image/png,image/jpeg,image/webp"
                  type="file"
                  onChange={(event) => previewAvatar(event.target.files?.[0] ?? null)}
                />
              </label>
              <label>
                <span>Player name</span>
                <input name="displayName" placeholder="Arjun Patil" />
              </label>
            </>
          )}
          <label>
            <span>Email</span>
            <input name="email" type="email" placeholder="player@example.com" required />
          </label>
          <label>
            <span>Password</span>
            <input name="password" type="password" minLength={6} placeholder="Minimum 6 characters" required />
          </label>

          {message && <p className="form-message">{message}</p>}

          <button className="primary-action" disabled={busy}>
            {mode === "signup" ? <UserPlus size={19} /> : <Mail size={19} />}
            {busy ? "Please wait..." : mode === "signup" ? "Create account" : "Login"}
          </button>
        </form>
      </section>
    </main>
  );
}

function BannedScreen({ profile, onSignOut }: { profile: Profile; onSignOut: () => void }) {
  return (
    <main className="page-shell">
      <section className="phone-shell center-shell banned-shell">
        <UserX size={34} />
        <h1>Account banned</h1>
        <p>{profile.display_name}, your account has been blocked by the admin.</p>
        <button className="primary-action" onClick={onSignOut}>
          <LogOut size={18} />
          Sign out
        </button>
      </section>
    </main>
  );
}

function ScoreboardView({
  match,
  deliveries,
  matches,
  matchPlayers,
  onSelectMatch,
  onShare,
}: {
  match: Match | null;
  deliveries: Delivery[];
  matches: Match[];
  matchPlayers: MatchPlayer[];
  onSelectMatch: (id: string) => void;
  onShare: (message: string) => void;
}) {
  if (!match) {
    return (
      <section className="panel empty-state">
        <Trophy size={34} />
        <h2>No live match yet</h2>
        <p>Ask the admin to create a match. Once it starts, every player account can see the scoreboard here.</p>
      </section>
    );
  }

  const battingKey = match.batting_team_key;
  const striker = matchPlayers.find((item) => item.id === match.striker_id) ?? null;
  const nonStriker = matchPlayers.find((item) => item.id === match.non_striker_id) ?? null;
  const bowler = matchPlayers.find((item) => item.id === match.bowler_id) ?? null;
  const crr = runRate(match.runs, match.legal_balls);
  const isChase = match.current_innings === 2 && match.target !== null;
  const totalBalls = match.total_overs * 6;
  const runsNeeded = match.target ? Math.max(0, match.target - match.runs) : 0;
  const ballsLeft = Math.max(0, totalBalls - match.legal_balls);
  const rrr = match.target ? requiredRunRate(match.target, match.runs, totalBalls, match.legal_balls) : 0;
  const isCompleted = match.status === "completed";
  const displayResult = matchResultNote(match);
  const rankings = [...matchPlayers]
    .filter((player) => player.team_key === "a" || player.team_key === "b")
    .sort((a, b) => playerImpact(b) - playerImpact(a));

  const handleShare = () => {
    const overs = `${getOvers(match.legal_balls)}/${match.total_overs} ov`;
    const chaseLine = isChase && !isCompleted ? ` · need ${runsNeeded} in ${ballsLeft}` : "";
    const summary = isCompleted && displayResult ? ` · ${displayResult}` : "";
    const text = `🏏 ${match.title} — ${teamLabel(battingKey, match)} ${match.runs}/${match.wickets} (${overs}), CRR ${formatRate(
      crr,
    )}${chaseLine}${summary} · Cricket Mania`;
    void shareContent({ title: match.title, text }, onShare);
  };

  return (
    <section className="stack">
      <TeamVsStrip match={match} />

      <div className="innings-banner">
        <span>{isCompleted ? "Result" : `Innings ${match.current_innings}`}</span>
        <span>{teamLabel(battingKey, match)} batting</span>
      </div>

      <div className="score-hero">
        <span>{match.title}</span>
        <strong>
          {match.runs}/{match.wickets}
        </strong>
        <small>
          {getOvers(match.legal_balls)}/{match.total_overs} overs
        </small>
        <div className="rate-badges">
          <span className="rate-badge">
            <Gauge size={13} /> CRR {formatRate(crr)}
          </span>
          {isChase && !isCompleted && (
            <span className="rate-badge accent">
              <Target size={13} /> RRR {formatRate(rrr)}
            </span>
          )}
        </div>
      </div>

      {isCompleted && displayResult && <div className="result-banner">{displayResult}</div>}

      {isChase && !isCompleted && (
        <div className="chase-strip">
          <span>Target {match.target}</span>
          <strong>
            Need {runsNeeded} in {ballsLeft} balls
          </strong>
        </div>
      )}

      <section className="panel">
        <div className="panel-title">
          <h3>At the crease</h3>
          <span>{match.current_innings === 1 ? "1st innings" : "2nd innings"}</span>
        </div>
        <div className="crease-list">
          <BatterRow label="Striker" player={striker} onStrike />
          <BatterRow label="Non-striker" player={nonStriker} />
          <BowlerRow player={bowler} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Overs</h3>
          <span>{deliveries.length} balls</span>
        </div>
        <BallStrip deliveries={deliveries} matchPlayers={matchPlayers} />
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Player rankings</h3>
          <span>{rankings.length}</span>
        </div>
        <PlayerRankings players={rankings} match={match} />
      </section>

      <button className="secondary-action share-action" onClick={handleShare}>
        <Share2 size={18} />
        Share live score
      </button>

      <section className="panel">
        <div className="panel-title">
          <h3>Matches</h3>
          <span>{matches.length}</span>
        </div>
        <div className="match-list">
          {matches.map((item) => (
            <button className={item.id === match.id ? "selected" : ""} key={item.id} onClick={() => onSelectMatch(item.id)}>
              <span>
                <strong>{item.title}</strong>
                <small>{matchResultNote(item) ?? formatDate(item.created_at)}</small>
              </span>
              <b>
                {item.runs}/{item.wickets}
              </b>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}

function TeamVsStrip({ match }: { match: Match }) {
  return (
    <section className="team-vs-strip" aria-label="Teams">
      <TeamBadge match={match} teamKey="a" />
      <span className="vs-chip">VS</span>
      <TeamBadge match={match} teamKey="b" />
    </section>
  );
}

function TeamBadge({ match, teamKey }: { match: Match; teamKey: TeamKey }) {
  const logo = teamLogoUrl(teamKey, match);
  const name = teamLabel(teamKey, match);

  return (
    <div className="team-badge">
      <span className="team-logo">{logo ? <img src={logo} alt={`${name} logo`} /> : name.slice(0, 1)}</span>
      <strong>{name}</strong>
    </div>
  );
}

function PlayerRankings({ players, match }: { players: MatchPlayer[]; match: Match }) {
  if (players.length === 0) {
    return <p className="empty-note">No player stats yet.</p>;
  }

  return (
    <div className="ranking-list">
      {players.map((player, index) => (
        <article className="ranking-row" key={player.id}>
          <span className="rank-number">#{index + 1}</span>
          <MatchPlayerPhoto player={player} />
          <div className="ranking-main">
            <strong>{player.display_name}</strong>
            <small>{teamLabel(player.team_key === "b" ? "b" : "a", match)}</small>
          </div>
          <div className="ranking-stats">
            <strong>{playerImpact(player)}</strong>
            <small>
              {player.runs_scored}R · {player.wickets_taken}W · SR {formatRate(strikeRate(player.runs_scored, player.balls_faced))}
            </small>
          </div>
        </article>
      ))}
    </div>
  );
}

function BatterRow({ label, player, onStrike = false }: { label: string; player: MatchPlayer | null; onStrike?: boolean }) {
  return (
    <div className={`crease-row ${onStrike ? "on-strike" : ""}`}>
      <div>
        <small>{label}</small>
        <strong>
          {player ? player.display_name : "—"}
          {onStrike && player ? " *" : ""}
        </strong>
      </div>
      <div className="crease-figures">
        <strong>
          {player ? player.runs_scored : 0}
          <span> ({player ? player.balls_faced : 0})</span>
        </strong>
        <small>SR {formatRate(strikeRate(player?.runs_scored ?? 0, player?.balls_faced ?? 0))}</small>
      </div>
    </div>
  );
}

function BowlerRow({ player }: { player: MatchPlayer | null }) {
  return (
    <div className="crease-row bowler-row">
      <div>
        <small>Bowler</small>
        <strong>{player ? player.display_name : "—"}</strong>
      </div>
      <div className="crease-figures">
        <strong>
          {getOvers(player?.balls_bowled ?? 0)}-{player?.runs_conceded ?? 0}-{player?.wickets_taken ?? 0}
        </strong>
        <small>Econ {formatRate(runRate(player?.runs_conceded ?? 0, player?.balls_bowled ?? 0))}</small>
      </div>
    </div>
  );
}

function PlayerView({
  profile,
  role,
  career,
  busy,
  onAvatarChange,
  onShare,
  onRefresh,
}: {
  profile: Profile | null;
  role: AppRole;
  career: CareerStats | null;
  busy: boolean;
  onAvatarChange: (file: File) => void;
  onShare: (message: string) => void;
  onRefresh: () => void;
}) {
  const played = career?.played ?? 0;
  const wins = career?.wins ?? 0;
  const losses = career?.losses ?? 0;
  const winPct = played > 0 ? Math.round((wins / played) * 100) : 0;
  const careerRuns = career?.runs ?? 0;
  const careerBalls = career?.balls ?? 0;
  const careerSR = strikeRate(careerRuns, careerBalls);
  const careerRR = runRate(careerRuns, careerBalls);

  const handleShareStats = () => {
    const text = `🏏 ${profile?.display_name ?? "Cricket player"} on Cricket Mania — ${played} played, ${wins}W/${losses}L, ${careerRuns} runs at SR ${formatRate(
      careerSR,
    )}, RR ${formatRate(careerRR)}/over.`;
    void shareContent({ title: "My Cricket Mania stats", text }, onShare);
  };

  return (
    <section className="stack">
      <div className="hero-card">
        <div>
          <p className="eyebrow">Player account</p>
          <h2>{profile?.display_name ?? "Cricket player"}</h2>
        </div>
        <ProfilePhoto profile={profile} size="large" />
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>Career record</h3>
          <span>{role}</span>
        </div>
        <div className="career-grid">
          <PlayerStat label="Played" value={String(played)} highlight />
          <PlayerStat label="Won" value={String(wins)} />
          <PlayerStat label="Lost" value={String(losses)} />
          <PlayerStat label="Win %" value={`${winPct}%`} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Batting run rate</h3>
          <Gauge size={16} />
        </div>
        <div className="career-grid">
          <PlayerStat label="Runs" value={String(careerRuns)} highlight />
          <PlayerStat label="Balls" value={String(careerBalls)} />
          <PlayerStat label="Strike rate" value={formatRate(careerSR)} />
          <PlayerStat label="Run rate" value={`${formatRate(careerRR)}/ov`} />
        </div>
        <div className="career-sub">
          <span>{career?.fours ?? 0} fours</span>
          <span>{career?.sixes ?? 0} sixes</span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Bowling</h3>
          <Target size={16} />
        </div>
        <div className="stat-grid">
          <PlayerStat label="Wickets" value={String(career?.wicketsTaken ?? 0)} />
          <PlayerStat label="Overs" value={getOvers(career?.ballsBowled ?? 0)} />
          <PlayerStat label="Economy" value={formatRate(runRate(career?.runsConceded ?? 0, career?.ballsBowled ?? 0))} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Recent matches</h3>
          <span>{career?.recent.length ?? 0}</span>
        </div>
        <div className="recent-list">
          {(career?.recent ?? []).map((item) => (
            <article className="recent-row" key={item.matchId}>
              <div>
                <strong>{item.title}</strong>
                <small>
                  {item.runs} ({item.balls}) · {formatDate(item.createdAt)}
                </small>
              </div>
              <span className={`result-chip ${item.result}`}>
                {item.result === "won"
                  ? "Won"
                  : item.result === "lost"
                    ? "Lost"
                    : item.result === "tie"
                      ? "Tie"
                      : "Live"}
              </span>
            </article>
          ))}
          {(career?.recent.length ?? 0) === 0 && <p className="empty-note">No matches played yet.</p>}
        </div>
      </section>

      <section className="panel profile-panel">
        <div className="panel-title">
          <h3>Your profile</h3>
        </div>
        <label className="change-photo">
          <ProfilePhoto profile={profile} />
          <span>
            Change profile photo
            <small>Square WebP, compressed automatically</small>
          </span>
          <input
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                onAvatarChange(file);
              }
              event.currentTarget.value = "";
            }}
          />
        </label>
        <p>{profile?.email}</p>
        <SkillChips skills={profile?.skills ?? []} />
        <div className="dual-actions">
          <button className="secondary-action" onClick={onRefresh}>
            Refresh
          </button>
          <button className="secondary-action share-action" onClick={handleShareStats}>
            <Share2 size={18} />
            Share my stats
          </button>
        </div>
      </section>
    </section>
  );
}

function CaptainTeamView({
  busy,
  match,
  profiles,
  captainTeams,
  ownedCaptainTeam,
  matchPlayers,
  teamKey,
  currentUserId,
  onClaimTeam,
  onAddPlayer,
  onSaveCaptainTeam,
  onExitCaptainTeam,
  onJoinCaptainTeam,
  onRefresh,
}: {
  busy: boolean;
  match: Match | null;
  profiles: Profile[];
  captainTeams: CaptainTeam[];
  ownedCaptainTeam: CaptainTeam | null;
  matchPlayers: MatchPlayer[];
  teamKey: "a" | "b" | null;
  currentUserId: string;
  onClaimTeam: (teamKey: TeamKey) => void;
  onAddPlayer: (profileId: string) => void;
  onSaveCaptainTeam: (values: { name: string; logoFile?: File | null }) => void;
  onExitCaptainTeam: (teamId: string) => void;
  onJoinCaptainTeam: (teamId: string) => void;
  onRefresh: () => void;
}) {
  const [lineupOpen, setLineupOpen] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const openTeams = captainTeams.filter((team) => !team.captain_id);

  const teamSetup = (
    <CaptainOwnedTeamPanel
      busy={busy}
      openTeams={openTeams}
      ownedTeam={ownedCaptainTeam}
      onExitTeam={onExitCaptainTeam}
      onJoinTeam={onJoinCaptainTeam}
      onSaveTeam={onSaveCaptainTeam}
    />
  );

  if (!match) {
    return (
      <section className="stack">
        {teamSetup}
        <section className="panel empty-state">
          <Swords size={34} />
          <h2>No match selected</h2>
          <p>Create your team profile first. Once an admin creates a match, your team will be available for play.</p>
        </section>
      </section>
    );
  }

  if (!ownedCaptainTeam) {
    return (
      <section className="stack">
        {teamSetup}
        <section className="panel empty-state compact">
          <Swords size={30} />
          <h2>Create a team first</h2>
          <p>Captains need a team name and display picture before joining or drafting in a match.</p>
        </section>
      </section>
    );
  }

  if (!teamKey) {
    return (
      <section className="stack">
        {teamSetup}
        <section className="panel">
          <div className="panel-title">
            <h3>Claim team</h3>
            <span>{teamLabel(match.toss_winner, match)} picks first</span>
          </div>
          <div className="claim-grid">
            {(["a", "b"] as TeamKey[]).map((key) => {
              const claimedBy = key === "a" ? match.captain_a_id : match.captain_b_id;
              const isMine = claimedBy === currentUserId;
              return (
                <button
                  className={`claim-card ${match.toss_winner === key ? "toss-winner" : ""}`}
                  disabled={busy || Boolean(claimedBy)}
                  key={key}
                  onClick={() => onClaimTeam(key)}
                >
                  <span className="team-logo">
                    {ownedCaptainTeam.logo_url ? <img src={ownedCaptainTeam.logo_url} alt={`${ownedCaptainTeam.name} logo`} /> : ownedCaptainTeam.name.slice(0, 1)}
                  </span>
                  <strong>{claimedBy ? teamLabel(key, match) : ownedCaptainTeam.name}</strong>
                  <span>{isMine ? "Your team" : claimedBy ? "Claimed" : key === match.toss_winner ? "Join toss winner slot" : "Join second slot"}</span>
                </button>
              );
            })}
          </div>
        </section>
        <section className="panel empty-state compact">
          <Swords size={30} />
          <h2>Captains claim teams</h2>
          <p>The umpire sets the toss winner. That team gets the first draft pick.</p>
        </section>
      </section>
    );
  }

  const pickedByProfile = new Map(matchPlayers.filter((item) => item.profile_id).map((item) => [item.profile_id, item]));
  const teamRows = matchPlayers.filter((item) => item.team_key === teamKey);
  const draftPlayers = profiles.filter((item) => item.id !== currentUserId);
  const currentTeamName = teamLabel(teamKey, match);
  const currentTeamLogo = teamLogoUrl(teamKey, match);
  const isFull = teamRows.length >= match.team_size;
  const bothCaptainsReady = Boolean(match.captain_a_id && match.captain_b_id);
  const isMyTurn = match.draft_turn === teamKey;
  const draftStatusText = !bothCaptainsReady
    ? "Waiting for both captains to claim teams."
    : isFull
      ? "Your team is full."
      : isMyTurn
        ? "Your turn to add one player."
        : `Waiting for ${teamLabel(match.draft_turn, match)}.`;

  return (
    <section className="stack">
      <div className="hero-card">
        <div>
          <p className="eyebrow">Captain mode</p>
          <h2>{currentTeamName}</h2>
        </div>
        <span className="team-logo large">{currentTeamLogo ? <img src={currentTeamLogo} alt={`${currentTeamName} logo`} /> : currentTeamName.slice(0, 1)}</span>
      </div>

      {teamSetup}

      <div className="panel lineup-summary">
        <button
          type="button"
          className="lineup-summary-open"
          onClick={() => setLineupOpen(true)}
          aria-label="Open lineup ground view"
        >
          <div>
            <span className="lineup-summary-label">Lineup preview</span>
            <strong>{currentTeamName}</strong>
            <small>{teamRows.length}/{match.team_size} picked · tap to view ground</small>
          </div>
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          className="lineup-summary-add"
          onClick={() => setDraftOpen(true)}
          aria-label="Add player"
        >
          <Plus size={16} />
        </button>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>{currentTeamName} squad</h3>
          <span>{teamRows.length} picked</span>
        </div>
        <div className="team-player-list">
          {teamRows.map((row) => (
            <article className="team-player-row" key={row.id}>
              <MatchPlayerPhoto player={row} />
              <div>
                <strong>{row.display_name}</strong>
                <SkillChips skills={row.skills} />
              </div>
              <span className="captain-badge">{row.is_captain ? "Captain" : "Picked"}</span>
            </article>
          ))}
          {teamRows.length === 0 && <p className="empty-note">No players picked yet.</p>}
        </div>
      </section>

      {lineupOpen && (
        <LineupGroundModal
          match={match}
          players={teamRows}
          teamKey={teamKey}
          onAdd={() => {
            setLineupOpen(false);
            setDraftOpen(true);
          }}
          onClose={() => setLineupOpen(false)}
        />
      )}

      {draftOpen && (
        <DraftModal
          match={match}
          teamKey={teamKey}
          players={draftPlayers}
          pickedByProfile={pickedByProfile}
          statusText={draftStatusText}
          canAdd={bothCaptainsReady && isMyTurn && !isFull}
          busy={busy}
          onPick={onAddPlayer}
          onRefresh={onRefresh}
          onClose={() => setDraftOpen(false)}
        />
      )}
    </section>
  );
}

function CaptainOwnedTeamPanel({
  busy,
  ownedTeam,
  openTeams,
  onSaveTeam,
  onExitTeam,
  onJoinTeam,
}: {
  busy: boolean;
  ownedTeam: CaptainTeam | null;
  openTeams: CaptainTeam[];
  onSaveTeam: (values: { name: string; logoFile?: File | null }) => void;
  onExitTeam: (teamId: string) => void;
  onJoinTeam: (teamId: string) => void;
}) {
  return (
    <section className="panel team-brand-form">
      <form
        className="captain-team-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const logoFile = formData.get("logoFile");
          onSaveTeam({
            name: String(formData.get("teamName") ?? ownedTeam?.name ?? "").trim(),
            logoFile: logoFile instanceof File && logoFile.size > 0 ? logoFile : null,
          });
          const input = event.currentTarget.querySelector<HTMLInputElement>('input[name="logoFile"]');
          if (input) input.value = "";
        }}
      >
        <div className="panel-title">
          <h3>{ownedTeam ? "Your team" : "Create team"}</h3>
          <span>{ownedTeam ? "Captain" : "Required"}</span>
        </div>
        <label className="field">
          <span>Team name</span>
          <input name="teamName" defaultValue={ownedTeam?.name ?? ""} placeholder="Enter team name" />
        </label>
        <label className="avatar-picker team-logo-picker">
          <span className="team-logo">
            {ownedTeam?.logo_url ? <img src={ownedTeam.logo_url} alt={`${ownedTeam.name} logo`} /> : <Camera size={24} />}
          </span>
          <span>
            Team display picture
            <small>1:1 square, compressed before upload</small>
          </span>
          <input name="logoFile" aria-label="Team display picture" accept="image/png,image/jpeg,image/webp" type="file" />
        </label>
        <div className="dual-actions">
          <button className="primary-action" disabled={busy}>
            <Camera size={18} />
            {ownedTeam ? "Save team" : "Create team"}
          </button>
          {ownedTeam && (
            <button
              type="button"
              className="secondary-action danger-soft"
              disabled={busy}
              onClick={() => onExitTeam(ownedTeam.id)}
            >
              Exit team
            </button>
          )}
        </div>
      </form>

      {!ownedTeam && openTeams.length > 0 && (
        <div className="open-team-list">
          <div className="draft-section-label">Open teams</div>
          {openTeams.map((team) => (
            <article className="open-team-row" key={team.id}>
              <span className="team-logo">
                {team.logo_url ? <img src={team.logo_url} alt={`${team.name} logo`} /> : team.name.slice(0, 1)}
              </span>
              <div>
                <strong>{team.name}</strong>
                <small>No captain right now</small>
              </div>
              <button className="tiny-action accent" disabled={busy} onClick={() => onJoinTeam(team.id)}>
                Join
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

const GROUP_LABELS: Record<LineupGroup, string> = {
  "WICKET-KEEPERS": "Wicket-keeper",
  "BATTERS": "Batsmen",
  "ALL-ROUNDERS": "All-rounders",
  "BOWLERS": "Bowlers",
};

function LineupGroundModal({
  match,
  players,
  teamKey,
  onAdd,
  onClose,
}: {
  match: Match;
  players: MatchPlayer[];
  teamKey: TeamKey;
  onAdd: () => void;
  onClose: () => void;
}) {
  const currentTeamName = teamLabel(teamKey, match);
  const grouped = LINEUP_GROUPS.map((group) => ({
    group,
    players: players.filter((player) => getLineupGroup(player.skills) === group),
  }));

  return (
    <div className="lineup-modal" role="dialog" aria-label={`${currentTeamName} ground view`}>
      <header className="lineup-modal-header">
        <button className="icon-button dark" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        <div className="lineup-modal-title">
          <span>{currentTeamName}</span>
          <small>{players.length}/{match.team_size} picked</small>
        </div>
        <button className="icon-button dark" onClick={onAdd} aria-label="Add player">
          <Plus size={18} />
        </button>
      </header>
      <div className="lineup-modal-ground" style={{ backgroundImage: `url(${grassGroundLineupUrl})` }}>
        {players.length === 0 && (
          <div className="lineup-modal-empty">
            <p>No players on the ground yet.</p>
            <button className="primary-action" onClick={onAdd}>
              <Plus size={16} />
              Add players
            </button>
          </div>
        )}
        {players.length > 0 &&
          grouped.map(({ group, players: groupPlayers }) => (
            <div className="lineup-row" key={group}>
              <span className="lineup-row-label">{GROUP_LABELS[group]}</span>
              <div className="lineup-row-players">
                {groupPlayers.length === 0 ? (
                  <span className="lineup-row-empty">—</span>
                ) : (
                  groupPlayers.map((player) => (
                    <div className="lineup-tile" key={player.id}>
                      <div className="lineup-tile-avatar">
                        <MatchPlayerPhoto player={player} />
                        {player.is_captain && <span className="lineup-tile-badge">C</span>}
                      </div>
                      <span className="lineup-tile-name">{shortPlayerName(player.display_name)}</span>
                      <small className="lineup-tile-role">
                        {playerSkillText(player.skills).split(" · ")[0]}
                      </small>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function DraftModal({
  match,
  teamKey,
  players,
  pickedByProfile,
  statusText,
  canAdd,
  busy,
  onPick,
  onRefresh,
  onClose,
}: {
  match: Match;
  teamKey: TeamKey;
  players: Profile[];
  pickedByProfile: Map<string | null, MatchPlayer>;
  statusText: string;
  canAdd: boolean;
  busy: boolean;
  onPick: (profileId: string) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const currentTeamName = teamLabel(teamKey, match);
  const available = players.filter((player) => !pickedByProfile.get(player.id) && !player.is_banned);
  const others = players.filter((player) => pickedByProfile.get(player.id) || player.is_banned);

  return (
    <div className="lineup-modal draft-modal" role="dialog" aria-label="Pick a player">
      <header className="lineup-modal-header solid">
        <button className="icon-button" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        <div className="lineup-modal-title">
          <span>Pick a player</span>
          <small>{currentTeamName}</small>
        </div>
        <button className="icon-button" onClick={onRefresh} aria-label="Refresh">
          <RotateCcw size={16} />
        </button>
      </header>
      <div className="draft-modal-body">
        <p className="draft-status">{statusText}</p>

        {available.length > 0 && (
          <div className="draft-section">
            <div className="draft-section-label">Available</div>
            <div className="draft-player-list">
              {available.map((player) => (
                <article className="draft-player-row" key={player.id}>
                  <ProfilePhoto profile={player} />
                  <div>
                    <strong>{player.display_name}</strong>
                    <small>{playerSkillText(player.skills)}</small>
                  </div>
                  <button
                    className="tiny-action accent"
                    disabled={!canAdd || busy}
                    onClick={() => {
                      onPick(player.id);
                    }}
                  >
                    <Plus size={12} />
                    Add
                  </button>
                </article>
              ))}
            </div>
          </div>
        )}

        {others.length > 0 && (
          <div className="draft-section">
            <div className="draft-section-label">Unavailable</div>
            <div className="draft-player-list">
              {others.map((player) => {
                const picked = pickedByProfile.get(player.id);
                return (
                  <article className="draft-player-row muted" key={player.id}>
                    <ProfilePhoto profile={player} />
                    <div>
                      <strong>{player.display_name}</strong>
                      <small>
                        {playerSkillText(player.skills)} ·{" "}
                        {player.is_banned
                          ? "Banned"
                          : picked
                            ? `Picked by ${teamLabel(picked.team_key === "b" ? "b" : "a", match)}`
                            : ""}
                      </small>
                    </div>
                    <span className="result-chip lost">
                      {player.is_banned ? "Banned" : "Picked"}
                    </span>
                  </article>
                );
              })}
            </div>
          </div>
        )}

        {available.length === 0 && others.length === 0 && (
          <p className="empty-note">No player accounts available yet.</p>
        )}
      </div>
    </div>
  );
}

type CreaseValues = { striker_id?: string | null; non_striker_id?: string | null; bowler_id?: string | null };

function UmpireView({
  busy,
  match,
  deliveries,
  matchPlayers,
  onScore,
  onUndo,
  onReset,
  onSetCrease,
  onEndInnings,
  onShare,
  onGoToManage,
}: {
  busy: boolean;
  match: Match | null;
  deliveries: Delivery[];
  matchPlayers: MatchPlayer[];
  onScore: (runs: number, options?: { extra?: ExtraType; wicket?: boolean }) => void;
  onUndo: () => void;
  onReset: () => void;
  onSetCrease: (values: CreaseValues) => void;
  onEndInnings: () => void;
  onShare: (message: string) => void;
  onGoToManage: () => void;
}) {
  if (!match) {
    return (
      <section className="panel empty-state">
        <Gauge size={34} />
        <h2>No match yet</h2>
        <p>Go to Manage to create the match. You will land back here to score it live.</p>
        <button className="primary-action" onClick={onGoToManage}>
          <Plus size={19} />
          Create a match
        </button>
      </section>
    );
  }

  const isChase = match.current_innings === 2 && match.target !== null;
  const totalBalls = match.total_overs * 6;
  const runsNeeded = match.target ? Math.max(0, match.target - match.runs) : 0;
  const ballsLeft = Math.max(0, totalBalls - match.legal_balls);
  const crr = runRate(match.runs, match.legal_balls);
  const rrr = match.target ? requiredRunRate(match.target, match.runs, totalBalls, match.legal_balls) : 0;
  const isCompleted = match.status === "completed";
  const displayResult = matchResultNote(match);

  const handleShare = () => {
    const overs = `${getOvers(match.legal_balls)}/${match.total_overs} ov`;
    const chaseLine = isChase && !isCompleted ? ` · need ${runsNeeded} in ${ballsLeft}` : "";
    const summary = isCompleted && displayResult ? ` · ${displayResult}` : "";
    const text = `🏏 ${match.title} — ${teamLabel(match.batting_team_key, match)} ${match.runs}/${match.wickets} (${overs}), CRR ${formatRate(
      crr,
    )}${chaseLine}${summary} · Cricket Mania`;
    void shareContent({ title: match.title, text }, onShare);
  };

  return (
    <section className="stack">
      <div className="innings-banner">
        <span>{isCompleted ? "Result" : `Innings ${match.current_innings}`}</span>
        <span>{teamLabel(match.batting_team_key, match)} batting</span>
      </div>

      <div className="score-hero">
        <span>{match.title}</span>
        <strong>
          {match.runs}/{match.wickets}
        </strong>
        <small>
          {getOvers(match.legal_balls)}/{match.total_overs} overs
        </small>
        <div className="rate-badges">
          <span className="rate-badge">
            <Gauge size={13} /> CRR {formatRate(crr)}
          </span>
          {isChase && !isCompleted && (
            <span className="rate-badge accent">
              <Target size={13} /> RRR {formatRate(rrr)}
            </span>
          )}
        </div>
      </div>

      {isCompleted && displayResult && <div className="result-banner">{displayResult}</div>}

      {isChase && !isCompleted && (
        <div className="chase-strip">
          <span>Target {match.target}</span>
          <strong>
            Need {runsNeeded} in {ballsLeft} balls
          </strong>
        </div>
      )}

      <section className="panel">
        <div className="panel-title">
          <h3>Scoring deck</h3>
          <span>Umpire</span>
        </div>
        <LiveScoring
          busy={busy}
          match={match}
          matchPlayers={matchPlayers}
          onScore={onScore}
          onUndo={onUndo}
          onReset={onReset}
          onSetCrease={onSetCrease}
          onEndInnings={onEndInnings}
        />
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Overs</h3>
          <span>{deliveries.length} balls</span>
        </div>
        <BallStrip deliveries={deliveries} matchPlayers={matchPlayers} />
      </section>

      <button className="secondary-action share-action" onClick={handleShare}>
        <Share2 size={18} />
        Share live score
      </button>
    </section>
  );
}

function ManageView({
  busy,
  match,
  profiles,
  roles,
  captainTeams,
  currentUserId,
  onCreateMatch,
  onUpdateRole,
  onToggleBan,
  onRefreshPlayers,
  onResetAll,
  onGoToUmpire,
}: {
  busy: boolean;
  match: Match | null;
  profiles: Profile[];
  roles: UserRole[];
  captainTeams: CaptainTeam[];
  currentUserId: string;
  onCreateMatch: (formData: FormData) => void;
  onUpdateRole: (profileId: string, nextRole: AppRole) => void;
  onToggleBan: (profileId: string, banned: boolean) => void;
  onRefreshPlayers: () => void;
  onResetAll: () => void;
  onGoToUmpire: () => void;
}) {
  const roleMap = new Map(roles.map((item) => [item.user_id, item.role]));
  const [showNewMatch, setShowNewMatch] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const activeCaptainTeams = captainTeams.filter((team) => team.captain_id);
  const [selectedTeamAId, setSelectedTeamAId] = useState("");
  const [selectedTeamBId, setSelectedTeamBId] = useState("");
  const matchInProgress = match !== null && match.status !== "completed";
  const showCreateForm = !matchInProgress || showNewMatch;
  const selectedProfile = profiles.find((item) => item.id === selectedProfileId) ?? null;
  const teamA = activeCaptainTeams.find((team) => team.id === selectedTeamAId) ?? activeCaptainTeams[0] ?? null;
  const teamB =
    activeCaptainTeams.find((team) => team.id === selectedTeamBId && team.id !== teamA?.id) ??
    activeCaptainTeams.find((team) => team.id !== teamA?.id) ??
    null;

  if (selectedProfile) {
    return (
      <AdminProfileDetail
        currentUserId={currentUserId}
        profile={selectedProfile}
        role={roleMap.get(selectedProfile.id) ?? "player"}
        onBack={() => setSelectedProfileId(null)}
        onToggleBan={onToggleBan}
        onUpdateRole={onUpdateRole}
      />
    );
  }

  return (
    <section className="stack">
      {matchInProgress && (
        <div className="hero-card">
          <div>
            <p className="eyebrow">Live match</p>
            <h2>{match!.title}</h2>
            <p className="muted-text" style={{ marginTop: 6, color: "rgba(255,255,255,0.75)" }}>
              {match!.runs}/{match!.wickets} · {getOvers(match!.legal_balls)}/{match!.total_overs} ov
            </p>
          </div>
          <button className="secondary-action accent" onClick={onGoToUmpire}>
            <Gauge size={18} />
            Score
          </button>
        </div>
      )}

      {showCreateForm ? (
        <form
          className="panel admin-form"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            onCreateMatch(new FormData(event.currentTarget));
            setShowNewMatch(false);
          }}
        >
          <div className="panel-title">
            <h3>{matchInProgress ? "Start another match" : "Create match"}</h3>
            <span>Admin</span>
          </div>
          {activeCaptainTeams.length < 2 && (
            <p className="empty-note">At least two captains need to create teams before an admin can create a match.</p>
          )}
          <input name="title" placeholder="Sunday Turf Match" />
          <input name="venue" placeholder="Local Turf" />
          <div className="split-inputs">
            <label className="field">
              <span>First team</span>
              <select
                name="teamAId"
                value={teamA?.id ?? ""}
                onChange={(event) => setSelectedTeamAId(event.target.value)}
              >
                <option value="">Select team</option>
                {activeCaptainTeams.map((team) => (
                  <option value={team.id} key={team.id} disabled={team.id === teamB?.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Second team</span>
              <select
                name="teamBId"
                value={teamB?.id ?? ""}
                onChange={(event) => setSelectedTeamBId(event.target.value)}
              >
                <option value="">Select team</option>
                {activeCaptainTeams.map((team) => (
                  <option value={team.id} key={team.id} disabled={team.id === teamA?.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="split-inputs">
            <label className="field">
              <span>Team size</span>
              <select name="teamSize" defaultValue="6">
                {TEAM_SIZES.map((size) => (
                  <option value={size} key={size}>
                    {size}v{size}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Overs / innings</span>
              <input name="totalOvers" type="number" min={1} max={50} defaultValue={6} />
            </label>
          </div>
          <label className="field">
            <span>Toss winner / first pick</span>
            <select name="tossWinner" defaultValue="a">
              <option value="a">{teamA?.name ?? "First team"}</option>
              <option value="b">{teamB?.name ?? "Second team"}</option>
            </select>
          </label>
          <div className="dual-actions">
            <button type="submit" className="primary-action" disabled={busy || activeCaptainTeams.length < 2}>
              <Plus size={19} />
              Create match
            </button>
            {matchInProgress && (
              <button type="button" className="secondary-action" onClick={() => setShowNewMatch(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      ) : (
        <button className="secondary-action share-action" onClick={() => setShowNewMatch(true)}>
          <Plus size={18} />
          Start a new match
        </button>
      )}

      <section className="panel">
        <div className="panel-title">
          <h3>Player accounts</h3>
          <button className="tiny-action" onClick={onRefreshPlayers}>
            Refresh
          </button>
        </div>
        <div className="admin-player-list">
          {profiles.map((player) => (
            <PlayerAdminTile
              key={player.id}
              profile={player}
              role={roleMap.get(player.id) ?? "player"}
              onMore={() => setSelectedProfileId(player.id)}
            />
          ))}
          {profiles.length === 0 && <p className="empty-note">No player accounts yet.</p>}
        </div>
      </section>

      <section className="panel danger-zone">
        <div className="panel-title">
          <h3>Danger zone</h3>
          <span>Irreversible</span>
        </div>
        <p className="empty-note">
          Wipe every match, scoreboard, delivery, and team squad. Player accounts, roles, and
          profile photos are kept.
        </p>
        <button className="secondary-action danger-soft" disabled={busy} onClick={onResetAll}>
          <RotateCcw size={16} />
          Reset all match data
        </button>
      </section>
    </section>
  );
}

function LiveScoring({
  busy,
  match,
  matchPlayers,
  onScore,
  onUndo,
  onReset,
  onSetCrease,
  onEndInnings,
}: {
  busy: boolean;
  match: Match;
  matchPlayers: MatchPlayer[];
  onScore: (runs: number, options?: { extra?: ExtraType; wicket?: boolean }) => void;
  onUndo: () => void;
  onReset: () => void;
  onSetCrease: (values: CreaseValues) => void;
  onEndInnings: () => void;
}) {
  const battingPlayers = matchPlayers.filter((item) => item.team_key === match.batting_team_key);
  const bowlingPlayers = matchPlayers.filter((item) => item.team_key === otherTeam(match.batting_team_key));
  const battingSquad = battingPlayers.length;
  const creaseReady = Boolean(match.striker_id && match.bowler_id);
  const totalBalls = match.total_overs * 6;
  const allOut = battingSquad > 0 && match.wickets >= battingSquad - 1;
  const oversDone = match.legal_balls >= totalBalls;
  const inningsOver = allOut || oversDone;
  const isChase = match.current_innings === 2 && match.target !== null;
  const chaseWon = isChase && match.target !== null && match.runs >= match.target;
  const canScore = creaseReady && !inningsOver && !chaseWon && match.status !== "completed";

  if (match.status === "completed") {
    return (
      <div className="scoring-complete">
        <p className="result-banner">{matchResultNote(match) ?? "Match complete."}</p>
        <div className="dual-actions">
          <button className="secondary-action" disabled={busy} onClick={onUndo}>
            <RotateCcw size={18} />
            Undo ball
          </button>
          <button className="secondary-action danger-soft" disabled={busy} onClick={onReset}>
            <RotateCcw size={18} />
            Reset match
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="scoring-status">
        <span>Innings {match.current_innings}</span>
        <span>{teamLabel(match.batting_team_key, match)} batting</span>
        {isChase && <span>Target {match.target}</span>}
      </div>

      {battingSquad === 0 ? (
        <p className="empty-note">Build the squads first — captains add players on the Team tab.</p>
      ) : (
        <>
          <div className="crease-selectors">
            <label className="field">
              <span>Striker</span>
              <select
                value={match.striker_id ?? ""}
                disabled={busy}
                onChange={(event) => onSetCrease({ striker_id: event.target.value || null })}
              >
                <option value="">Pick striker</option>
                {battingPlayers.map((player) => (
                  <option value={player.id} key={player.id} disabled={player.is_out || player.id === match.non_striker_id}>
                    {player.display_name}
                    {player.is_out ? " (out)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Non-striker</span>
              <select
                value={match.non_striker_id ?? ""}
                disabled={busy}
                onChange={(event) => onSetCrease({ non_striker_id: event.target.value || null })}
              >
                <option value="">Pick non-striker</option>
                {battingPlayers.map((player) => (
                  <option value={player.id} key={player.id} disabled={player.is_out || player.id === match.striker_id}>
                    {player.display_name}
                    {player.is_out ? " (out)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Bowler</span>
              <select
                value={match.bowler_id ?? ""}
                disabled={busy}
                onChange={(event) => onSetCrease({ bowler_id: event.target.value || null })}
              >
                <option value="">Pick bowler</option>
                {bowlingPlayers.map((player) => (
                  <option value={player.id} key={player.id}>
                    {player.display_name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!creaseReady && <p className="empty-note">Pick a striker and a bowler to start scoring.</p>}

          {creaseReady && match.striker_id && match.non_striker_id && (
            <button
              type="button"
              className="tiny-action swap-strike"
              disabled={busy}
              onClick={() =>
                onSetCrease({ striker_id: match.non_striker_id, non_striker_id: match.striker_id })
              }
            >
              <RotateCcw size={14} />
              Swap strike
            </button>
          )}

          <div className="run-grid">
            {[0, 1, 2, 3, 4, 6].map((run) => (
              <button key={run} disabled={busy || !canScore} onClick={() => onScore(run)}>
                {run}
              </button>
            ))}
          </div>
          <div className="extras-grid">
            <button disabled={busy || !canScore} onClick={() => onScore(0, { extra: "WD" })}>
              Wide
            </button>
            <button disabled={busy || !canScore} onClick={() => onScore(0, { extra: "NB" })}>
              No ball
            </button>
            <button disabled={busy || !canScore} onClick={() => onScore(0, { extra: "B" })}>
              Bye
            </button>
            <button disabled={busy || !canScore} onClick={() => onScore(0, { extra: "LB" })}>
              Leg bye
            </button>
            <button className="danger" disabled={busy || !canScore} onClick={() => onScore(0, { wicket: true })}>
              Wicket
            </button>
          </div>

          {inningsOver && (
            <p className="empty-note">
              {allOut ? "All out." : "Overs complete."}{" "}
              {match.current_innings === 1 ? "End the innings." : "End the match."}
            </p>
          )}
        </>
      )}

      <div className="dual-actions">
        <button className={`secondary-action ${inningsOver ? "accent" : ""}`} disabled={busy} onClick={onEndInnings}>
          <Flag size={18} />
          {match.current_innings === 1 ? "End innings" : "End match"}
        </button>
        <button className="secondary-action" disabled={busy} onClick={onUndo}>
          <RotateCcw size={18} />
          Undo ball
        </button>
        <button className="secondary-action danger-soft" disabled={busy} onClick={onReset}>
          <RotateCcw size={18} />
          Reset
        </button>
      </div>
    </>
  );
}

function PlayerAdminTile({
  profile,
  role,
  onMore,
}: {
  profile: Profile;
  role: AppRole;
  onMore: () => void;
}) {
  return (
    <article className="admin-player-row">
      <ProfilePhoto profile={profile} />
      <div>
        <strong>{profile.display_name}</strong>
        <small>{profile.email}</small>
        <span className={`result-chip ${profile.is_banned ? "lost" : "pending"}`}>
          {profile.is_banned ? "Banned" : role}
        </span>
      </div>
      <button className="icon-button" aria-label={`More about ${profile.display_name}`} onClick={onMore}>
        <MoreHorizontal size={20} />
      </button>
    </article>
  );
}

function AdminProfileDetail({
  profile,
  role,
  currentUserId,
  onBack,
  onToggleBan,
  onUpdateRole,
}: {
  profile: Profile;
  role: AppRole;
  currentUserId: string;
  onBack: () => void;
  onToggleBan: (profileId: string, banned: boolean) => void;
  onUpdateRole: (profileId: string, nextRole: AppRole) => void;
}) {
  const isSelf = profile.id === currentUserId;
  const isCaptain = role === "captain";

  return (
    <section className="stack">
      <section className="panel profile-detail-panel">
        <div className="panel-title">
          <h3>Player details</h3>
          <button className="tiny-action" onClick={onBack}>
            Back
          </button>
        </div>
        <div className="profile-detail-head">
          <ProfilePhoto profile={profile} size="large" />
          <div>
            <h2>{profile.display_name}</h2>
            <p>{profile.email}</p>
            <span className={`result-chip ${profile.is_banned ? "lost" : "pending"}`}>
              {profile.is_banned ? "Banned" : role}
            </span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Admin actions</h3>
          <span>{isSelf ? "Your account" : "Manage"}</span>
        </div>
        <div className="action-list">
          <button
            className="secondary-action"
            disabled={isSelf || role === "admin" || profile.is_banned}
            onClick={() => onUpdateRole(profile.id, isCaptain ? "player" : "captain")}
          >
            <UserCog size={18} />
            {isCaptain ? "Remove captain" : "Assign captain"}
          </button>
          <button
            className={`secondary-action ${profile.is_banned ? "" : "danger-soft"}`}
            disabled={isSelf || role === "admin"}
            onClick={() => onToggleBan(profile.id, !profile.is_banned)}
          >
            {profile.is_banned ? <UserCheck size={18} /> : <UserX size={18} />}
            {profile.is_banned ? "Unban user" : "Ban user"}
          </button>
        </div>
      </section>
    </section>
  );
}

function ProfilePhoto({ profile, size = "normal" }: { profile: Profile | null; size?: "normal" | "large" }) {
  const initial = profile?.display_name?.slice(0, 1).toUpperCase() || "P";

  return (
    <span className={`profile-photo ${size}`}>
      {profile?.avatar_url ? <img src={profile.avatar_url} alt={`${profile.display_name} profile`} /> : initial}
    </span>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M21.6 12.227c0-.71-.064-1.39-.182-2.045H12v3.867h5.382a4.604 4.604 0 0 1-1.996 3.018v2.51h3.229c1.89-1.74 2.985-4.305 2.985-7.35z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.7 0 4.964-.895 6.619-2.423l-3.23-2.51c-.895.6-2.04.955-3.389.955-2.605 0-4.81-1.76-5.598-4.124H3.064v2.59A9.998 9.998 0 0 0 12 22z"
        fill="#34A853"
      />
      <path
        d="M6.402 13.898A6.005 6.005 0 0 1 6.09 12c0-.66.114-1.298.313-1.898V7.512H3.064A9.997 9.997 0 0 0 2 12c0 1.615.386 3.142 1.064 4.488l3.338-2.59z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.978c1.47 0 2.788.506 3.825 1.498l2.867-2.867C16.96 2.99 14.696 2 12 2A9.998 9.998 0 0 0 3.064 7.512l3.338 2.59C7.19 7.738 9.395 5.978 12 5.978z"
        fill="#EA4335"
      />
    </svg>
  );
}

function MatchPlayerPhoto({ player }: { player: MatchPlayer }) {
  const initial = player.display_name?.slice(0, 1).toUpperCase() || "P";

  return (
    <span className="profile-photo small">
      {player.avatar_url ? <img src={player.avatar_url} alt={`${player.display_name} profile`} /> : initial}
    </span>
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

type OverGroup = {
  key: string;
  over: number;
  innings: number;
  bowlerId: string | null;
  balls: Delivery[];
  runs: number;
  wickets: number;
};

function groupDeliveriesByOver(deliveries: Delivery[]): OverGroup[] {
  // deliveries arrive newest-first from the loader; walk chronologically so we can track legal balls
  const sorted = [...deliveries].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const groups: OverGroup[] = [];
  let current: OverGroup | null = null;
  const legalsPerInnings = new Map<number, number>();

  for (const d of sorted) {
    const legalsBefore = legalsPerInnings.get(d.innings) ?? 0;
    const overNumber = Math.floor(legalsBefore / 6) + 1;
    const key = `${d.innings}-${overNumber}-${d.bowler_id ?? "?"}`;

    if (!current || current.key !== key) {
      current = {
        key,
        over: overNumber,
        innings: d.innings,
        bowlerId: d.bowler_id,
        balls: [],
        runs: 0,
        wickets: 0,
      };
      groups.push(current);
    }

    current.balls.push(d);
    current.runs += d.runs;
    if (d.wicket) current.wickets += 1;

    if (d.legal) legalsPerInnings.set(d.innings, legalsBefore + 1);
  }

  return groups.reverse();
}

function BallStrip({ deliveries, matchPlayers }: { deliveries: Delivery[]; matchPlayers: MatchPlayer[] }) {
  if (deliveries.length === 0) {
    return <p className="empty-note">No balls scored yet.</p>;
  }

  const overs = groupDeliveriesByOver(deliveries);
  const playerById = new Map(matchPlayers.map((p) => [p.id, p]));

  return (
    <div className="over-table">
      {overs.map((over) => {
        const bowler = over.bowlerId ? playerById.get(over.bowlerId) : null;
        const bowlerName = bowler?.display_name ?? "Bowler";
        return (
          <div className="over-row" key={over.key}>
            <div className="over-bowler">
              <strong>{shortPlayerName(bowlerName)}</strong>
              <small>
                Ov {over.over} · {over.runs}-{over.wickets}
              </small>
            </div>
            <div className="over-balls">
              {over.balls.map((delivery) => {
                let cls = "over-ball";
                if (delivery.wicket) cls += " wicket-ball";
                else if (delivery.extra) cls += " extra-ball";
                else if (delivery.runs >= 4) cls += " boundary-ball";
                return (
                  <span className={cls} key={delivery.id}>
                    {delivery.label}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SkillChips({ skills }: { skills: string[] }) {
  if (skills.length === 0) {
    return <span className="muted-text">No skills added yet</span>;
  }

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
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={active ? "active" : ""} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
