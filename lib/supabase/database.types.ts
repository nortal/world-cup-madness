export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: string
          actor_email: string | null
          actor_oid: string | null
          attempted_tid: string | null
          entity_id: string | null
          entity_type: string | null
          id: number
          new_value: Json | null
          occurred_at: string
          old_value: Json | null
          participant_id: string | null
          reason: string | null
        }
        Insert: {
          action: string
          actor_email?: string | null
          actor_oid?: string | null
          attempted_tid?: string | null
          entity_id?: string | null
          entity_type?: string | null
          id?: number
          new_value?: Json | null
          occurred_at?: string
          old_value?: Json | null
          participant_id?: string | null
          reason?: string | null
        }
        Update: {
          action?: string
          actor_email?: string | null
          actor_oid?: string | null
          attempted_tid?: string | null
          entity_id?: string | null
          entity_type?: string | null
          id?: number
          new_value?: Json | null
          occurred_at?: string
          old_value?: Json | null
          participant_id?: string | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      final_predictions: {
        Row: {
          best_player_player_id: string | null
          champion_team_id: string | null
          created_at: string
          id: string
          participant_id: string
          runner_up_team_id: string | null
          top_scorer_player_id: string | null
          updated_at: string
        }
        Insert: {
          best_player_player_id?: string | null
          champion_team_id?: string | null
          created_at?: string
          id?: string
          participant_id: string
          runner_up_team_id?: string | null
          top_scorer_player_id?: string | null
          updated_at?: string
        }
        Update: {
          best_player_player_id?: string | null
          champion_team_id?: string | null
          created_at?: string
          id?: string
          participant_id?: string
          runner_up_team_id?: string | null
          top_scorer_player_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "final_predictions_best_player_player_id_fkey"
            columns: ["best_player_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "final_predictions_champion_team_id_fkey"
            columns: ["champion_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "final_predictions_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: true
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "final_predictions_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: true
            referencedRelation: "participants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "final_predictions_runner_up_team_id_fkey"
            columns: ["runner_up_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "final_predictions_top_scorer_player_id_fkey"
            columns: ["top_scorer_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_runs: {
        Row: {
          action: string
          error_message: string | null
          finished_at: string | null
          id: number
          provider: string
          records_processed: number
          records_unchanged: number
          started_at: string
          status: string
        }
        Insert: {
          action: string
          error_message?: string | null
          finished_at?: string | null
          id?: number
          provider: string
          records_processed?: number
          records_unchanged?: number
          started_at?: string
          status: string
        }
        Update: {
          action?: string
          error_message?: string | null
          finished_at?: string | null
          id?: number
          provider?: string
          records_processed?: number
          records_unchanged?: number
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      matches: {
        Row: {
          away_team_id: string
          created_at: string
          group_label: string | null
          home_team_id: string
          id: string
          kickoff_utc: string | null
          last_synced_at: string
          provider_id: number
          score_away: number | null
          score_home: number | null
          stage: string
          status: string
          venue: string | null
        }
        Insert: {
          away_team_id: string
          created_at?: string
          group_label?: string | null
          home_team_id: string
          id?: string
          kickoff_utc?: string | null
          last_synced_at?: string
          provider_id: number
          score_away?: number | null
          score_home?: number | null
          stage: string
          status: string
          venue?: string | null
        }
        Update: {
          away_team_id?: string
          created_at?: string
          group_label?: string | null
          home_team_id?: string
          id?: string
          kickoff_utc?: string | null
          last_synced_at?: string
          provider_id?: number
          score_away?: number | null
          score_home?: number | null
          stage?: string
          status?: string
          venue?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "matches_away_team_id_fkey"
            columns: ["away_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_home_team_id_fkey"
            columns: ["home_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      participants: {
        Row: {
          auth_user_id: string
          created_at: string
          display_name: string
          email: string
          id: string
          last_login_at: string | null
          oid: string
          role: string
          status: string
          timezone: string
          welcome_dismissed_at: string | null
        }
        Insert: {
          auth_user_id: string
          created_at?: string
          display_name: string
          email: string
          id?: string
          last_login_at?: string | null
          oid: string
          role?: string
          status?: string
          timezone?: string
          welcome_dismissed_at?: string | null
        }
        Update: {
          auth_user_id?: string
          created_at?: string
          display_name?: string
          email?: string
          id?: string
          last_login_at?: string | null
          oid?: string
          role?: string
          status?: string
          timezone?: string
          welcome_dismissed_at?: string | null
        }
        Relationships: []
      }
      players: {
        Row: {
          created_at: string
          id: string
          name: string
          position: string | null
          provider_player_id: number
          team_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          position?: string | null
          provider_player_id: number
          team_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          position?: string | null
          provider_player_id?: number
          team_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "players_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
        ]
      }
      predictions: {
        Row: {
          created_at: string
          id: string
          match_id: string
          participant_id: string
          predicted_away_score: number
          predicted_home_score: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          match_id: string
          participant_id: string
          predicted_away_score: number
          predicted_home_score: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          match_id?: string
          participant_id?: string
          predicted_away_score?: number
          predicted_home_score?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "predictions_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "predictions_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "predictions_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      score_events: {
        Row: {
          awarded_at: string
          id: string
          match_id: string | null
          participant_id: string
          points: number
          scoring_run_id: string | null
          source: Database["public"]["Enums"]["score_event_source"]
        }
        Insert: {
          awarded_at?: string
          id?: string
          match_id?: string | null
          participant_id: string
          points: number
          scoring_run_id?: string | null
          source: Database["public"]["Enums"]["score_event_source"]
        }
        Update: {
          awarded_at?: string
          id?: string
          match_id?: string | null
          participant_id?: string
          points?: number
          scoring_run_id?: string | null
          source?: Database["public"]["Enums"]["score_event_source"]
        }
        Relationships: [
          {
            foreignKeyName: "score_events_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_events_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_events_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: false
            referencedRelation: "participants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "score_events_scoring_run_id_fkey"
            columns: ["scoring_run_id"]
            isOneToOne: false
            referencedRelation: "scoring_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      scoring_runs: {
        Row: {
          action: Database["public"]["Enums"]["scoring_action"]
          affected_participants_count: number
          error_message: string | null
          finished_at: string | null
          id: string
          match_id: string | null
          started_at: string
          status: Database["public"]["Enums"]["scoring_status"]
        }
        Insert: {
          action: Database["public"]["Enums"]["scoring_action"]
          affected_participants_count?: number
          error_message?: string | null
          finished_at?: string | null
          id?: string
          match_id?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["scoring_status"]
        }
        Update: {
          action?: Database["public"]["Enums"]["scoring_action"]
          affected_participants_count?: number
          error_message?: string | null
          finished_at?: string | null
          id?: string
          match_id?: string | null
          started_at?: string
          status?: Database["public"]["Enums"]["scoring_status"]
        }
        Relationships: [
          {
            foreignKeyName: "scoring_runs_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          created_at: string
          id: string
          name: string
          provider_team_id: number
          tla: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          provider_team_id: number
          tla: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          provider_team_id?: number
          tla?: string
        }
        Relationships: []
      }
      tournament_config: {
        Row: {
          admin_oids: string[]
          best_player_player_id: string | null
          champion_team_id: string | null
          created_at: string
          id: number
          nortal_tenant_id: string
          runner_up_team_id: string | null
          top_scorer_player_id: string | null
          updated_at: string
        }
        Insert: {
          admin_oids?: string[]
          best_player_player_id?: string | null
          champion_team_id?: string | null
          created_at?: string
          id?: number
          nortal_tenant_id: string
          runner_up_team_id?: string | null
          top_scorer_player_id?: string | null
          updated_at?: string
        }
        Update: {
          admin_oids?: string[]
          best_player_player_id?: string | null
          champion_team_id?: string | null
          created_at?: string
          id?: number
          nortal_tenant_id?: string
          runner_up_team_id?: string | null
          top_scorer_player_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_config_best_player_player_id_fkey"
            columns: ["best_player_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_config_champion_team_id_fkey"
            columns: ["champion_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_config_runner_up_team_id_fkey"
            columns: ["runner_up_team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_config_top_scorer_player_id_fkey"
            columns: ["top_scorer_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      all_runs: {
        Row: {
          action: string | null
          affected_count: number | null
          error_message: string | null
          finished_at: string | null
          id: string | null
          match_id: string | null
          run_kind: string | null
          started_at: string | null
          status: string | null
        }
        Relationships: []
      }
      participants_public: {
        Row: {
          created_at: string | null
          display_name: string | null
          id: string | null
          last_login_at: string | null
          oid: string | null
          role: string | null
          status: string | null
        }
        Insert: {
          created_at?: string | null
          display_name?: string | null
          id?: string | null
          last_login_at?: string | null
          oid?: string | null
          role?: string | null
          status?: string | null
        }
        Update: {
          created_at?: string | null
          display_name?: string | null
          id?: string | null
          last_login_at?: string | null
          oid?: string | null
          role?: string | null
          status?: string | null
        }
        Relationships: []
      }
      pg_all_foreign_keys: {
        Row: {
          fk_columns: unknown[] | null
          fk_constraint_name: unknown
          fk_schema_name: unknown
          fk_table_name: unknown
          fk_table_oid: unknown
          is_deferrable: boolean | null
          is_deferred: boolean | null
          match_type: string | null
          on_delete: string | null
          on_update: string | null
          pk_columns: unknown[] | null
          pk_constraint_name: unknown
          pk_index_name: unknown
          pk_schema_name: unknown
          pk_table_name: unknown
          pk_table_oid: unknown
        }
        Relationships: []
      }
      tap_funky: {
        Row: {
          args: string | null
          is_definer: boolean | null
          is_strict: boolean | null
          is_visible: boolean | null
          kind: unknown
          langoid: unknown
          name: unknown
          oid: unknown
          owner: unknown
          returns: string | null
          returns_set: boolean | null
          schema: unknown
          volatility: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _cleanup: { Args: never; Returns: boolean }
      _contract_on: { Args: { "": string }; Returns: unknown }
      _currtest: { Args: never; Returns: number }
      _db_privs: { Args: never; Returns: unknown[] }
      _extensions: { Args: never; Returns: unknown[] }
      _get: { Args: { "": string }; Returns: number }
      _get_latest: { Args: { "": string }; Returns: number[] }
      _get_note: { Args: { "": string }; Returns: string }
      _is_verbose: { Args: never; Returns: boolean }
      _prokind: { Args: { p_oid: unknown }; Returns: unknown }
      _query: { Args: { "": string }; Returns: string }
      _refine_vol: { Args: { "": string }; Returns: string }
      _retval: { Args: { "": string }; Returns: string }
      _table_privs: { Args: never; Returns: unknown[] }
      _temptypes: { Args: { "": string }; Returns: string }
      _todo: { Args: never; Returns: string }
      calculate_final_points: {
        Args: { p_participant_id?: string }
        Returns: undefined
      }
      calculate_match_points: {
        Args: { p_match_id: string }
        Returns: undefined
      }
      col_is_null:
        | {
            Args: {
              column_name: unknown
              description?: string
              schema_name: unknown
              table_name: unknown
            }
            Returns: string
          }
        | {
            Args: {
              column_name: unknown
              description?: string
              table_name: unknown
            }
            Returns: string
          }
      col_not_null:
        | {
            Args: {
              column_name: unknown
              description?: string
              schema_name: unknown
              table_name: unknown
            }
            Returns: string
          }
        | {
            Args: {
              column_name: unknown
              description?: string
              table_name: unknown
            }
            Returns: string
          }
      diag:
        | {
            Args: { msg: unknown }
            Returns: {
              error: true
            } & "Could not choose the best candidate function between: public.diag(msg => text), public.diag(msg => anyelement). Try renaming the parameters or the function itself in the database so function overloading can be resolved"
          }
        | {
            Args: { msg: string }
            Returns: {
              error: true
            } & "Could not choose the best candidate function between: public.diag(msg => text), public.diag(msg => anyelement). Try renaming the parameters or the function itself in the database so function overloading can be resolved"
          }
      diag_test_name: { Args: { "": string }; Returns: string }
      dismiss_welcome: { Args: never; Returns: Json }
      do_tap:
        | { Args: never; Returns: string[] }
        | { Args: { "": string }; Returns: string[] }
      fail:
        | { Args: never; Returns: string }
        | { Args: { "": string }; Returns: string }
      findfuncs: { Args: { "": string }; Returns: string[] }
      finish: { Args: { exception_on_failure?: boolean }; Returns: string[] }
      format_type_string: { Args: { "": string }; Returns: string }
      has_unique: { Args: { "": string }; Returns: string }
      in_todo: { Args: never; Returns: boolean }
      is_admin_user: { Args: never; Returns: boolean }
      is_eligible_nortal_user: { Args: never; Returns: boolean }
      is_empty: { Args: { "": string }; Returns: string }
      isnt_empty: { Args: { "": string }; Returns: string }
      lives_ok: { Args: { "": string }; Returns: string }
      no_plan: { Args: never; Returns: boolean[] }
      num_failed: { Args: never; Returns: number }
      os_name: { Args: never; Returns: string }
      pass:
        | { Args: never; Returns: string }
        | { Args: { "": string }; Returns: string }
      pg_version: { Args: never; Returns: string }
      pg_version_num: { Args: never; Returns: number }
      pgtap_version: { Args: never; Returns: number }
      provision_participant_from_jwt: { Args: never; Returns: Json }
      recalculate_all_scores: { Args: never; Returns: Json }
      record_auth_failure: {
        Args: {
          p_action: string
          p_attempted_tid: string
          p_email: string
          p_oid: string
          p_reason: string
        }
        Returns: undefined
      }
      runtests:
        | { Args: never; Returns: string[] }
        | { Args: { "": string }; Returns: string[] }
      set_timezone: { Args: { p_timezone: string }; Returns: Json }
      set_tournament_winner: {
        Args: { p_id: string; p_item: string }
        Returns: Json
      }
      skip:
        | { Args: { "": string }; Returns: string }
        | { Args: { how_many: number; why: string }; Returns: string }
      submit_final_prediction: {
        Args: {
          p_best_player?: string
          p_champion?: string
          p_runner_up?: string
          p_top_scorer?: string
        }
        Returns: Json
      }
      submit_prediction: {
        Args: { p_away: number; p_home: number; p_match_id: string }
        Returns: Json
      }
      throws_ok: { Args: { "": string }; Returns: string }
      todo:
        | { Args: { how_many: number }; Returns: boolean[] }
        | { Args: { how_many: number; why: string }; Returns: boolean[] }
        | { Args: { why: string }; Returns: boolean[] }
        | { Args: { how_many: number; why: string }; Returns: boolean[] }
      todo_end: { Args: never; Returns: boolean[] }
      todo_start:
        | { Args: never; Returns: boolean[] }
        | { Args: { "": string }; Returns: boolean[] }
      trigger_match_sync: { Args: never; Returns: Json }
      update_display_name: { Args: { new_name: string }; Returns: Json }
      update_timezone: { Args: { p_timezone: string }; Returns: Json }
    }
    Enums: {
      score_event_source:
        | "match-exact"
        | "match-outcome"
        | "match-wrong"
        | "no-prediction"
        | "match-cancelled"
        | "final-champion"
        | "final-runner-up"
        | "final-top-scorer"
        | "final-best-player"
        | "final-not-picked-champion"
        | "final-not-picked-runner-up"
        | "final-not-picked-top-scorer"
        | "final-not-picked-best-player"
      scoring_action:
        | "trigger-result-update"
        | "trigger-config-change"
        | "trigger-cascade"
        | "admin-recalc-all"
      scoring_status: "success" | "error" | "skipped"
    }
    CompositeTypes: {
      _time_trial_type: {
        a_time: number | null
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      score_event_source: [
        "match-exact",
        "match-outcome",
        "match-wrong",
        "no-prediction",
        "match-cancelled",
        "final-champion",
        "final-runner-up",
        "final-top-scorer",
        "final-best-player",
        "final-not-picked-champion",
        "final-not-picked-runner-up",
        "final-not-picked-top-scorer",
        "final-not-picked-best-player",
      ],
      scoring_action: [
        "trigger-result-update",
        "trigger-config-change",
        "trigger-cascade",
        "admin-recalc-all",
      ],
      scoring_status: ["success", "error", "skipped"],
    },
  },
} as const

