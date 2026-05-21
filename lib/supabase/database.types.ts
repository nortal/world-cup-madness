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
          created_at: string
          id: number
          nortal_tenant_id: string
          updated_at: string
        }
        Insert: {
          admin_oids?: string[]
          created_at?: string
          id?: number
          nortal_tenant_id: string
          updated_at?: string
        }
        Update: {
          admin_oids?: string[]
          created_at?: string
          id?: number
          nortal_tenant_id?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
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
    }
    Functions: {
      acquire_match_sync_lock: { Args: never; Returns: boolean }
      dismiss_welcome: { Args: never; Returns: Json }
      is_admin_user: { Args: never; Returns: boolean }
      is_eligible_nortal_user: { Args: never; Returns: boolean }
      provision_participant_from_jwt: { Args: never; Returns: Json }
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
      set_timezone: { Args: { p_timezone: string }; Returns: Json }
      trigger_match_sync: { Args: never; Returns: Json }
      update_display_name: { Args: { new_name: string }; Returns: Json }
      update_timezone: { Args: { p_timezone: string }; Returns: Json }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
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
    Enums: {},
  },
} as const

