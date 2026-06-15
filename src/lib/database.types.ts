export type AppRole = "player" | "captain" | "umpire" | "admin";
export type MatchStatus = "setup" | "live" | "completed";
export type TeamKey = "a" | "b";
export type WinnerTeam = "a" | "b" | "tie";

export type Profile = {
  id: string;
  email: string;
  display_name: string;
  phone: string | null;
  skills: string[];
  avatar_url: string | null;
  avatar_path: string | null;
  is_banned: boolean;
  banned_at: string | null;
  banned_by: string | null;
  created_at: string;
  updated_at: string;
};

export type UserRole = {
  user_id: string;
  role: AppRole;
  created_at: string;
  updated_at: string;
};

export type CaptainTeam = {
  id: string;
  name: string;
  logo_url: string | null;
  logo_path: string | null;
  captain_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type Match = {
  id: string;
  title: string;
  venue: string;
  team_size: number;
  status: MatchStatus;
  batting_team: string;
  bowling_team: string;
  team_a_name: string;
  team_b_name: string;
  team_a_logo_url: string | null;
  team_b_logo_url: string | null;
  team_a_logo_path: string | null;
  team_b_logo_path: string | null;
  runs: number;
  wickets: number;
  legal_balls: number;
  striker_name: string | null;
  non_striker_name: string | null;
  bowler_name: string | null;
  captain_a_id: string | null;
  captain_b_id: string | null;
  created_by: string | null;
  total_overs: number;
  toss_winner: TeamKey;
  draft_turn: TeamKey;
  current_innings: number;
  first_batting_team: TeamKey;
  batting_team_key: TeamKey;
  target: number | null;
  innings1_runs: number;
  innings1_wickets: number;
  innings1_balls: number;
  striker_id: string | null;
  non_striker_id: string | null;
  bowler_id: string | null;
  winner_team: WinnerTeam | null;
  result_note: string | null;
  created_at: string;
  updated_at: string;
};

export type Delivery = {
  id: string;
  match_id: string;
  label: string;
  runs: number;
  legal: boolean;
  wicket: boolean;
  extra: "WD" | "NB" | "B" | "LB" | null;
  ball_index: number;
  innings: number;
  striker_id: string | null;
  non_striker_id: string | null;
  bowler_id: string | null;
  created_by: string | null;
  created_at: string;
};

export type MatchPlayer = {
  id: string;
  match_id: string;
  profile_id: string | null;
  display_name: string;
  team_key: "pool" | "a" | "b";
  is_captain: boolean;
  batting_order: number | null;
  skills: string[];
  avatar_url: string | null;
  runs_scored: number;
  balls_faced: number;
  fours: number;
  sixes: number;
  is_out: boolean;
  dismissal: string | null;
  balls_bowled: number;
  runs_conceded: number;
  wickets_taken: number;
  created_at: string;
};

export type PushSubscriptionRecord = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: string | null;
  user_agent: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
};

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Pick<Profile, "id" | "email" | "display_name"> & Partial<Omit<Profile, "id" | "email" | "display_name">>;
        Update: Partial<Profile>;
      };
      user_roles: {
        Row: UserRole;
        Insert: Pick<UserRole, "user_id"> & Partial<Omit<UserRole, "user_id">>;
        Update: Partial<UserRole>;
      };
      captain_teams: {
        Row: CaptainTeam;
        Insert: Pick<CaptainTeam, "name"> & Partial<Omit<CaptainTeam, "id" | "name" | "created_at" | "updated_at">>;
        Update: Partial<CaptainTeam>;
      };
      matches: {
        Row: Match;
        Insert: Partial<Omit<Match, "id" | "created_at" | "updated_at">>;
        Update: Partial<Match>;
      };
      deliveries: {
        Row: Delivery;
        Insert: Pick<Delivery, "match_id" | "label"> & Partial<Omit<Delivery, "id" | "match_id" | "label" | "created_at">>;
        Update: Partial<Delivery>;
      };
      match_players: {
        Row: MatchPlayer;
        Insert: Pick<MatchPlayer, "match_id" | "display_name"> & Partial<Omit<MatchPlayer, "id" | "match_id" | "display_name" | "created_at">>;
        Update: Partial<MatchPlayer>;
      };
      push_subscriptions: {
        Row: PushSubscriptionRecord;
        Insert: Pick<PushSubscriptionRecord, "user_id" | "endpoint" | "p256dh" | "auth"> &
          Partial<Omit<PushSubscriptionRecord, "id" | "user_id" | "endpoint" | "p256dh" | "auth" | "created_at" | "updated_at" | "last_seen_at">>;
        Update: Partial<PushSubscriptionRecord>;
      };
    };
    Enums: {
      app_role: AppRole;
      match_status: MatchStatus;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};
