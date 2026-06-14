import {
  Activity,
  Camera,
  ClipboardList,
  Flag,
  Gauge,
  LogOut,
  Mail,
  Plus,
  RotateCcw,
  Share2,
  Shield,
  Target,
  UserCog,
  Swords,
  Trophy,
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import type { AppRole, Delivery, Match, MatchPlayer, Profile, TeamKey, UserRole, WinnerTeam } from "./lib/database.types";

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
  match ? (key === "a" ? match.team_a_name : match.team_b_name) || (key === "a" ? "Team A" : "Team B") : key === "a" ? "Team A" : "Team B";
const teamLogoUrl = (key: TeamKey, match: Match) => (key === "a" ? match.team_a_logo_url : match.team_b_logo_url);
const teamLogoPath = (key: TeamKey, match: Match) => (key === "a" ? match.team_a_logo_path : match.team_b_logo_path);
const matchResultNote = (match: Match) =>
  match.result_note?.replace(/^Team A/, teamLabel("a", match)).replace(/^Team B/, teamLabel("b", match)) ?? null;
const otherTeam = (key: TeamKey): TeamKey => (key === "a" ? "b" : "a");

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

async function uploadTeamLogoBlob(userId: string, teamKey: TeamKey, blob: Blob) {
  const path = `${userId}/team-${teamKey}-${Date.now()}.webp`;
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
  const showTeamTab = isCaptain || Boolean(captainTeamKey);

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
      setRole(roleData?.role ?? "player");

      await loadMyCareer(userId);

      const loadedMatches = await loadMatches();
      const assignedAsCaptain = loadedMatches.some(
        (match) => match.captain_a_id === userId || match.captain_b_id === userId,
      );
      if (roleData?.role === "admin" || roleData?.role === "captain" || assignedAsCaptain) {
        await loadPlayerProfiles(roleData?.role === "admin");
      }
    } finally {
      setBusy(false);
    }
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
      .limit(24);

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
    await loadPlayerProfiles(true);
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
    const firstBatting: TeamKey = String(formData.get("firstBatting") ?? "a") === "b" ? "b" : "a";
    const captainAId = String(formData.get("captainAId") ?? "");
    const captainBId = String(formData.get("captainBId") ?? "");

    if (captainAId && captainBId && captainAId === captainBId) {
      setNotice("Choose two different captains.");
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
        first_batting_team: firstBatting,
        batting_team_key: firstBatting,
        current_innings: 1,
        captain_a_id: captainAId || null,
        captain_b_id: captainBId || null,
        created_by: session.user.id,
      })
      .select()
      .single();

    setBusy(false);

    if (error) {
      setNotice(error.message);
      return;
    }

    setNotice(`Match created. ${totalOvers} overs each, ${teamLabel(firstBatting, data as Match)} bats first.`);
    setActiveMatchId(data.id);

    const captainRows = [
      { profile: profiles.find((item) => item.id === captainAId), team_key: "a" as const },
      { profile: profiles.find((item) => item.id === captainBId), team_key: "b" as const },
    ].filter((item): item is { profile: Profile; team_key: "a" | "b" } => Boolean(item.profile));

    if (captainRows.length > 0) {
      const roleMap = new Map(roles.map((item) => [item.user_id, item.role]));
      const captainIdsToPromote = captainRows
        .map(({ profile: captain }) => captain.id)
        .filter((captainId) => roleMap.get(captainId) !== "admin");

      if (captainIdsToPromote.length > 0) {
        const { error: roleError } = await supabase
          .from("user_roles")
          .update({ role: "captain" })
          .in("user_id", captainIdsToPromote);

        if (roleError) {
          setNotice(roleError.message);
        }
      }

      const { error: playerError } = await supabase.from("match_players").insert(
        captainRows.map(({ profile: captain, team_key }) => ({
          match_id: data.id,
          profile_id: captain.id,
          display_name: captain.display_name,
          team_key,
          is_captain: true,
          skills: captain.skills,
          avatar_url: captain.avatar_url,
        })),
      );

      if (playerError) {
        setNotice(playerError.message);
      }
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

  async function updatePlayer(profileId: string, values: Partial<Pick<Profile, "display_name" | "phone" | "skills">>) {
    if (!isAdmin) {
      return;
    }

    const { error } = await supabase.from("profiles").update(values).eq("id", profileId);
    if (error) {
      setNotice(error.message);
      return;
    }

    await loadAdminLists();
  }

  async function addTeamPlayer(profileId: string) {
    const teamKey = captainTeamKey;
    if (!activeMatch || !teamKey) {
      return;
    }

    const player = profiles.find((item) => item.id === profileId);
    if (!player) {
      setNotice("Player profile not found.");
      return;
    }

    const teamCount = matchPlayers.filter((item) => item.team_key === teamKey).length;
    if (teamCount >= activeMatch.team_size) {
      setNotice("This team is full.");
      return;
    }

    const { error } = await supabase.from("match_players").insert({
      match_id: activeMatch.id,
      profile_id: player.id,
      display_name: player.display_name,
      team_key: teamKey,
      is_captain: false,
      skills: player.skills,
      avatar_url: player.avatar_url,
    });

    if (error) {
      setNotice(error.message);
      return;
    }

    await loadMatchPlayers(activeMatch.id);
  }

  async function updateTeamBranding(teamKey: TeamKey, values: { name: string; logoFile?: File | null }) {
    if (!activeMatch || !session?.user) {
      return;
    }

    const oldLogoPath = teamLogoPath(teamKey, activeMatch);
    setBusy(true);
    try {
      let logo: { path: string; publicUrl: string } | null = null;
      if (values.logoFile) {
        const blob = await compressSquareAvatar(values.logoFile);
        logo = await uploadTeamLogoBlob(session.user.id, teamKey, blob);
      }

      const { error } = await supabase.rpc("update_match_team_branding", {
        p_match_id: activeMatch.id,
        p_team_key: teamKey,
        p_team_name: values.name,
        p_logo_url: logo?.publicUrl ?? null,
        p_logo_path: logo?.path ?? null,
      });

      if (error) {
        throw error;
      }

      if (logo && oldLogoPath && oldLogoPath !== logo.path) {
        await supabase.storage.from(TEAM_LOGOS_BUCKET).remove([oldLogoPath]);
      }

      setNotice("Team branding updated.");
      await loadMatches();
    } catch (error) {
      setNotice(formatErrorMessage(error, "Unable to update team branding."));
    } finally {
      setBusy(false);
    }
  }

  async function removeTeamPlayer(rowId: string) {
    if (!activeMatch) {
      return;
    }

    const { error } = await supabase.from("match_players").delete().eq("id", rowId);
    if (error) {
      setNotice(error.message);
      return;
    }

    await loadMatchPlayers(activeMatch.id);
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
              matchPlayers={matchPlayers}
              teamKey={captainTeamKey}
              onAddPlayer={addTeamPlayer}
              onRemovePlayer={removeTeamPlayer}
              onUpdateBranding={updateTeamBranding}
              onRefresh={() => {
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
              currentUserId={session.user.id}
              onCreateMatch={createMatch}
              onUpdatePlayer={updatePlayer}
              onUpdateRole={updateRole}
              onRefreshPlayers={loadAdminLists}
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
          <h3>Recent balls</h3>
          <span>{deliveries.length} shown</span>
        </div>
        <BallStrip deliveries={deliveries} />
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
  matchPlayers,
  teamKey,
  onAddPlayer,
  onRemovePlayer,
  onUpdateBranding,
  onRefresh,
}: {
  busy: boolean;
  match: Match | null;
  profiles: Profile[];
  matchPlayers: MatchPlayer[];
  teamKey: "a" | "b" | null;
  onAddPlayer: (profileId: string) => void;
  onRemovePlayer: (rowId: string) => void;
  onUpdateBranding: (teamKey: TeamKey, values: { name: string; logoFile?: File | null }) => void;
  onRefresh: () => void;
}) {
  if (!match) {
    return (
      <section className="panel empty-state">
        <Swords size={34} />
        <h2>No match selected</h2>
        <p>Once an admin creates a match and assigns captains, captains can build their teams here.</p>
      </section>
    );
  }

  if (!teamKey) {
    return (
      <section className="panel empty-state">
        <Shield size={34} />
        <h2>No captain team</h2>
        <p>Ask the admin to assign you as Team A or Team B captain for this match.</p>
      </section>
    );
  }

  const selectedProfileIds = new Set(matchPlayers.map((item) => item.profile_id).filter(Boolean));
  const teamRows = matchPlayers.filter((item) => item.team_key === teamKey);
  const availablePlayers = profiles.filter((item) => !selectedProfileIds.has(item.id));
  const currentTeamName = teamLabel(teamKey, match);
  const currentTeamLogo = teamLogoUrl(teamKey, match);
  const isFull = teamRows.length >= match.team_size;

  return (
    <section className="stack">
      <div className="hero-card">
        <div>
          <p className="eyebrow">Captain mode</p>
          <h2>{currentTeamName}</h2>
        </div>
        <span className="team-logo large">{currentTeamLogo ? <img src={currentTeamLogo} alt={`${currentTeamName} logo`} /> : currentTeamName.slice(0, 1)}</span>
      </div>

      <form
        className="panel team-brand-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const logoFile = formData.get("logoFile");
          onUpdateBranding(teamKey, {
            name: String(formData.get("teamName") ?? currentTeamName),
            logoFile: logoFile instanceof File && logoFile.size > 0 ? logoFile : null,
          });
          const input = event.currentTarget.querySelector<HTMLInputElement>('input[name="logoFile"]');
          if (input) input.value = "";
        }}
      >
        <div className="panel-title">
          <h3>Team identity</h3>
          <span>{teamRows.length}/{match.team_size}</span>
        </div>
        <label className="field">
          <span>Team name</span>
          <input name="teamName" defaultValue={currentTeamName} placeholder="Team name" />
        </label>
        <label className="avatar-picker team-logo-picker">
          <span className="team-logo">{currentTeamLogo ? <img src={currentTeamLogo} alt={`${currentTeamName} logo`} /> : <Camera size={24} />}</span>
          <span>
            Team logo
            <small>1:1 square, compressed before upload</small>
          </span>
          <input name="logoFile" aria-label="Team logo" accept="image/png,image/jpeg,image/webp" type="file" />
        </label>
        <button className="primary-action" disabled={busy}>
          <Camera size={18} />
          Save team
        </button>
      </form>

      <form
        className="panel team-add-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const profileId = String(new FormData(event.currentTarget).get("profileId") ?? "");
          if (profileId) {
            onAddPlayer(profileId);
            event.currentTarget.reset();
          }
        }}
      >
        <div className="panel-title">
          <h3>Add player</h3>
          <button className="tiny-action" type="button" onClick={onRefresh}>
            Refresh
          </button>
        </div>
        <select name="profileId" defaultValue="" disabled={busy || isFull || availablePlayers.length === 0}>
          <option value="">{isFull ? "Team is full" : "Choose player"}</option>
          {availablePlayers.map((player) => (
            <option value={player.id} key={player.id}>
              {player.display_name}
            </option>
          ))}
        </select>
        <button className="primary-action" disabled={busy || isFull || availablePlayers.length === 0}>
          <Plus size={19} />
          Add to {currentTeamName}
        </button>
      </form>

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
              {row.is_captain ? (
                <span className="captain-badge">Captain</span>
              ) : (
                <button className="tiny-action danger-soft" disabled={busy} onClick={() => onRemovePlayer(row.id)}>
                  Remove
                </button>
              )}
            </article>
          ))}
          {teamRows.length === 0 && <p className="empty-note">No players picked yet.</p>}
        </div>
      </section>
    </section>
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
          <h3>Recent balls</h3>
          <span>{deliveries.length} shown</span>
        </div>
        <BallStrip deliveries={deliveries} />
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
  currentUserId,
  onCreateMatch,
  onUpdatePlayer,
  onUpdateRole,
  onRefreshPlayers,
  onGoToUmpire,
}: {
  busy: boolean;
  match: Match | null;
  profiles: Profile[];
  roles: UserRole[];
  currentUserId: string;
  onCreateMatch: (formData: FormData) => void;
  onUpdatePlayer: (profileId: string, values: Partial<Pick<Profile, "display_name" | "phone" | "skills">>) => void;
  onUpdateRole: (profileId: string, nextRole: AppRole) => void;
  onRefreshPlayers: () => void;
  onGoToUmpire: () => void;
}) {
  const roleMap = new Map(roles.map((item) => [item.user_id, item.role]));
  const [showNewMatch, setShowNewMatch] = useState(false);
  const matchInProgress = match !== null && match.status !== "completed";
  const showCreateForm = !matchInProgress || showNewMatch;

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
          <input name="title" placeholder="Sunday Turf Match" />
          <input name="venue" placeholder="Local Turf" />
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
            <span>Bats first</span>
            <select name="firstBatting" defaultValue="a">
              <option value="a">Team A</option>
              <option value="b">Team B</option>
            </select>
          </label>
          <div className="split-inputs">
            <select name="captainAId" defaultValue="">
              <option value="">Team A captain</option>
              {profiles.map((player) => (
                <option value={player.id} key={player.id}>
                  {player.display_name}
                </option>
              ))}
            </select>
            <select name="captainBId" defaultValue="">
              <option value="">Team B captain</option>
              {profiles.map((player) => (
                <option value={player.id} key={player.id}>
                  {player.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="dual-actions">
            <button type="submit" className="primary-action" disabled={busy}>
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
            <PlayerAdminRow
              key={player.id}
              profile={player}
              role={roleMap.get(player.id) ?? "player"}
              isSelf={player.id === currentUserId}
              onUpdatePlayer={onUpdatePlayer}
              onUpdateRole={onUpdateRole}
            />
          ))}
          {profiles.length === 0 && <p className="empty-note">No player accounts yet.</p>}
        </div>
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

function PlayerAdminRow({
  profile,
  role,
  isSelf,
  onUpdatePlayer,
  onUpdateRole,
}: {
  profile: Profile;
  role: AppRole;
  isSelf: boolean;
  onUpdatePlayer: (profileId: string, values: Partial<Pick<Profile, "display_name" | "phone" | "skills">>) => void;
  onUpdateRole: (profileId: string, nextRole: AppRole) => void;
}) {
  const [name, setName] = useState(profile.display_name);
  const [skills, setSkills] = useState(profile.skills.join(", "));

  return (
    <article className="admin-player-row">
      <ProfilePhoto profile={profile} />
      <div>
        <input value={name} onChange={(event) => setName(event.target.value)} />
        <small>{profile.email}</small>
        <input value={skills} onChange={(event) => setSkills(event.target.value)} placeholder="Bat, Bowl, WK" />
        <label className="role-control">
          <span>
            <UserCog size={14} />
            Role
          </span>
          <select
            aria-label={`${profile.display_name} role`}
            disabled={isSelf}
            value={role}
            onChange={(event) => onUpdateRole(profile.id, event.target.value as AppRole)}
          >
            <option value="player">Player</option>
            <option value="captain">Captain</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <div className="dual-actions">
          <button
            className="secondary-action"
            onClick={() =>
              onUpdatePlayer(profile.id, {
                display_name: name.trim() || profile.display_name,
                skills: skills
                  .split(",")
                  .map((skill) => skill.trim())
                  .filter(Boolean),
              })
            }
          >
            Save
          </button>
        </div>
      </div>
    </article>
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

function BallStrip({ deliveries }: { deliveries: Delivery[] }) {
  return (
    <div className="ball-strip">
      {deliveries.map((delivery) => (
        <span className={delivery.wicket ? "wicket-ball" : ""} key={delivery.id}>
          {delivery.label}
        </span>
      ))}
      {deliveries.length === 0 && <p className="empty-note">No balls scored yet.</p>}
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
