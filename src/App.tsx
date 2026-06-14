import {
  Activity,
  Camera,
  ClipboardList,
  LogOut,
  Mail,
  Plus,
  RotateCcw,
  Shield,
  Swords,
  Trophy,
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import type { AppRole, Delivery, Match, MatchStatus, Profile, UserRole } from "./lib/database.types";

type Tab = "scoreboard" | "players" | "admin";
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
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session?.user, activeMatch?.id]);

  useEffect(() => {
    if (activeMatch?.id) {
      void loadDeliveries(activeMatch.id);
    }
  }, [activeMatch?.id]);

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

      await loadMatches();
      if (roleData?.role === "admin") {
        await loadAdminLists();
      }
    } finally {
      setBusy(false);
    }
  }

  async function loadMatches() {
    const { data, error } = await supabase.from("matches").select("*").order("created_at", { ascending: false });
    if (error) {
      setNotice(error.message);
      return;
    }

    setMatches(data ?? []);
    setActiveMatchId((current) => current ?? data?.[0]?.id ?? null);
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

  async function loadAdminLists() {
    const [{ data: profileRows, error: profileError }, { data: roleRows, error: roleError }] = await Promise.all([
      supabase.from("profiles").select("*").order("created_at", { ascending: false }),
      supabase.from("user_roles").select("*"),
    ]);

    if (profileError || roleError) {
      setNotice(profileError?.message ?? roleError?.message ?? "Unable to load players.");
      return;
    }

    setProfiles(profileRows ?? []);
    setRoles(roleRows ?? []);
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
    const striker = String(formData.get("striker") ?? "").trim();
    const nonStriker = String(formData.get("nonStriker") ?? "").trim();
    const bowler = String(formData.get("bowler") ?? "").trim();

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
    await loadMatches();
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

          {tab === "admin" && !isAdmin && (
            <section className="panel empty-state">
              <Shield size={34} />
              <h2>Admin access needed</h2>
              <p>Players can see the live scoreboard. Admin accounts can manage players and update running matches.</p>
            </section>
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
          <NavButton
            icon={<Shield size={22} />}
            label="Admin"
            active={tab === "admin"}
            onClick={() => setTab("admin")}
          />
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
          <button
            className="secondary-action"
            disabled={isSelf}
            onClick={() => onUpdateRole(profile.id, role === "admin" ? "player" : "admin")}
          >
            {role === "admin" ? "Make player" : "Make admin"}
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
