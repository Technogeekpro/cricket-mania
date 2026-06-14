import {
  Activity,
  Camera,
  ClipboardList,
  LogOut,
  Mail,
  Plus,
  RotateCcw,
  Shield,
  UserCog,
  Swords,
  Trophy,
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import type { AppRole, Delivery, Match, MatchPlayer, MatchStatus, Profile, UserRole } from "./lib/database.types";

type Tab = "scoreboard" | "players" | "team" | "admin";
type ExtraType = "WD" | "NB" | "B" | "LB";

const TEAM_SIZES = [5, 6, 7, 8, 10, 11];
const PRODUCTION_URL = "https://cricket-mania-tau.vercel.app/";
const AVATAR_BUCKET = "profile-photos";
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
    if ((tab === "admin" && !isAdmin) || (tab === "team" && !showTeamTab)) {
      setTab("scoreboard");
    }
  }, [isAdmin, showTeamTab, tab]);

  async function loadAppData(userId: string) {
    setBusy(true);
    try {
      const [{ data: profileData }, { data: roleData }] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", userId).maybeSingle(),
        supabase.from("user_roles").select("*").eq("user_id", userId).maybeSingle(),
      ]);

      let nextProfile = (profileData ?? null) as Profile | null;
      nextProfile = await uploadPendingAvatarIfNeeded(userId, nextProfile);
      setProfile(nextProfile);
      setRole(roleData?.role ?? "player");

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
    const captainAId = String(formData.get("captainAId") ?? "");
    const captainBId = String(formData.get("captainBId") ?? "");
    const striker = String(formData.get("striker") ?? "").trim();
    const nonStriker = String(formData.get("nonStriker") ?? "").trim();
    const bowler = String(formData.get("bowler") ?? "").trim();

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
        status: "live",
        striker_name: striker || null,
        non_striker_name: nonStriker || null,
        bowler_name: bowler || null,
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

    setNotice("Match created and live.");
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
        })),
      );

      if (playerError) {
        setNotice(playerError.message);
      }
    }

    await loadMatches();
    await loadMatchPlayers(data.id);
  }

  async function updateMatchStatus(status: MatchStatus) {
    if (!activeMatch || !isAdmin) {
      return;
    }

    const { error } = await supabase.from("matches").update({ status }).eq("id", activeMatch.id);
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

    const legal = options.extra !== "WD" && options.extra !== "NB";
    const runValue = options.extra ? runs + 1 : runs;
    const nextLegalBalls = activeMatch.legal_balls + (legal ? 1 : 0);
    const nextWickets = activeMatch.wickets + (options.wicket ? 1 : 0);
    const label = options.wicket
      ? "W"
      : options.extra
        ? `${options.extra}${runs > 0 ? `+${runs}` : ""}`
        : String(runs);

    setBusy(true);
    const [{ error: deliveryError }, { error: matchError }] = await Promise.all([
      supabase.from("deliveries").insert({
        match_id: activeMatch.id,
        label,
        runs: runValue,
        legal,
        wicket: Boolean(options.wicket),
        extra: options.extra ?? null,
        ball_index: nextLegalBalls,
        created_by: session.user.id,
      }),
      supabase
        .from("matches")
        .update({
          runs: activeMatch.runs + runValue,
          wickets: nextWickets,
          legal_balls: nextLegalBalls,
          status: "live",
        })
        .eq("id", activeMatch.id),
    ]);
    setBusy(false);

    if (deliveryError || matchError) {
      setNotice(deliveryError?.message ?? matchError?.message ?? "Unable to update score.");
      return;
    }

    await Promise.all([loadMatches(), loadDeliveries(activeMatch.id)]);
  }

  async function resetScore() {
    if (!activeMatch || !isAdmin) {
      return;
    }

    setBusy(true);
    const [{ error: deleteError }, { error: matchError }] = await Promise.all([
      supabase.from("deliveries").delete().eq("match_id", activeMatch.id),
      supabase
        .from("matches")
        .update({ runs: 0, wickets: 0, legal_balls: 0, status: "setup" })
        .eq("id", activeMatch.id),
    ]);
    setBusy(false);

    if (deleteError || matchError) {
      setNotice(deleteError?.message ?? matchError?.message ?? "Unable to reset score.");
      return;
    }

    await Promise.all([loadMatches(), loadDeliveries(activeMatch.id)]);
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
    });

    if (error) {
      setNotice(error.message);
      return;
    }

    await loadMatchPlayers(activeMatch.id);
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
      setNotice(error instanceof Error ? error.message : "Unable to save pending profile photo.");
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
      setNotice(error instanceof Error ? error.message : "Unable to update profile photo.");
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
            <span>{activeMatch ? `${getOvers(activeMatch.legal_balls)} ov` : "0.0 ov"}</span>
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

          {tab === "scoreboard" && (
            <ScoreboardView
              match={activeMatch}
              deliveries={deliveries}
              matches={matches}
              onSelectMatch={setActiveMatchId}
            />
          )}

          {tab === "players" && (
            <PlayerView
              profile={profile}
              role={role}
              match={activeMatch}
              deliveries={deliveries}
              busy={busy}
              onAvatarChange={updateOwnAvatar}
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
              onRefresh={() => {
                void loadPlayerProfiles(isAdmin);
                if (activeMatch?.id) {
                  void loadMatchPlayers(activeMatch.id);
                }
              }}
            />
          )}

          {tab === "admin" && isAdmin && (
            <AdminView
              busy={busy}
              match={activeMatch}
              profiles={profiles}
              roles={roles}
              currentUserId={session.user.id}
              onCreateMatch={createMatch}
              onScore={scoreDelivery}
              onReset={resetScore}
              onStatus={updateMatchStatus}
              onUpdatePlayer={updatePlayer}
              onUpdateRole={updateRole}
              onRefreshPlayers={loadAdminLists}
            />
          )}
        </div>

        <nav className="bottom-nav sticky-bottom" aria-label="Primary">
          <NavButton
            icon={<Trophy size={22} />}
            label="Score"
            active={tab === "scoreboard"}
            onClick={() => setTab("scoreboard")}
          />
          <NavButton
            icon={<Users size={22} />}
            label="Players"
            active={tab === "players"}
            onClick={() => setTab("players")}
          />
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
              icon={<Shield size={22} />}
              label="Admin"
              active={tab === "admin"}
              onClick={() => setTab("admin")}
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
  onSelectMatch,
}: {
  match: Match | null;
  deliveries: Delivery[];
  matches: Match[];
  onSelectMatch: (id: string) => void;
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

  return (
    <section className="stack">
      <div className="score-hero">
        <span>
          {match.batting_team} vs {match.bowling_team}
        </span>
        <strong>
          {match.runs}/{match.wickets}
        </strong>
        <small>
          {getOvers(match.legal_balls)} overs · {match.status}
        </small>
      </div>

      <div className="crease-grid">
        <PlayerStat label="Striker" value={match.striker_name ?? "Set by admin"} highlight />
        <PlayerStat label="Non-striker" value={match.non_striker_name ?? "Set by admin"} />
        <PlayerStat label="Bowler" value={match.bowler_name ?? "Set by admin"} />
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>Recent balls</h3>
          <span>{deliveries.length} shown</span>
        </div>
        <BallStrip deliveries={deliveries} />
      </section>

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
                <small>{formatDate(item.created_at)}</small>
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

function PlayerView({
  profile,
  role,
  match,
  deliveries,
  busy,
  onAvatarChange,
  onRefresh,
}: {
  profile: Profile | null;
  role: AppRole;
  match: Match | null;
  deliveries: Delivery[];
  busy: boolean;
  onAvatarChange: (file: File) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="stack">
      <div className="hero-card">
        <div>
          <p className="eyebrow">Player account</p>
          <h2>{profile?.display_name ?? "Cricket player"}</h2>
        </div>
        <ProfilePhoto profile={profile} size="large" />
      </div>

      <section className="panel profile-panel">
        <div className="panel-title">
          <h3>Your profile</h3>
          <span>{role}</span>
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
        <button className="secondary-action" onClick={onRefresh}>
          Refresh scoreboard
        </button>
      </section>

      <section className="panel stat-grid">
        <PlayerStat label="Current score" value={match ? `${match.runs}/${match.wickets}` : "No match"} />
        <PlayerStat label="Overs" value={match ? getOvers(match.legal_balls) : "0.0"} />
        <PlayerStat label="Last ball" value={deliveries[0]?.label ?? "-"} />
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
  onRefresh,
}: {
  busy: boolean;
  match: Match | null;
  profiles: Profile[];
  matchPlayers: MatchPlayer[];
  teamKey: "a" | "b" | null;
  onAddPlayer: (profileId: string) => void;
  onRemovePlayer: (rowId: string) => void;
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
  const teamLabel = teamKey === "a" ? "Team A" : "Team B";
  const isFull = teamRows.length >= match.team_size;

  return (
    <section className="stack">
      <div className="hero-card">
        <div>
          <p className="eyebrow">Captain mode</p>
          <h2>{teamLabel}</h2>
        </div>
        <strong className="team-count">
          {teamRows.length}/{match.team_size}
        </strong>
      </div>

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
          Add to {teamLabel}
        </button>
      </form>

      <section className="panel">
        <div className="panel-title">
          <h3>{teamLabel} squad</h3>
          <span>{teamRows.length} picked</span>
        </div>
        <div className="team-player-list">
          {teamRows.map((row) => {
            const rowProfile = profiles.find((item) => item.id === row.profile_id) ?? null;
            return (
              <article className="team-player-row" key={row.id}>
                <ProfilePhoto profile={rowProfile} />
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
            );
          })}
          {teamRows.length === 0 && <p className="empty-note">No players picked yet.</p>}
        </div>
      </section>
    </section>
  );
}

function AdminView({
  busy,
  match,
  profiles,
  roles,
  currentUserId,
  onCreateMatch,
  onScore,
  onReset,
  onStatus,
  onUpdatePlayer,
  onUpdateRole,
  onRefreshPlayers,
}: {
  busy: boolean;
  match: Match | null;
  profiles: Profile[];
  roles: UserRole[];
  currentUserId: string;
  onCreateMatch: (formData: FormData) => void;
  onScore: (runs: number, options?: { extra?: ExtraType; wicket?: boolean }) => void;
  onReset: () => void;
  onStatus: (status: MatchStatus) => void;
  onUpdatePlayer: (profileId: string, values: Partial<Pick<Profile, "display_name" | "phone" | "skills">>) => void;
  onUpdateRole: (profileId: string, nextRole: AppRole) => void;
  onRefreshPlayers: () => void;
}) {
  const roleMap = new Map(roles.map((item) => [item.user_id, item.role]));

  return (
    <section className="stack">
      <form
        className="panel admin-form"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          onCreateMatch(new FormData(event.currentTarget));
        }}
      >
        <div className="panel-title">
          <h3>Create live match</h3>
          <span>Admin</span>
        </div>
        <input name="title" placeholder="Sunday Turf Match" />
        <input name="venue" placeholder="Local Turf" />
        <select name="teamSize" defaultValue="6">
          {TEAM_SIZES.map((size) => (
            <option value={size} key={size}>
              {size}v{size}
            </option>
          ))}
        </select>
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
        <div className="split-inputs">
          <input name="striker" placeholder="Striker" />
          <input name="nonStriker" placeholder="Non-striker" />
        </div>
        <input name="bowler" placeholder="Bowler" />
        <button className="primary-action" disabled={busy}>
          <Plus size={19} />
          Create match
        </button>
      </form>

      <section className="panel">
        <div className="panel-title">
          <h3>Live scoring</h3>
          <span>{match ? `${match.runs}/${match.wickets}` : "No match"}</span>
        </div>
        {match ? (
          <>
            <div className="run-grid">
              {[0, 1, 2, 3, 4, 6].map((run) => (
                <button key={run} disabled={busy} onClick={() => onScore(run)}>
                  {run}
                </button>
              ))}
            </div>
            <div className="extras-grid">
              <button disabled={busy} onClick={() => onScore(0, { extra: "WD" })}>
                Wide
              </button>
              <button disabled={busy} onClick={() => onScore(0, { extra: "NB" })}>
                No ball
              </button>
              <button disabled={busy} onClick={() => onScore(0, { extra: "B" })}>
                Bye
              </button>
              <button disabled={busy} onClick={() => onScore(0, { extra: "LB" })}>
                Leg bye
              </button>
              <button className="danger" disabled={busy} onClick={() => onScore(0, { wicket: true })}>
                Wicket
              </button>
            </div>
            <div className="dual-actions">
              <button className="secondary-action" disabled={busy} onClick={() => onStatus(match.status === "live" ? "completed" : "live")}>
                {match.status === "live" ? "Complete" : "Go live"}
              </button>
              <button className="secondary-action danger-soft" disabled={busy} onClick={onReset}>
                <RotateCcw size={18} />
                Reset
              </button>
            </div>
          </>
        ) : (
          <p className="empty-note">Create a match first.</p>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Manage players</h3>
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
