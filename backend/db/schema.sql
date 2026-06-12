--
-- PostgreSQL database dump
--

\restrict o0QcpOUPZtwBv0WZzTpPHerD6y9tlICxJfL3l9ehbtwm8uoZeospvrafEVHf17h

-- Dumped from database version 17.7 (Debian 17.7-3.pgdg13+1)
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: fn_sync_deal_stage_type(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_sync_deal_stage_type() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT stage_type INTO NEW.stage_type
  FROM pipeline_stages
  WHERE org_id = NEW.org_id
    AND pipeline = 'sales'
    AND key = NEW.stage
  LIMIT 1;
  RETURN NEW;
END;
$$;


--
-- Name: seed_sla_defaults(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.seed_sla_defaults(p_org_id integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO sla_tiers (org_id, name, description, response_target_hours, resolution_target_hours, sort_order)
  VALUES
    (p_org_id, 'Platinum', 'Enterprise / highest-touch accounts',          1,  8, 0),
    (p_org_id, 'Gold',     'Mid-market standard coverage',                 4, 24, 1),
    (p_org_id, 'Standard', 'Self-serve / SMB baseline',                    8, 48, 2)
  ON CONFLICT (org_id, name) DO NOTHING;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: trg_linkedin_profiles_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_linkedin_profiles_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;


--
-- Name: trg_straps_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_straps_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_entity_custom_fields_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_entity_custom_fields_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_hierarchy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_hierarchy (
    id integer NOT NULL,
    org_id integer NOT NULL,
    parent_account_id integer NOT NULL,
    child_account_id integer NOT NULL,
    relationship_type text DEFAULT 'subsidiary'::text NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_hierarchy_relationship_type_check CHECK ((relationship_type = ANY (ARRAY['subsidiary'::text, 'division'::text, 'partner'::text, 'acquired'::text])))
);


--
-- Name: account_hierarchy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.account_hierarchy_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_hierarchy_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.account_hierarchy_id_seq OWNED BY public.account_hierarchy.id;


--
-- Name: account_team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_team_members (
    id integer NOT NULL,
    org_id integer NOT NULL,
    account_team_id integer NOT NULL,
    contact_id integer,
    role character varying(50) DEFAULT 'member'::character varying NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_team_members_role_check CHECK (((role)::text = ANY ((ARRAY['lead'::character varying, 'member'::character varying, 'sponsor'::character varying, 'approver'::character varying, 'other'::character varying])::text[])))
);


--
-- Name: TABLE account_team_members; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.account_team_members IS 'Contacts belonging to a customer-side account team. contact_id is nullable to allow placeholder members before a contact record exists.';


--
-- Name: account_team_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.account_team_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_team_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.account_team_members_id_seq OWNED BY public.account_team_members.id;


--
-- Name: account_teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_teams (
    id integer NOT NULL,
    org_id integer NOT NULL,
    account_id integer NOT NULL,
    name character varying(150) NOT NULL,
    dimension character varying(50) DEFAULT 'custom'::character varying NOT NULL,
    parent_team_id integer,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE account_teams; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.account_teams IS 'Customer-side teams / buying groups / org units tied to an account. Dimension is a free key matching team_dimensions.key for grouping.';


--
-- Name: COLUMN account_teams.dimension; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.account_teams.dimension IS 'Soft reference to team_dimensions.key. Examples: executive, buying_group, project, geography, custom. Stored as plain text so dimension vocab can evolve without cascading FK updates.';


--
-- Name: account_teams_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.account_teams_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_teams_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.account_teams_id_seq OWNED BY public.account_teams.id;


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    domain character varying(255),
    industry character varying(100),
    size character varying(50),
    location character varying(255),
    description text,
    owner_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp without time zone,
    org_id integer NOT NULL,
    sla_tier_id integer,
    sla_tier_override boolean DEFAULT false NOT NULL,
    research_notes text,
    research_updated_at timestamp without time zone,
    research_meta jsonb DEFAULT '{}'::jsonb,
    account_disposition character varying(50),
    account_revisit_date date,
    client_id integer,
    external_refs jsonb DEFAULT '{}'::jsonb NOT NULL,
    needs_domain_review boolean DEFAULT false NOT NULL,
    linkedin_company_url character varying(500),
    CONSTRAINT chk_account_disposition CHECK (((account_disposition IS NULL) OR ((account_disposition)::text = ANY ((ARRAY['kill_account'::character varying, 'long_term_account'::character varying, 'unable_to_decide_account'::character varying])::text[]))))
);


--
-- Name: COLUMN accounts.research_notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.research_notes IS 'AI-generated account research (Stage 1). Cached and reused across all prospects at this account.';


--
-- Name: COLUMN accounts.research_updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.research_updated_at IS 'When research_notes was last regenerated. Used to determine cache staleness (default: 30 days).';


--
-- Name: COLUMN accounts.research_meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.accounts.research_meta IS 'Metadata about the AI generation: provider, model, prompt_id, prompt_source, generated_by_user_id, generated_at.';


--
-- Name: accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.accounts_id_seq OWNED BY public.accounts.id;


--
-- Name: action_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action_config (
    id integer NOT NULL,
    user_id integer NOT NULL,
    generation_mode text DEFAULT '["playbook","rules","ai"]'::text,
    ai_enhanced_generation boolean DEFAULT true,
    generate_on_stage_change boolean DEFAULT true,
    generate_on_meeting_scheduled boolean DEFAULT false,
    generate_on_email_next_steps boolean DEFAULT false,
    detection_mode character varying(50) DEFAULT 'hybrid'::character varying,
    confidence_threshold integer DEFAULT 70,
    auto_complete_threshold integer DEFAULT 95,
    enable_learning boolean DEFAULT true,
    detect_from_emails boolean DEFAULT true,
    detect_from_meetings boolean DEFAULT true,
    detect_from_documents boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    org_id integer NOT NULL,
    agentic_proposals_enabled boolean DEFAULT true,
    agentic_auto_approve_low_risk boolean DEFAULT false,
    agentic_notification_channel character varying(50) DEFAULT 'in_app'::character varying,
    ai_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_generated_at timestamp with time zone,
    CONSTRAINT action_config_auto_complete_threshold_check CHECK (((auto_complete_threshold >= 0) AND (auto_complete_threshold <= 100))),
    CONSTRAINT action_config_confidence_threshold_check CHECK (((confidence_threshold >= 0) AND (confidence_threshold <= 100))),
    CONSTRAINT action_config_detection_mode_check CHECK (((detection_mode)::text = ANY ((ARRAY['hybrid'::character varying, 'ai_only'::character varying, 'rules_only'::character varying, 'manual'::character varying])::text[])))
);


--
-- Name: TABLE action_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.action_config IS 'User configuration for action generation and completion detection';


--
-- Name: action_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.action_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: action_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.action_config_id_seq OWNED BY public.action_config.id;


--
-- Name: action_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action_suggestions (
    id integer NOT NULL,
    action_id integer NOT NULL,
    user_id integer NOT NULL,
    evidence_type character varying(50) NOT NULL,
    evidence_id integer NOT NULL,
    evidence_snippet text,
    confidence integer NOT NULL,
    reasoning text,
    detection_source character varying(50) DEFAULT 'hybrid'::character varying,
    status character varying(50) DEFAULT 'pending'::character varying,
    suggested_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    resolved_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    org_id integer NOT NULL,
    CONSTRAINT action_suggestions_confidence_check CHECK (((confidence >= 0) AND (confidence <= 100))),
    CONSTRAINT action_suggestions_detection_source_check CHECK (((detection_source)::text = ANY ((ARRAY['rules'::character varying, 'ai'::character varying, 'hybrid'::character varying])::text[]))),
    CONSTRAINT action_suggestions_evidence_type_check CHECK (((evidence_type)::text = ANY ((ARRAY['email'::character varying, 'meeting'::character varying, 'document'::character varying])::text[]))),
    CONSTRAINT action_suggestions_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'dismissed'::character varying, 'snoozed'::character varying])::text[])))
);


--
-- Name: TABLE action_suggestions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.action_suggestions IS 'AI/rule-based suggestions for completing actions based on emails/meetings';


--
-- Name: action_suggestions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.action_suggestions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: action_suggestions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.action_suggestions_id_seq OWNED BY public.action_suggestions.id;


--
-- Name: actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.actions (
    id integer NOT NULL,
    user_id integer,
    deal_id integer,
    contact_id integer,
    type character varying(50),
    priority character varying(20) DEFAULT 'medium'::character varying,
    title character varying(255) NOT NULL,
    description text,
    context text,
    due_date timestamp without time zone,
    completed boolean DEFAULT false,
    completed_at timestamp without time zone,
    source character varying(50) DEFAULT 'manual'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    source_id character varying(255),
    metadata jsonb,
    action_type character varying(50),
    suggested_action text,
    account_id integer,
    keywords text[],
    deal_stage character varying(50),
    auto_completed boolean DEFAULT false,
    completion_confidence integer,
    completion_evidence jsonb,
    pending_suggestions jsonb[],
    dismissed_suggestions jsonb[],
    requires_external_evidence boolean DEFAULT false,
    health_param character varying(10) DEFAULT NULL::character varying,
    source_rule character varying(80) DEFAULT NULL::character varying,
    status character varying DEFAULT 'yet_to_start'::character varying,
    is_internal boolean DEFAULT false,
    completed_by integer,
    next_step character varying,
    org_id integer NOT NULL,
    snoozed_until timestamp without time zone,
    snooze_reason text,
    snooze_duration character varying(50) DEFAULT NULL::character varying,
    strap_id integer,
    escalation_sent_at timestamp with time zone,
    notification_sent_at timestamp with time zone,
    contract_id integer,
    playbook_play_id integer,
    case_id integer,
    playbook_id integer,
    playbook_name character varying(255),
    source_module character varying(50),
    external_refs jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT actions_next_step_check CHECK (((next_step)::text = ANY ((ARRAY['email'::character varying, 'call'::character varying, 'whatsapp'::character varying, 'linkedin'::character varying, 'slack'::character varying, 'document'::character varying, 'internal_task'::character varying])::text[]))),
    CONSTRAINT actions_status_check CHECK (((status)::text = ANY ((ARRAY['yet_to_start'::character varying, 'in_progress'::character varying, 'completed'::character varying, 'snoozed'::character varying])::text[]))),
    CONSTRAINT chk_actions_source_module CHECK (((source_module IS NULL) OR ((source_module)::text = ANY ((ARRAY['deals'::character varying, 'prospecting'::character varying, 'contracts'::character varying, 'handovers'::character varying, 'service'::character varying, 'agency'::character varying, 'general'::character varying])::text[]))))
);


--
-- Name: COLUMN actions.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.actions.source IS 'Source of the action (e.g., outlook_email, manual, calendar)';


--
-- Name: COLUMN actions.source_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.actions.source_id IS 'ID from the source system (e.g., Outlook message ID)';


--
-- Name: COLUMN actions.action_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.actions.action_type IS 'Type of action: email_send, meeting_schedule, document_prep, task_complete, manual';


--
-- Name: COLUMN actions.keywords; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.actions.keywords IS 'Keywords used for matching completion evidence';


--
-- Name: COLUMN actions.completion_evidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.actions.completion_evidence IS 'JSON evidence of what triggered completion: {type: email/meeting, id: 123, snippet: "..."}';


--
-- Name: COLUMN actions.pending_suggestions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.actions.pending_suggestions IS 'Array of pending completion suggestions awaiting user review';


--
-- Name: COLUMN actions.contract_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.actions.contract_id IS 'FK to contracts. Set when this action was generated for or manually linked to a contract.';


--
-- Name: actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.actions_id_seq OWNED BY public.actions.id;


--
-- Name: agent_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_proposals (
    id integer NOT NULL,
    org_id integer NOT NULL,
    user_id integer NOT NULL,
    deal_id integer,
    contact_id integer,
    account_id integer,
    action_id integer,
    proposal_type character varying(50) NOT NULL,
    status character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    payload jsonb NOT NULL,
    original_payload jsonb,
    reasoning text,
    confidence numeric(3,2),
    source character varying(50) NOT NULL,
    source_context jsonb,
    execution_result jsonb,
    reviewed_by integer,
    reviewed_at timestamp without time zone,
    rejection_reason text,
    executed_at timestamp without time zone,
    error_message text,
    retry_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: agent_proposals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_proposals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_proposals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_proposals_id_seq OWNED BY public.agent_proposals.id;


--
-- Name: org_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_credentials (
    id bigint NOT NULL,
    org_id integer NOT NULL,
    user_id integer,
    provider text NOT NULL,
    label text,
    endpoint_url text,
    key_ciphertext bytea NOT NULL,
    key_iv bytea NOT NULL,
    key_tag bytea NOT NULL,
    key_last4 text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_used_at timestamp with time zone,
    last_validated_at timestamp with time zone,
    last_validation_error text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    purpose character varying(20) DEFAULT 'ai'::character varying NOT NULL,
    CONSTRAINT ai_credentials_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'invalid'::text]))),
    CONSTRAINT org_credentials_purpose_check CHECK (((purpose)::text = ANY ((ARRAY['ai'::character varying, 'enrichment'::character varying, 'email'::character varying, 'esign'::character varying, 'storage'::character varying])::text[])))
);


--
-- Name: ai_credentials_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_credentials_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_credentials_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_credentials_id_seq OWNED BY public.org_credentials.id;


--
-- Name: ai_processing_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_processing_log (
    id integer NOT NULL,
    user_id integer NOT NULL,
    source character varying(50) NOT NULL,
    source_id character varying(255) NOT NULL,
    prompt_tokens integer,
    completion_tokens integer,
    total_tokens integer,
    confidence_score numeric(3,2),
    actions_generated integer,
    success boolean DEFAULT true,
    error_message text,
    processing_time_ms integer,
    created_at timestamp without time zone DEFAULT now(),
    org_id integer NOT NULL
);


--
-- Name: ai_processing_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_processing_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_processing_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_processing_log_id_seq OWNED BY public.ai_processing_log.id;


--
-- Name: ai_token_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_token_usage (
    id integer NOT NULL,
    org_id integer NOT NULL,
    user_id integer NOT NULL,
    call_type character varying(50) NOT NULL,
    model character varying(100),
    prompt_tokens integer DEFAULT 0 NOT NULL,
    completion_tokens integer DEFAULT 0 NOT NULL,
    total_tokens integer DEFAULT 0 NOT NULL,
    deal_id integer,
    action_id integer,
    proposal_id integer,
    email_id integer,
    estimated_cost_usd numeric(10,6),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    key_source text,
    provider text,
    cache_read_tokens integer DEFAULT 0 NOT NULL,
    cache_creation_tokens integer DEFAULT 0 NOT NULL
);


--
-- Name: ai_token_usage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_token_usage_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_token_usage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_token_usage_id_seq OWNED BY public.ai_token_usage.id;


--
-- Name: calendar_sync_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_sync_history (
    id integer NOT NULL,
    user_id integer NOT NULL,
    sync_type character varying(50) DEFAULT 'calendar'::character varying,
    status character varying(50) DEFAULT 'in_progress'::character varying,
    items_processed integer DEFAULT 0,
    items_failed integer DEFAULT 0,
    error_message text,
    last_sync_date timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    org_id integer NOT NULL
);


--
-- Name: calendar_sync_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.calendar_sync_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: calendar_sync_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.calendar_sync_history_id_seq OWNED BY public.calendar_sync_history.id;


--
-- Name: calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calls (
    id integer NOT NULL,
    org_id integer NOT NULL,
    user_id integer NOT NULL,
    prospect_id integer,
    deal_id integer,
    account_id integer,
    contact_id integer,
    occurred_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    logged_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    direction character varying(16) DEFAULT 'outbound'::character varying NOT NULL,
    outcome character varying(32),
    duration_seconds integer,
    notes text,
    phone_used character varying(64),
    sequence_step_log_id integer,
    provider character varying(32),
    provider_call_id character varying(128),
    recording_url text,
    transcript_url text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    callback_requested_at timestamp with time zone,
    status character varying(32) DEFAULT 'logged'::character varying NOT NULL,
    CONSTRAINT calls_direction_chk CHECK (((direction)::text = ANY ((ARRAY['outbound'::character varying, 'inbound'::character varying])::text[]))),
    CONSTRAINT calls_status_chk CHECK (((status)::text = ANY ((ARRAY['logged'::character varying, 'initiated'::character varying, 'ringing'::character varying, 'in_progress'::character varying, 'completed'::character varying, 'no_answer'::character varying, 'failed'::character varying, 'busy'::character varying, 'canceled'::character varying])::text[])))
);


--
-- Name: calls_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.calls_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: calls_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.calls_id_seq OWNED BY public.calls.id;


--
-- Name: case_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_notes (
    id integer NOT NULL,
    org_id integer NOT NULL,
    case_id integer NOT NULL,
    author_id integer,
    body text NOT NULL,
    note_type character varying(30) DEFAULT 'comment'::character varying NOT NULL,
    is_internal boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT case_notes_note_type_check CHECK (((note_type)::text = ANY ((ARRAY['comment'::character varying, 'status_change'::character varying, 'assignment'::character varying, 'system'::character varying])::text[])))
);


--
-- Name: case_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_notes_id_seq OWNED BY public.case_notes.id;


--
-- Name: case_plays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_plays (
    id integer NOT NULL,
    org_id integer NOT NULL,
    case_id integer NOT NULL,
    play_id integer NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    assigned_to integer,
    assigned_role_id integer,
    due_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    title text,
    description text,
    channel text,
    priority text DEFAULT 'medium'::text,
    execution_type text DEFAULT 'parallel'::text NOT NULL,
    is_gate boolean DEFAULT false NOT NULL,
    due_date date,
    sort_order integer DEFAULT 0 NOT NULL,
    is_manual boolean DEFAULT false NOT NULL,
    action_id integer,
    stage_key text,
    CONSTRAINT case_plays_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'completed'::character varying, 'skipped'::character varying])::text[])))
);


--
-- Name: case_plays_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_plays_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_plays_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_plays_id_seq OWNED BY public.case_plays.id;


--
-- Name: case_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.case_status_history (
    id integer NOT NULL,
    org_id integer NOT NULL,
    case_id integer NOT NULL,
    from_status character varying(50),
    to_status character varying(50) NOT NULL,
    changed_by integer,
    note text,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: case_status_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.case_status_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: case_status_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.case_status_history_id_seq OWNED BY public.case_status_history.id;


--
-- Name: cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cases (
    id integer NOT NULL,
    org_id integer NOT NULL,
    case_number character varying(30),
    subject character varying(500) NOT NULL,
    description text,
    status character varying(50) DEFAULT 'open'::character varying NOT NULL,
    priority character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    account_id integer,
    contact_id integer,
    deal_id integer,
    sla_tier_id integer,
    assigned_team_id integer,
    assigned_to integer,
    created_by integer,
    playbook_id integer,
    response_due_at timestamp with time zone,
    resolution_due_at timestamp with time zone,
    first_responded_at timestamp with time zone,
    resolved_at timestamp with time zone,
    closed_at timestamp with time zone,
    response_breached boolean DEFAULT false NOT NULL,
    resolution_breached boolean DEFAULT false NOT NULL,
    tags text[],
    source character varying(50) DEFAULT 'manual'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    client_id integer,
    CONSTRAINT cases_priority_check CHECK (((priority)::text = ANY ((ARRAY['low'::character varying, 'medium'::character varying, 'high'::character varying, 'critical'::character varying])::text[]))),
    CONSTRAINT cases_source_check CHECK (((source)::text = ANY ((ARRAY['manual'::character varying, 'email'::character varying, 'portal'::character varying])::text[]))),
    CONSTRAINT cases_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'in_progress'::character varying, 'pending_customer'::character varying, 'resolved'::character varying, 'closed'::character varying])::text[])))
);


--
-- Name: cases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cases_id_seq OWNED BY public.cases.id;


--
-- Name: client_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_activities (
    id integer NOT NULL,
    client_id integer NOT NULL,
    org_id integer NOT NULL,
    user_id integer,
    activity_type character varying(100) NOT NULL,
    description text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: client_activities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_activities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_activities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_activities_id_seq OWNED BY public.client_activities.id;


--
-- Name: client_portal_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_portal_users (
    id integer NOT NULL,
    client_id integer NOT NULL,
    org_id integer NOT NULL,
    email character varying(255) NOT NULL,
    first_name character varying(100),
    last_name character varying(100),
    role character varying(50) DEFAULT 'client_viewer'::character varying NOT NULL,
    invite_token character varying(64),
    magic_token character varying(64),
    magic_token_expires_at timestamp with time zone,
    invited_at timestamp with time zone,
    accepted_at timestamp with time zone,
    last_login_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: client_portal_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_portal_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_portal_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_portal_users_id_seq OWNED BY public.client_portal_users.id;


--
-- Name: client_team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_team_members (
    id integer NOT NULL,
    client_id integer NOT NULL,
    user_id integer NOT NULL,
    role character varying(50) DEFAULT 'member'::character varying NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_by integer
);


--
-- Name: client_team_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.client_team_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: client_team_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.client_team_members_id_seq OWNED BY public.client_team_members.id;


--
-- Name: clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clients (
    id integer NOT NULL,
    org_id integer NOT NULL,
    account_id integer,
    name character varying(255) NOT NULL,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    service_start_date date,
    service_notes text,
    logo_url text,
    report_token character varying(64),
    portal_enabled boolean DEFAULT false NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone
);


--
-- Name: clients_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clients_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clients_id_seq OWNED BY public.clients.id;


--
-- Name: competitors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.competitors (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name character varying(255) NOT NULL,
    aliases jsonb DEFAULT '[]'::jsonb,
    website character varying(500),
    notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    org_id integer NOT NULL
);


--
-- Name: competitors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.competitors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: competitors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.competitors_id_seq OWNED BY public.competitors.id;


--
-- Name: contact_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_activities (
    id integer NOT NULL,
    contact_id integer,
    user_id integer,
    activity_type character varying(50) NOT NULL,
    description text,
    metadata jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: contact_activities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contact_activities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contact_activities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contact_activities_id_seq OWNED BY public.contact_activities.id;


--
-- Name: contact_dotted_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_dotted_lines (
    id integer NOT NULL,
    org_id integer NOT NULL,
    contact_id integer NOT NULL,
    dotted_manager_id integer NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contact_dotted_lines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contact_dotted_lines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contact_dotted_lines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contact_dotted_lines_id_seq OWNED BY public.contact_dotted_lines.id;


--
-- Name: contact_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_identities (
    id integer NOT NULL,
    org_id integer NOT NULL,
    canonical_contact_id integer,
    canonical_prospect_id integer,
    identity_type character varying(50) NOT NULL,
    identity_value character varying(500) NOT NULL,
    confidence numeric(3,2) DEFAULT 1.0 NOT NULL,
    status character varying(30) DEFAULT 'confirmed'::character varying NOT NULL,
    confirmed_by integer,
    confirmed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contact_identities_check CHECK (((canonical_contact_id IS NOT NULL) OR (canonical_prospect_id IS NOT NULL))),
    CONSTRAINT contact_identities_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT contact_identities_status_check CHECK (((status)::text = ANY ((ARRAY['confirmed'::character varying, 'pending_review'::character varying, 'rejected'::character varying])::text[])))
);


--
-- Name: contact_identities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contact_identities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contact_identities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contact_identities_id_seq OWNED BY public.contact_identities.id;


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id integer NOT NULL,
    account_id integer,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    email character varying(255),
    phone character varying(50),
    title character varying(255),
    role_type character varying(50),
    location character varying(255),
    linkedin_url character varying(500),
    engagement_level character varying(20) DEFAULT 'medium'::character varying,
    last_contact_date timestamp without time zone,
    notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp without time zone,
    user_id integer,
    org_id integer NOT NULL,
    email_snoozed boolean DEFAULT false,
    email_snoozed_at timestamp with time zone,
    email_snoozed_by integer,
    email_snooze_reason text,
    converted_from_prospect_id integer,
    reports_to_contact_id integer,
    org_chart_title text,
    org_chart_seniority smallint DEFAULT 0,
    reports_to_confidence character varying(20) DEFAULT 'confirmed'::character varying NOT NULL,
    external_refs jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT contacts_reports_to_confidence_check CHECK (((reports_to_confidence)::text = ANY ((ARRAY['confirmed'::character varying, 'best_guess'::character varying])::text[]))),
    CONSTRAINT contacts_role_type_check CHECK (((role_type)::text = ANY ((ARRAY['decision_maker'::character varying, 'champion'::character varying, 'influencer'::character varying, 'user'::character varying, 'economic_buyer'::character varying, 'executive'::character varying, 'legal'::character varying, 'procurement'::character varying, 'security'::character varying, 'it'::character varying])::text[])))
);


--
-- Name: contacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contacts_id_seq OWNED BY public.contacts.id;


--
-- Name: contract_approval_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_approval_config (
    id integer NOT NULL,
    org_id integer NOT NULL,
    contract_type character varying(50) DEFAULT '*'::character varying NOT NULL,
    value_threshold numeric(15,2),
    approver_role character varying(50) NOT NULL,
    approver_user_id integer,
    step_order integer DEFAULT 1 NOT NULL,
    is_required boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contract_approval_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contract_approval_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contract_approval_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contract_approval_config_id_seq OWNED BY public.contract_approval_config.id;


--
-- Name: contract_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_approvals (
    id integer NOT NULL,
    contract_id integer NOT NULL,
    org_id integer NOT NULL,
    step_order integer DEFAULT 1 NOT NULL,
    approver_user_id integer,
    approver_role character varying(50),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    decision_note text,
    decided_at timestamp with time zone,
    is_required boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contract_approvals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contract_approvals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contract_approvals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contract_approvals_id_seq OWNED BY public.contract_approvals.id;


--
-- Name: contract_document_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_document_versions (
    id integer NOT NULL,
    contract_id integer NOT NULL,
    org_id integer NOT NULL,
    document_url text NOT NULL,
    document_provider character varying(30),
    version_label character varying(20),
    version_type character varying(10),
    round_number integer DEFAULT 1 NOT NULL,
    comment text,
    uploaded_by integer NOT NULL,
    is_current boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    version_major integer DEFAULT 1,
    version_minor integer DEFAULT 0,
    is_superseded boolean DEFAULT false,
    upload_comment text,
    is_executed boolean DEFAULT false
);


--
-- Name: COLUMN contract_document_versions.version_major; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_document_versions.version_major IS 'Major version (1.0, 2.0): new customer-facing draft or significant revision';


--
-- Name: COLUMN contract_document_versions.version_minor; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_document_versions.version_minor IS 'Minor version (1.1, 1.2): internal iteration within the same major version';


--
-- Name: contract_document_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contract_document_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contract_document_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contract_document_versions_id_seq OWNED BY public.contract_document_versions.id;


--
-- Name: contract_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_events (
    id integer NOT NULL,
    contract_id integer NOT NULL,
    org_id integer NOT NULL,
    event_type character varying(60) NOT NULL,
    actor_id integer,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contract_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contract_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contract_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contract_events_id_seq OWNED BY public.contract_events.id;


--
-- Name: contract_play_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_play_instances (
    id integer NOT NULL,
    org_id integer NOT NULL,
    contract_id integer NOT NULL,
    play_id integer,
    stage_key text NOT NULL,
    title text NOT NULL,
    description text,
    channel text,
    priority text DEFAULT 'medium'::text,
    execution_type text DEFAULT 'parallel'::text NOT NULL,
    is_gate boolean DEFAULT false NOT NULL,
    due_date date,
    sort_order integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    is_manual boolean DEFAULT false NOT NULL,
    action_id integer,
    completed_at timestamp with time zone,
    completed_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contract_play_instances_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'completed'::text, 'skipped'::text])))
);


--
-- Name: contract_play_instances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contract_play_instances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contract_play_instances_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contract_play_instances_id_seq OWNED BY public.contract_play_instances.id;


--
-- Name: contract_plays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_plays (
    id integer NOT NULL,
    org_id integer NOT NULL,
    contract_id integer NOT NULL,
    playbook_id integer NOT NULL,
    play_id integer NOT NULL,
    stage_key character varying(100) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    assigned_to integer,
    due_at timestamp with time zone,
    completed_at timestamp with time zone,
    completed_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contract_plays_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'in_progress'::character varying, 'completed'::character varying, 'skipped'::character varying])::text[])))
);


--
-- Name: contract_plays_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contract_plays_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contract_plays_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contract_plays_id_seq OWNED BY public.contract_plays.id;


--
-- Name: contract_signatories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_signatories (
    id integer NOT NULL,
    contract_id integer NOT NULL,
    org_id integer NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    signatory_type character varying(20) DEFAULT 'external'::character varying NOT NULL,
    role character varying(50) DEFAULT 'signer'::character varying NOT NULL,
    signed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cc_recipients jsonb DEFAULT '[]'::jsonb
);


--
-- Name: COLUMN contract_signatories.cc_recipients; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contract_signatories.cc_recipients IS 'Array of {name, email} objects ΓÇö CC recipients on the e-signature request';


--
-- Name: contract_signatories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contract_signatories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contract_signatories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contract_signatories_id_seq OWNED BY public.contract_signatories.id;


--
-- Name: contract_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_templates (
    id integer NOT NULL,
    org_id integer NOT NULL,
    contract_type text NOT NULL,
    name text NOT NULL,
    description text,
    file_url text NOT NULL,
    file_name text NOT NULL,
    file_size integer,
    is_active boolean DEFAULT true,
    uploaded_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE contract_templates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.contract_templates IS 'Master contract templates per org. Managed via Org Admin ΓåÆ CLM ΓåÆ Templates.';


--
-- Name: contract_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contract_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contract_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contract_templates_id_seq OWNED BY public.contract_templates.id;


--
-- Name: contract_workflow_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contract_workflow_config (
    id integer NOT NULL,
    org_id integer NOT NULL,
    return_to_sales_mode character varying(20) DEFAULT 'manual'::character varying NOT NULL,
    signature_gate character varying(20) DEFAULT 'hard'::character varying NOT NULL,
    nda_requires_internal_approval boolean DEFAULT false NOT NULL,
    nda_resubmit_required boolean DEFAULT true NOT NULL,
    msa_resubmit_required boolean DEFAULT false NOT NULL,
    sow_resubmit_required boolean DEFAULT false NOT NULL,
    order_form_resubmit_required boolean DEFAULT false NOT NULL,
    amendment_resubmit_required boolean DEFAULT false NOT NULL,
    custom_resubmit_required boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contract_workflow_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contract_workflow_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contract_workflow_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contract_workflow_config_id_seq OWNED BY public.contract_workflow_config.id;


--
-- Name: contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contracts (
    id integer NOT NULL,
    org_id integer NOT NULL,
    deal_id integer,
    parent_contract_id integer,
    title character varying(255) NOT NULL,
    contract_type character varying(50) DEFAULT 'custom'::character varying NOT NULL,
    status character varying(50) DEFAULT 'draft'::character varying NOT NULL,
    legal_queue boolean DEFAULT true NOT NULL,
    legal_assignee_id integer,
    internal_approval_status character varying(20) DEFAULT 'not_started'::character varying NOT NULL,
    value numeric(15,2),
    currency character varying(10) DEFAULT 'USD'::character varying NOT NULL,
    customer_legal_name character varying(255),
    company_entity character varying(100),
    arr_impact boolean DEFAULT false NOT NULL,
    esign_provider character varying(30),
    esign_envelope_id character varying(255),
    esign_status character varying(50),
    document_url text,
    document_provider character varying(30),
    effective_date date,
    expiry_date date,
    owner_id integer NOT NULL,
    created_by integer NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    esign_request_id text,
    esign_credential_source text,
    include_full_dpa boolean DEFAULT false,
    termination_for_convenience boolean DEFAULT false,
    tfc_start_date date,
    tfc_end_date date,
    special_terms text,
    agreement_end_date date,
    amendment_subtype text,
    legal_owner_type text,
    customer_initiated_signing boolean DEFAULT false,
    executed_document_version_id integer,
    review_sub_status text,
    playbook_id integer,
    CONSTRAINT chk_contracts_review_sub_status CHECK (((review_sub_status IS NULL) OR (review_sub_status = ANY (ARRAY['with_legal'::text, 'with_sales'::text, 'with_customer'::text]))))
);


--
-- Name: COLUMN contracts.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.status IS 'State machine: draft | in_review | in_signatures | pending_booking | signed | active | expired | terminated | amended | cancelled | void(legacy)';


--
-- Name: COLUMN contracts.legal_assignee_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.legal_assignee_id IS 'FK to users.id ΓÇö named legal team member currently assigned. NULL = in queue.';


--
-- Name: COLUMN contracts.company_entity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.company_entity IS 'us | uk | de ΓÇö legal entity of the selling company';


--
-- Name: COLUMN contracts.legal_owner_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.legal_owner_type IS 'legal_queue | legal_person | sales | customer';


--
-- Name: COLUMN contracts.review_sub_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contracts.review_sub_status IS 'Only populated when status = in_review.
   with_legal: legal team has it (queue or named assignee).
   with_sales: returned to sales rep for changes or information.
   with_customer: current draft sent to customer for review; back-and-forth allowed.';


--
-- Name: contracts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contracts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contracts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contracts_id_seq OWNED BY public.contracts.id;


--
-- Name: conversation_starters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_starters (
    id integer NOT NULL,
    contact_id integer,
    text text NOT NULL,
    relevance_score numeric(3,2),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamp without time zone
);


--
-- Name: conversation_starters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.conversation_starters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: conversation_starters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.conversation_starters_id_seq OWNED BY public.conversation_starters.id;


--
-- Name: deal_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deal_activities (
    id integer NOT NULL,
    deal_id integer,
    user_id integer,
    activity_type character varying(50) NOT NULL,
    description text,
    metadata jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: deal_activities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deal_activities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deal_activities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deal_activities_id_seq OWNED BY public.deal_activities.id;


--
-- Name: deal_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deal_contacts (
    deal_id integer NOT NULL,
    contact_id integer NOT NULL,
    role character varying(50),
    is_primary boolean DEFAULT false
);


--
-- Name: deal_health_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deal_health_config (
    id integer NOT NULL,
    user_id integer NOT NULL,
    weight_close_date integer DEFAULT 20,
    weight_buyer_engagement integer DEFAULT 25,
    weight_process integer DEFAULT 15,
    weight_deal_size integer DEFAULT 10,
    weight_competitive integer DEFAULT 15,
    weight_momentum integer DEFAULT 15,
    param_weights jsonb DEFAULT '{"1c_buyer_event": 10, "5a_competitive": -20, "2b_exec_meeting": 15, "1b_close_slipped": -20, "3a_legal_engaged": 25, "4b_deal_expanded": 15, "6b_slow_response": -15, "2a_economic_buyer": 20, "2c_multi_threaded": 10, "4c_scope_approved": 20, "6a_no_meeting_14d": -25, "1a_close_confirmed": 15, "3b_security_review": 20, "4a_value_vs_segment": -15, "5c_discount_pending": -10, "5b_price_sensitivity": -15}'::jsonb,
    threshold_healthy integer DEFAULT 80,
    threshold_watch integer DEFAULT 50,
    exec_titles jsonb DEFAULT '["CEO", "CTO", "CFO", "COO", "CMO", "CRO", "VP", "SVP", "EVP", "President", "Director", "Managing Director", "Head of", "Chief"]'::jsonb,
    legal_titles jsonb DEFAULT '["Legal", "Counsel", "Attorney", "Contract", "Compliance", "General Counsel"]'::jsonb,
    procurement_titles jsonb DEFAULT '["Procurement", "Purchasing", "Vendor", "Supply Chain", "Sourcing", "Buyer"]'::jsonb,
    security_titles jsonb DEFAULT '["CISO", "Security", "InfoSec", "IT Director", "Information Technology", "Systems", "Infrastructure", "Network"]'::jsonb,
    segment_avg_smb integer DEFAULT 10000,
    segment_avg_midmarket integer DEFAULT 35000,
    segment_avg_enterprise integer DEFAULT 100000,
    segment_size_multiplier numeric(3,1) DEFAULT 2.0,
    no_meeting_days integer DEFAULT 14,
    response_time_multiplier numeric(3,1) DEFAULT 1.5,
    multi_thread_min_contacts integer DEFAULT 2,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    ai_enabled boolean DEFAULT true,
    ai_enabled_updated_at timestamp without time zone,
    params_enabled jsonb DEFAULT '{"1c_buyer_event": true, "5a_competitive": true, "2b_exec_meeting": true, "1b_close_slipped": true, "3a_legal_engaged": true, "4b_deal_expanded": true, "6b_slow_response": true, "2a_economic_buyer": true, "2c_multi_threaded": true, "4c_scope_approved": true, "6a_no_meeting_14d": true, "1a_close_confirmed": true, "3b_security_review": true, "4a_value_vs_segment": true, "5c_discount_pending": true, "5b_price_sensitivity": true}'::jsonb,
    org_id integer NOT NULL
);


--
-- Name: deal_health_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deal_health_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deal_health_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deal_health_config_id_seq OWNED BY public.deal_health_config.id;


--
-- Name: deal_play_assignees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deal_play_assignees (
    id integer NOT NULL,
    instance_id integer NOT NULL,
    user_id integer NOT NULL,
    role_id integer,
    assigned_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deal_play_assignees_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deal_play_assignees_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deal_play_assignees_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deal_play_assignees_id_seq OWNED BY public.deal_play_assignees.id;


--
-- Name: deal_play_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deal_play_instances (
    id integer NOT NULL,
    deal_id integer NOT NULL,
    org_id integer NOT NULL,
    play_id integer,
    stage_key text NOT NULL,
    title text NOT NULL,
    description text,
    channel text,
    priority text DEFAULT 'medium'::text,
    execution_type text DEFAULT 'parallel'::text NOT NULL,
    is_gate boolean DEFAULT false NOT NULL,
    due_date date,
    sort_order integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    is_manual boolean DEFAULT false NOT NULL,
    overridden_by integer,
    completed_at timestamp with time zone,
    completed_by integer,
    action_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    playbook_id integer
);


--
-- Name: deal_play_instances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deal_play_instances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deal_play_instances_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deal_play_instances_id_seq OWNED BY public.deal_play_instances.id;


--
-- Name: deal_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deal_products (
    id integer NOT NULL,
    org_id integer NOT NULL,
    deal_id integer NOT NULL,
    product_id integer,
    product_name character varying(200) NOT NULL,
    category_name character varying(120),
    quantity numeric(12,2) DEFAULT 1 NOT NULL,
    unit_price numeric(14,2) DEFAULT 0 NOT NULL,
    discount_pct numeric(5,2) DEFAULT 0 NOT NULL,
    total_value numeric(16,2) GENERATED ALWAYS AS (((quantity * unit_price) * ((1)::numeric - (discount_pct / (100)::numeric)))) STORED,
    contract_term integer,
    effective_date date,
    renewal_date date,
    revenue_type character varying(20) DEFAULT 'one_time'::character varying NOT NULL,
    notes text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    group_path text,
    CONSTRAINT deal_products_discount_pct_check CHECK (((discount_pct >= (0)::numeric) AND (discount_pct <= (100)::numeric))),
    CONSTRAINT deal_products_revenue_type_check CHECK (((revenue_type)::text = ANY ((ARRAY['one_time'::character varying, 'recurring'::character varying])::text[])))
);


--
-- Name: deal_products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deal_products_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deal_products_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deal_products_id_seq OWNED BY public.deal_products.id;


--
-- Name: org_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_roles (
    id integer NOT NULL,
    org_id integer NOT NULL,
    name text NOT NULL,
    key text NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deal_roles; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.deal_roles AS
 SELECT id,
    org_id,
    name,
    key,
    is_system,
    is_active,
    sort_order,
    created_at
   FROM public.org_roles;


--
-- Name: deal_team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deal_team_members (
    id integer NOT NULL,
    deal_id integer NOT NULL,
    org_id integer NOT NULL,
    user_id integer NOT NULL,
    role_id integer,
    custom_role text,
    added_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deal_team_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deal_team_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deal_team_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deal_team_members_id_seq OWNED BY public.deal_team_members.id;


--
-- Name: deal_value_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deal_value_history (
    id integer NOT NULL,
    deal_id integer NOT NULL,
    user_id integer NOT NULL,
    old_value numeric(12,2),
    new_value numeric(12,2),
    changed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: deal_value_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deal_value_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deal_value_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deal_value_history_id_seq OWNED BY public.deal_value_history.id;


--
-- Name: deals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deals (
    id integer NOT NULL,
    account_id integer,
    owner_id integer,
    name character varying(255) NOT NULL,
    value numeric(12,2) NOT NULL,
    stage character varying(50) NOT NULL,
    health character varying(20) DEFAULT 'healthy'::character varying,
    expected_close_date date,
    probability integer DEFAULT 50,
    notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    closed_at timestamp without time zone,
    close_date date,
    deleted_at timestamp without time zone,
    user_id integer,
    original_close_date date,
    close_date_push_count integer DEFAULT 0,
    external_crm_type character varying(50),
    external_crm_deal_id character varying(255),
    external_crm_close_date date,
    close_date_user_confirmed boolean DEFAULT false,
    close_date_user_confirmed_at timestamp without time zone,
    buyer_event_user_confirmed boolean DEFAULT false,
    buyer_event_description character varying(500),
    economic_buyer_contact_id integer,
    legal_engaged_user boolean DEFAULT false,
    legal_engaged_ai boolean DEFAULT false,
    legal_engaged_source text,
    security_review_user boolean DEFAULT false,
    security_review_ai boolean DEFAULT false,
    security_review_source text,
    scope_approved_user boolean DEFAULT false,
    scope_approved_ai boolean DEFAULT false,
    scope_approved_source text,
    discount_pending_user boolean DEFAULT false,
    discount_pending_ai boolean DEFAULT false,
    close_date_ai_confirmed boolean DEFAULT false,
    close_date_ai_source text,
    close_date_ai_confidence numeric(3,2),
    buyer_event_ai_confirmed boolean DEFAULT false,
    buyer_event_ai_source text,
    competitive_deal_ai boolean DEFAULT false,
    competitive_deal_user boolean DEFAULT false,
    competitive_competitors jsonb,
    price_sensitivity_ai boolean DEFAULT false,
    price_sensitivity_user boolean DEFAULT false,
    price_sensitivity_source text,
    health_score integer DEFAULT 100,
    health_score_breakdown jsonb,
    health_score_updated_at timestamp without time zone,
    org_id integer NOT NULL,
    playbook_id integer,
    signal_overrides jsonb DEFAULT '{}'::jsonb,
    stage_type character varying(50),
    stage_changed_at timestamp with time zone,
    handover_playbook_id integer,
    external_refs jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: deals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deals_id_seq OWNED BY public.deals.id;


--
-- Name: discovered_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discovered_models (
    id bigint NOT NULL,
    provider text NOT NULL,
    model_id text NOT NULL,
    raw jsonb,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: discovered_models_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.discovered_models_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: discovered_models_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.discovered_models_id_seq OWNED BY public.discovered_models.id;


--
-- Name: domain_health_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.domain_health_daily (
    id bigint NOT NULL,
    org_id integer NOT NULL,
    domain character varying(255) NOT NULL,
    metric_date date NOT NULL,
    source character varying(30) DEFAULT 'postmaster_v2'::character varying NOT NULL,
    spam_rate numeric(7,5),
    compliance_status character varying(30),
    auth_pass_rate numeric(7,5),
    delivery_errors jsonb,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE domain_health_daily; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.domain_health_daily IS 'Domain-level deliverability health. Created in Phase 2, populated in Phase 6 (Google Postmaster Tools v2 nightly pull; later DMARC rua). Insight-rule thresholds: spam_rate < 0.001 safe; >= 0.003 Gmail may reject. Sparse below ~200 Gmail-recipient sends/day (Google privacy suppression).';


--
-- Name: domain_health_daily_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.domain_health_daily_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: domain_health_daily_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.domain_health_daily_id_seq OWNED BY public.domain_health_daily.id;


--
-- Name: email_delivery_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_delivery_events (
    id bigint NOT NULL,
    org_id integer NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    provider character varying(20),
    ndr_external_id character varying(255),
    ndr_from character varying(255),
    failed_recipient character varying(255) NOT NULL,
    event_type character varying(20) NOT NULL,
    smtp_code character varying(20),
    diagnostic_excerpt text,
    prospect_id integer,
    step_log_id bigint,
    sender_account_id integer,
    campaign_id integer,
    enrollment_stopped boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_ede_event_type CHECK (((event_type)::text = ANY ((ARRAY['hard_bounce'::character varying, 'soft_bounce'::character varying, 'block'::character varying])::text[])))
);


--
-- Name: TABLE email_delivery_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.email_delivery_events IS 'Per-message bounce/block events parsed from NDR messages at inbox-sync Gate 1 by BounceDetectionService. The only per-message delivery signal available when sending via real Gmail/Outlook mailboxes. Feeds prospecting_metric_daily bounce measures and the OutboundInsightEngine deliverability causes. See docs/INSIGHTS_WBR_DESIGN.md Phase 2.';


--
-- Name: COLUMN email_delivery_events.event_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.email_delivery_events.event_type IS 'hard_bounce = permanent (5.1.x, user unknown) ΓåÆ list-quality cause, may auto-stop enrollment. soft_bounce = transient (4.x.x, mailbox full). block = policy/reputation rejection (5.7.x, spam/blocked) ΓåÆ sender-health cause.';


--
-- Name: email_delivery_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_delivery_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_delivery_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_delivery_events_id_seq OWNED BY public.email_delivery_events.id;


--
-- Name: email_engagement_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_engagement_events (
    id bigint NOT NULL,
    org_id integer NOT NULL,
    step_log_id bigint NOT NULL,
    prospect_id integer,
    event_type character varying(10) NOT NULL,
    url text,
    link_index integer,
    user_agent text,
    ip character varying(64),
    is_bot boolean DEFAULT false NOT NULL,
    bot_reason character varying(40),
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_eee_type CHECK (((event_type)::text = ANY ((ARRAY['open'::character varying, 'click'::character varying])::text[])))
);


--
-- Name: TABLE email_engagement_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.email_engagement_events IS 'Raw open/click events from the public tracking endpoints. Bot-classified events are flagged, never dropped (D41). Snapshot measures count is_bot=false only. Opens are DIRECTIONAL (Apple MPP auto-fires pixels, Gmail proxies images) ΓÇö labeled as such in the WBR grid.';


--
-- Name: email_engagement_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_engagement_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_engagement_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_engagement_events_id_seq OWNED BY public.email_engagement_events.id;


--
-- Name: email_filter_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_filter_log (
    id integer NOT NULL,
    org_id integer NOT NULL,
    user_id integer NOT NULL,
    sync_date timestamp with time zone DEFAULT now() NOT NULL,
    from_address character varying(255),
    to_address character varying(255),
    subject character varying(500),
    reason character varying(50),
    provider character varying(20),
    external_id character varying(255)
);


--
-- Name: email_filter_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_filter_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_filter_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_filter_log_id_seq OWNED BY public.email_filter_log.id;


--
-- Name: email_sync_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_sync_history (
    id integer NOT NULL,
    user_id integer NOT NULL,
    sync_type character varying(50) DEFAULT 'email'::character varying,
    status character varying(50),
    items_processed integer DEFAULT 0,
    items_failed integer DEFAULT 0,
    last_sync_date timestamp without time zone,
    error_message text,
    created_at timestamp without time zone DEFAULT now(),
    org_id integer NOT NULL
);


--
-- Name: TABLE email_sync_history; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.email_sync_history IS 'Tracks email synchronization history and status';


--
-- Name: email_sync_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_sync_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_sync_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_sync_history_id_seq OWNED BY public.email_sync_history.id;


--
-- Name: emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emails (
    id integer NOT NULL,
    user_id integer,
    deal_id integer,
    contact_id integer,
    direction character varying(10) NOT NULL,
    subject character varying(500),
    body text,
    to_address character varying(255),
    from_address character varying(255),
    cc_addresses text,
    sent_at timestamp without time zone,
    opened_at timestamp without time zone,
    clicked_at timestamp without time zone,
    replied_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp without time zone,
    external_id character varying(255),
    external_data jsonb,
    org_id integer NOT NULL,
    conversation_id character varying(500),
    tagged_by integer,
    tagged_at timestamp with time zone,
    tag_source text,
    prospect_id integer,
    provider character varying(20) DEFAULT 'outlook'::character varying,
    sender_account_id integer,
    CONSTRAINT emails_tag_source_check CHECK ((tag_source = ANY (ARRAY['auto'::text, 'manual'::text, 'team'::text])))
);


--
-- Name: COLUMN emails.external_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.emails.external_id IS 'Outlook message ID for deduplication';


--
-- Name: COLUMN emails.external_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.emails.external_data IS 'Additional Outlook metadata (conversationId, importance, etc.)';


--
-- Name: emails_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.emails_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: emails_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.emails_id_seq OWNED BY public.emails.id;


--
-- Name: enrichment_credit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrichment_credit_log (
    id integer NOT NULL,
    org_id integer NOT NULL,
    provider character varying(40) NOT NULL,
    purpose character varying(20) DEFAULT 'enrichment'::character varying NOT NULL,
    operation character varying(60) NOT NULL,
    credits_used integer DEFAULT 1 NOT NULL,
    prospect_id integer,
    account_id integer,
    status character varying(20) DEFAULT 'ok'::character varying NOT NULL,
    metadata jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: enrichment_credit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.enrichment_credit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: enrichment_credit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.enrichment_credit_log_id_seq OWNED BY public.enrichment_credit_log.id;


--
-- Name: entity_custom_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_custom_fields (
    id integer NOT NULL,
    org_id integer NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id integer NOT NULL,
    field_key character varying(100) NOT NULL,
    field_label character varying(200),
    field_type character varying(20) DEFAULT 'text'::character varying NOT NULL,
    value_text text,
    value_number numeric,
    value_date date,
    value_bool boolean,
    source character varying(50) DEFAULT 'manual'::character varying,
    crm_field_key character varying(200),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_custom_fields_entity_type_check CHECK (((entity_type)::text = ANY ((ARRAY['deal'::character varying, 'contact'::character varying, 'account'::character varying, 'prospect'::character varying])::text[]))),
    CONSTRAINT entity_custom_fields_field_type_check CHECK (((field_type)::text = ANY ((ARRAY['text'::character varying, 'number'::character varying, 'date'::character varying, 'boolean'::character varying, 'picklist'::character varying])::text[])))
);


--
-- Name: entity_custom_fields_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entity_custom_fields_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entity_custom_fields_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entity_custom_fields_id_seq OWNED BY public.entity_custom_fields.id;


--
-- Name: linkedin_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.linkedin_profiles (
    id integer NOT NULL,
    org_id integer NOT NULL,
    linkedin_slug character varying(255) NOT NULL,
    linkedin_url character varying(500) NOT NULL,
    full_name character varying(255),
    headline text,
    location character varying(255),
    about text,
    experience jsonb DEFAULT '[]'::jsonb NOT NULL,
    education jsonb DEFAULT '[]'::jsonb NOT NULL,
    activity jsonb DEFAULT '[]'::jsonb NOT NULL,
    source character varying(50) DEFAULT 'extension'::character varying NOT NULL,
    enrichment_meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_captured_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_basics_captured_at timestamp without time zone,
    last_about_captured_at timestamp without time zone,
    last_exp_captured_at timestamp without time zone,
    last_edu_captured_at timestamp without time zone,
    last_activity_captured_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp without time zone
);


--
-- Name: linkedin_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.linkedin_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: linkedin_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.linkedin_profiles_id_seq OWNED BY public.linkedin_profiles.id;


--
-- Name: meeting_attendees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_attendees (
    meeting_id integer NOT NULL,
    contact_id integer NOT NULL,
    attendance_status character varying(50) DEFAULT 'invited'::character varying,
    source character varying(20) DEFAULT 'calendar'::character varying NOT NULL,
    org_id integer,
    prospect_id integer,
    CONSTRAINT chk_meeting_attendees_has_person CHECK (((contact_id IS NOT NULL) OR (prospect_id IS NOT NULL))),
    CONSTRAINT chk_meeting_attendees_source CHECK (((source)::text = ANY ((ARRAY['calendar'::character varying, 'transcript'::character varying, 'manual'::character varying])::text[]))),
    CONSTRAINT chk_meeting_attendees_status CHECK (((attendance_status)::text = ANY ((ARRAY['invited'::character varying, 'attended'::character varying, 'no_show'::character varying, 'unknown'::character varying])::text[])))
);


--
-- Name: meeting_transcripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meeting_transcripts (
    id integer NOT NULL,
    user_id integer NOT NULL,
    meeting_id integer,
    deal_id integer,
    transcript_text text NOT NULL,
    source character varying(50) DEFAULT 'manual_upload'::character varying,
    analysis_status character varying(50) DEFAULT 'pending'::character varying,
    analysis_result jsonb,
    meeting_date timestamp without time zone,
    duration_minutes integer,
    attendees jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    org_id integer NOT NULL
);


--
-- Name: TABLE meeting_transcripts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.meeting_transcripts IS 'Stores meeting transcripts and AI analysis results';


--
-- Name: COLUMN meeting_transcripts.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.meeting_transcripts.source IS 'Source of transcript: manual_upload, zoom, teams, google_meet';


--
-- Name: COLUMN meeting_transcripts.analysis_result; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.meeting_transcripts.analysis_result IS 'JSON containing AI-extracted insights, action items, concerns, commitments';


--
-- Name: meeting_transcripts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.meeting_transcripts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: meeting_transcripts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.meeting_transcripts_id_seq OWNED BY public.meeting_transcripts.id;


--
-- Name: meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meetings (
    id integer NOT NULL,
    deal_id integer,
    user_id integer,
    title character varying(255) NOT NULL,
    description text,
    meeting_type character varying(50),
    start_time timestamp without time zone NOT NULL,
    end_time timestamp without time zone NOT NULL,
    location character varying(255),
    status character varying(50) DEFAULT 'scheduled'::character varying,
    prep_doc text,
    notes text,
    recording_url character varying(500),
    transcript text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp without time zone,
    external_id character varying(500),
    source character varying(50) DEFAULT 'manual'::character varying,
    external_data jsonb,
    transcript_id integer,
    org_id integer NOT NULL,
    action_id integer,
    prospect_id integer,
    account_id integer,
    handover_id integer
);


--
-- Name: COLUMN meetings.external_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.meetings.external_id IS 'Outlook/Google Calendar event ID';


--
-- Name: COLUMN meetings.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.meetings.source IS 'Source of meeting: manual, outlook, google';


--
-- Name: COLUMN meetings.external_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.meetings.external_data IS 'Raw calendar provider data (JSON)';


--
-- Name: meetings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.meetings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: meetings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.meetings_id_seq OWNED BY public.meetings.id;


--
-- Name: merged_contacts_archive; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.merged_contacts_archive (
    id integer NOT NULL,
    original_id integer NOT NULL,
    merged_into_id integer NOT NULL,
    org_id integer NOT NULL,
    contact_data jsonb NOT NULL,
    merged_by integer,
    field_overrides jsonb DEFAULT '{}'::jsonb,
    merged_at timestamp with time zone DEFAULT now()
);


--
-- Name: merged_contacts_archive_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.merged_contacts_archive_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: merged_contacts_archive_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.merged_contacts_archive_id_seq OWNED BY public.merged_contacts_archive.id;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id integer NOT NULL,
    org_id integer NOT NULL,
    user_id integer NOT NULL,
    type character varying(50) NOT NULL,
    title text NOT NULL,
    body text,
    entity_type character varying(50),
    entity_id integer,
    metadata jsonb DEFAULT '{}'::jsonb,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: oauth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_tokens (
    id integer NOT NULL,
    user_id integer NOT NULL,
    provider character varying(50) NOT NULL,
    access_token text NOT NULL,
    refresh_token text,
    expires_at timestamp without time zone,
    account_data jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    org_id integer NOT NULL,
    webhook_config jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: TABLE oauth_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.oauth_tokens IS 'Stores OAuth tokens for external services like Outlook';


--
-- Name: oauth_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.oauth_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: oauth_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.oauth_tokens_id_seq OWNED BY public.oauth_tokens.id;


--
-- Name: org_action_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_action_config (
    id integer NOT NULL,
    org_id integer NOT NULL,
    ai_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_by integer,
    call_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    enrichment jsonb DEFAULT '{}'::jsonb NOT NULL,
    campaign_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    prospecting_escalation jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: TABLE org_action_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.org_action_config IS 'Org-level AI defaults for the action system. Users override per-field in action_config.ai_settings.';


--
-- Name: COLUMN org_action_config.ai_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.org_action_config.ai_settings IS 'Shape: { master_enabled, modules: { deals, straps, clm, prospecting },
            generation_mode: ["playbook","rules","ai"],
            ai_provider: "anthropic"|"openai"|"gemini",
            default_model: string }';


--
-- Name: org_action_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.org_action_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: org_action_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.org_action_config_id_seq OWNED BY public.org_action_config.id;


--
-- Name: org_hierarchy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_hierarchy (
    id integer NOT NULL,
    org_id integer NOT NULL,
    user_id integer NOT NULL,
    reports_to integer,
    hierarchy_role character varying(50) DEFAULT 'rep'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    relationship_type character varying(10) DEFAULT 'solid'::character varying,
    CONSTRAINT chk_no_self_report CHECK ((user_id <> reports_to))
);


--
-- Name: org_hierarchy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.org_hierarchy_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: org_hierarchy_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.org_hierarchy_id_seq OWNED BY public.org_hierarchy.id;


--
-- Name: org_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_integrations (
    id integer NOT NULL,
    org_id integer NOT NULL,
    integration_type character varying(50) NOT NULL,
    credentials jsonb DEFAULT '{}'::jsonb NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    last_synced_at timestamp without time zone,
    error_message text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    instance_url character varying(500),
    connected_by integer,
    connected_at timestamp with time zone,
    sync_status character varying(50) DEFAULT 'idle'::character varying NOT NULL,
    last_sync_at timestamp with time zone,
    last_sync_error text,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    provider character varying(50)
);


--
-- Name: TABLE org_integrations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.org_integrations IS 'Per-org OAuth tokens and integration config. Replaces per-user oauth_tokens for org-level integrations.';


--
-- Name: COLUMN org_integrations.credentials; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.org_integrations.credentials IS 'Encrypt access_token and refresh_token at app layer before storing. Never log this column.';


--
-- Name: org_integrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.org_integrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: org_integrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.org_integrations_id_seq OWNED BY public.org_integrations.id;


--
-- Name: org_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_invitations (
    id integer NOT NULL,
    org_id integer NOT NULL,
    email character varying(255) NOT NULL,
    role character varying(50) DEFAULT 'member'::character varying NOT NULL,
    token character varying(255) NOT NULL,
    invited_by integer,
    accepted_at timestamp without time zone,
    expires_at timestamp without time zone DEFAULT (CURRENT_TIMESTAMP + '7 days'::interval) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    message text
);


--
-- Name: org_invitations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.org_invitations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: org_invitations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.org_invitations_id_seq OWNED BY public.org_invitations.id;


--
-- Name: org_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_invites (
    id integer NOT NULL,
    org_id integer NOT NULL,
    email character varying(255) NOT NULL,
    role character varying(50) DEFAULT 'member'::character varying NOT NULL,
    token character varying(64) NOT NULL,
    invited_by integer,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: org_invites_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.org_invites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: org_invites_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.org_invites_id_seq OWNED BY public.org_invites.id;


--
-- Name: org_roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.org_roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: org_roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.org_roles_id_seq OWNED BY public.org_roles.id;


--
-- Name: org_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_users (
    org_id integer NOT NULL,
    user_id integer NOT NULL,
    role character varying(50) DEFAULT 'member'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    invited_by integer,
    joined_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT org_users_role_check CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying, 'member'::character varying, 'viewer'::character varying])::text[])))
);


--
-- Name: TABLE org_users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.org_users IS 'Many-to-many: users can belong to multiple orgs. JWT scopes one org per session.';


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(100) NOT NULL,
    plan character varying(50) DEFAULT 'starter'::character varying NOT NULL,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    max_users integer DEFAULT 10 NOT NULL,
    notes text,
    suspended_at timestamp with time zone,
    suspended_by integer,
    CONSTRAINT organizations_plan_check CHECK (((plan)::text = ANY ((ARRAY['free'::character varying, 'starter'::character varying, 'pro'::character varying, 'enterprise'::character varying])::text[]))),
    CONSTRAINT organizations_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying, 'trial'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: TABLE organizations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.organizations IS 'Root tenant table. Every data row in the system belongs to one org.';


--
-- Name: COLUMN organizations.slug; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.slug IS 'URL-safe unique identifier, e.g. acme-corp';


--
-- Name: COLUMN organizations.settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.settings IS 'JSONB org-level config: branding, pipeline, action_types, ai, notifications, custom_fields, permissions';


--
-- Name: organizations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.organizations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: organizations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.organizations_id_seq OWNED BY public.organizations.id;


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id integer NOT NULL,
    user_id integer NOT NULL,
    token_hash character varying(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.password_reset_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: password_reset_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.password_reset_tokens_id_seq OWNED BY public.password_reset_tokens.id;


--
-- Name: pipeline_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pipeline_stages (
    id integer NOT NULL,
    org_id integer NOT NULL,
    pipeline character varying(100) NOT NULL,
    key character varying(100) NOT NULL,
    name character varying(255) NOT NULL,
    stage_type character varying(50) DEFAULT 'custom'::character varying,
    sort_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    is_terminal boolean DEFAULT false,
    is_system boolean DEFAULT false,
    color character varying(20),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: pipeline_stages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pipeline_stages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pipeline_stages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pipeline_stages_id_seq OWNED BY public.pipeline_stages.id;


--
-- Name: platform_esign_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_esign_tokens (
    provider text NOT NULL,
    access_token text,
    refresh_token text,
    token_expiry bigint,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: platform_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_settings (
    key character varying(100) NOT NULL,
    value jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: playbook_play_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbook_play_roles (
    id integer NOT NULL,
    play_id integer NOT NULL,
    role_id integer NOT NULL,
    ownership_type text DEFAULT 'co_owner'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: playbook_play_roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playbook_play_roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playbook_play_roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playbook_play_roles_id_seq OWNED BY public.playbook_play_roles.id;


--
-- Name: playbook_plays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbook_plays (
    id integer NOT NULL,
    playbook_id integer NOT NULL,
    org_id integer NOT NULL,
    stage_key text NOT NULL,
    title text NOT NULL,
    description text,
    channel text,
    template_id integer,
    sort_order integer DEFAULT 0 NOT NULL,
    execution_type text DEFAULT 'parallel'::text NOT NULL,
    depends_on integer[],
    is_gate boolean DEFAULT false NOT NULL,
    due_offset_days integer DEFAULT 3,
    priority text DEFAULT 'medium'::text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fire_conditions jsonb DEFAULT '[]'::jsonb NOT NULL,
    suggested_action text,
    unlocks_play_id integer,
    trigger_mode character varying(20) DEFAULT 'stage_change'::character varying NOT NULL,
    schedule_config jsonb,
    generation_mode character varying(20) DEFAULT 'template'::character varying NOT NULL,
    ai_config jsonb,
    version_number integer DEFAULT 1 NOT NULL,
    created_by integer,
    role_id integer,
    CONSTRAINT playbook_plays_generation_mode_check CHECK (((generation_mode)::text = ANY ((ARRAY['template'::character varying, 'ai'::character varying, 'hybrid'::character varying])::text[]))),
    CONSTRAINT playbook_plays_trigger_mode_check CHECK (((trigger_mode)::text = ANY ((ARRAY['on_demand'::character varying, 'stage_change'::character varying, 'scheduled'::character varying])::text[])))
);


--
-- Name: playbook_plays_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playbook_plays_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playbook_plays_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playbook_plays_id_seq OWNED BY public.playbook_plays.id;


--
-- Name: playbook_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbook_registrations (
    id integer NOT NULL,
    org_id integer NOT NULL,
    name character varying(255) NOT NULL,
    type character varying(50) NOT NULL,
    department character varying(100),
    owner_team_id integer,
    purpose text NOT NULL,
    entity_type character varying(50),
    trigger_mode character varying(20),
    conflict_rule character varying(30),
    eligibility_filter text,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    stage character varying(30) DEFAULT 'draft'::character varying NOT NULL,
    submitter_id integer NOT NULL,
    reviewer_id integer,
    submitted_at timestamp with time zone,
    approved_at timestamp with time zone,
    approved_by integer,
    rejected_at timestamp with time zone,
    rejection_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT playbook_registrations_conflict_rule_check CHECK (((conflict_rule)::text = ANY ((ARRAY['run_alongside'::character varying, 'override'::character varying, 'supplement'::character varying])::text[]))),
    CONSTRAINT playbook_registrations_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'submitted'::character varying, 'under_review'::character varying, 'changes_requested'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT playbook_registrations_trigger_mode_check CHECK (((trigger_mode)::text = ANY ((ARRAY['stage_change'::character varying, 'on_demand'::character varying, 'scheduled'::character varying])::text[])))
);


--
-- Name: playbook_registrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playbook_registrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playbook_registrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playbook_registrations_id_seq OWNED BY public.playbook_registrations.id;


--
-- Name: playbook_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbook_roles (
    id integer NOT NULL,
    playbook_id integer NOT NULL,
    role_id integer NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: playbook_roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playbook_roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playbook_roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playbook_roles_id_seq OWNED BY public.playbook_roles.id;


--
-- Name: playbook_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbook_stages (
    id integer NOT NULL,
    org_id integer NOT NULL,
    playbook_id integer NOT NULL,
    key character varying(100) NOT NULL,
    name character varying(255) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_terminal boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: playbook_stages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playbook_stages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playbook_stages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playbook_stages_id_seq OWNED BY public.playbook_stages.id;


--
-- Name: playbook_teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbook_teams (
    playbook_id integer NOT NULL,
    team_id integer NOT NULL,
    access_level character varying(10) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT playbook_teams_access_level_check CHECK (((access_level)::text = ANY ((ARRAY['owner'::character varying, 'reader'::character varying])::text[])))
);


--
-- Name: playbook_user_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbook_user_access (
    playbook_id integer NOT NULL,
    user_id integer NOT NULL,
    access_level character varying(10) NOT NULL,
    reason text,
    expires_at timestamp with time zone,
    set_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT playbook_user_access_access_level_check CHECK (((access_level)::text = ANY ((ARRAY['owner'::character varying, 'reader'::character varying, 'none'::character varying])::text[])))
);


--
-- Name: playbook_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbook_versions (
    id integer NOT NULL,
    playbook_id integer NOT NULL,
    version_number integer NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    created_by integer,
    approved_by integer,
    published_at timestamp with time zone,
    archived_at timestamp with time zone,
    change_summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT playbook_versions_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'under_review'::character varying, 'live'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: playbook_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playbook_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playbook_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playbook_versions_id_seq OWNED BY public.playbook_versions.id;


--
-- Name: playbooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbooks (
    id integer NOT NULL,
    org_id integer NOT NULL,
    name character varying(255) NOT NULL,
    type character varying(50) DEFAULT 'custom'::character varying NOT NULL,
    description text,
    is_default boolean DEFAULT false NOT NULL,
    content jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stage_guidance jsonb DEFAULT '{}'::jsonb NOT NULL,
    gate_enforcement text DEFAULT 'advisory'::text NOT NULL,
    entity_type character varying(50),
    enable_straps boolean DEFAULT false NOT NULL,
    enable_ai_actions boolean DEFAULT true NOT NULL,
    track_instances boolean DEFAULT true NOT NULL,
    action_table character varying(50) DEFAULT 'actions'::character varying NOT NULL,
    department character varying(100),
    trigger_mode character varying(20),
    conflict_rule character varying(30),
    eligibility_filter text,
    created_by integer,
    current_version_id integer,
    is_active boolean DEFAULT true NOT NULL,
    archived_at timestamp with time zone,
    archived_by integer,
    archive_reason text,
    replacement_pb_id integer,
    sunset_days integer DEFAULT 7 NOT NULL
);


--
-- Name: playbooks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.playbooks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: playbooks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.playbooks_id_seq OWNED BY public.playbooks.id;


--
-- Name: product_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_catalog (
    id integer NOT NULL,
    org_id integer NOT NULL,
    name character varying(200) NOT NULL,
    sku character varying(80),
    description text,
    product_type character varying(20) DEFAULT 'one_time'::character varying NOT NULL,
    billing_frequency character varying(20),
    fee_type character varying(20),
    list_price numeric(14,2) DEFAULT 0 NOT NULL,
    is_taxable boolean DEFAULT false NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    group_id integer,
    unit_label character varying(40) DEFAULT NULL::character varying,
    CONSTRAINT product_catalog_billing_frequency_check CHECK (((billing_frequency IS NULL) OR ((billing_frequency)::text = ANY ((ARRAY['monthly'::character varying, 'quarterly'::character varying, 'annual'::character varying, 'multi_year'::character varying])::text[])))),
    CONSTRAINT product_catalog_fee_type_check CHECK (((fee_type IS NULL) OR ((fee_type)::text = ANY ((ARRAY['setup'::character varying, 'license'::character varying, 'service'::character varying])::text[])))),
    CONSTRAINT product_catalog_product_type_check CHECK (((product_type)::text = ANY ((ARRAY['one_time'::character varying, 'recurring'::character varying])::text[]))),
    CONSTRAINT product_catalog_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'deprecated'::character varying, 'sunset'::character varying])::text[])))
);


--
-- Name: COLUMN product_catalog.unit_label; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.product_catalog.unit_label IS 'Display unit for quantity, e.g. seats, licenses, hours, GB, users, devices';


--
-- Name: product_catalog_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_catalog_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_catalog_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_catalog_id_seq OWNED BY public.product_catalog.id;


--
-- Name: product_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_groups (
    id integer NOT NULL,
    org_id integer NOT NULL,
    parent_id integer,
    name character varying(120) NOT NULL,
    description text,
    level_label character varying(60) DEFAULT 'Category'::character varying NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: product_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_groups_id_seq OWNED BY public.product_groups.id;


--
-- Name: prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompts (
    id integer NOT NULL,
    user_id integer,
    key character varying(100) NOT NULL,
    template text NOT NULL,
    is_system boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    org_id integer NOT NULL
);


--
-- Name: prompts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prompts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prompts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prompts_id_seq OWNED BY public.prompts.id;


--
-- Name: proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proposals (
    id integer NOT NULL,
    deal_id integer,
    user_id integer,
    version integer DEFAULT 1,
    status character varying(50) DEFAULT 'draft'::character varying,
    pricing_tier character varying(50),
    num_users integer,
    contract_length integer,
    annual_value numeric(12,2),
    implementation_fee numeric(12,2),
    discount_percent numeric(5,2) DEFAULT 0,
    total_value numeric(12,2),
    payment_terms character varying(50),
    sent_at timestamp without time zone,
    viewed_at timestamp without time zone,
    responded_at timestamp without time zone,
    notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    org_id integer NOT NULL
);


--
-- Name: proposals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.proposals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: proposals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.proposals_id_seq OWNED BY public.proposals.id;


--
-- Name: prospecting_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prospecting_actions (
    id integer NOT NULL,
    org_id integer NOT NULL,
    user_id integer,
    prospect_id integer NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    action_type character varying(50) NOT NULL,
    channel character varying(50),
    message_subject character varying(500),
    message_body text,
    message_metadata jsonb DEFAULT '{}'::jsonb,
    sequence_step integer,
    scheduled_at timestamp without time zone,
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    priority character varying(20) DEFAULT 'medium'::character varying,
    completed_at timestamp without time zone,
    completed_by integer,
    outcome character varying(100),
    source character varying(50) DEFAULT 'manual'::character varying,
    ai_context text,
    suggested_action text,
    due_date timestamp without time zone,
    snoozed_until timestamp without time zone,
    snooze_reason text,
    snooze_duration character varying(50),
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    strap_id integer,
    playbook_id integer,
    play_id integer,
    playbook_name character varying(255),
    source_rule character varying(80),
    notification_sent_at timestamp with time zone,
    escalated_at timestamp with time zone,
    escalation_tier smallint DEFAULT 0 NOT NULL,
    CONSTRAINT chk_paction_channel CHECK (((channel IS NULL) OR ((channel)::text = ANY ((ARRAY['email'::character varying, 'linkedin'::character varying, 'phone'::character varying, 'sms'::character varying, 'whatsapp'::character varying])::text[])))),
    CONSTRAINT chk_paction_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'in_progress'::character varying, 'completed'::character varying, 'skipped'::character varying, 'failed'::character varying, 'snoozed'::character varying])::text[])))
);


--
-- Name: prospecting_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prospecting_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prospecting_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prospecting_actions_id_seq OWNED BY public.prospecting_actions.id;


--
-- Name: prospecting_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prospecting_activities (
    id integer NOT NULL,
    prospect_id integer NOT NULL,
    user_id integer,
    activity_type character varying(50) NOT NULL,
    description text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    org_id integer NOT NULL
);


--
-- Name: prospecting_activities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prospecting_activities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prospecting_activities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prospecting_activities_id_seq OWNED BY public.prospecting_activities.id;


--
-- Name: prospecting_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prospecting_campaigns (
    id integer NOT NULL,
    org_id integer NOT NULL,
    name text NOT NULL,
    description text,
    solution text,
    playbook_id integer,
    default_sequence_id integer,
    status text DEFAULT 'active'::text NOT NULL,
    goal_qualified integer,
    start_date date,
    end_date date,
    owner_id integer NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    prospecting_config_override jsonb,
    daily_activation_cap integer,
    send_window_start_hour smallint,
    send_window_end_hour smallint,
    send_window_days smallint[],
    send_window_timezone text,
    start_mode text,
    pacing_mode text,
    cadence_minutes integer,
    send_window_start_minute smallint,
    share_weight integer,
    delete_locked boolean DEFAULT false NOT NULL,
    delete_locked_by integer,
    delete_locked_at timestamp with time zone,
    sender_account_ids integer[],
    tracking_opens boolean DEFAULT false NOT NULL,
    tracking_clicks boolean DEFAULT false NOT NULL,
    CONSTRAINT chk_daily_activation_cap CHECK (((daily_activation_cap IS NULL) OR (daily_activation_cap > 0))),
    CONSTRAINT chk_pc_cadence_minutes CHECK (((cadence_minutes IS NULL) OR ((cadence_minutes >= 1) AND (cadence_minutes <= 240)))),
    CONSTRAINT chk_pc_pacing_mode CHECK (((pacing_mode IS NULL) OR (pacing_mode = ANY (ARRAY['cadence'::text, 'spread'::text])))),
    CONSTRAINT chk_pc_share_weight CHECK (((share_weight IS NULL) OR ((share_weight >= 0) AND (share_weight <= 100)))),
    CONSTRAINT chk_pc_start_minute CHECK (((send_window_start_minute IS NULL) OR ((send_window_start_minute >= 0) AND (send_window_start_minute <= 59)))),
    CONSTRAINT chk_pc_start_mode CHECK (((start_mode IS NULL) OR (start_mode = ANY (ARRAY['on_activate'::text, 'fixed'::text, 'fixed_or_now'::text])))),
    CONSTRAINT chk_send_window_end_hour CHECK (((send_window_end_hour IS NULL) OR ((send_window_end_hour >= 0) AND (send_window_end_hour <= 24)))),
    CONSTRAINT chk_send_window_start_hour CHECK (((send_window_start_hour IS NULL) OR ((send_window_start_hour >= 0) AND (send_window_start_hour <= 23)))),
    CONSTRAINT prospecting_campaigns_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'completed'::text, 'archived'::text])))
);


--
-- Name: COLUMN prospecting_campaigns.tracking_clicks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prospecting_campaigns.tracking_clicks IS 'Per-campaign click-tracking toggle (Phase 7, default OFF). Written ONLY via PUT /api/tracking-domains/campaign/:id/toggles ΓÇö isolated from the config-override replace semantics.';


--
-- Name: prospecting_campaigns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prospecting_campaigns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prospecting_campaigns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prospecting_campaigns_id_seq OWNED BY public.prospecting_campaigns.id;


--
-- Name: prospecting_edit_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prospecting_edit_grants (
    id integer NOT NULL,
    org_id integer NOT NULL,
    owner_id integer NOT NULL,
    manager_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: prospecting_edit_grants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prospecting_edit_grants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prospecting_edit_grants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prospecting_edit_grants_id_seq OWNED BY public.prospecting_edit_grants.id;


--
-- Name: prospecting_insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prospecting_insights (
    id bigint NOT NULL,
    org_id integer NOT NULL,
    metric character varying(50) NOT NULL,
    cause_code character varying(40) NOT NULL,
    segment jsonb DEFAULT '{}'::jsonb NOT NULL,
    segment_hash character varying(32) NOT NULL,
    current_window_start date NOT NULL,
    current_window_end date NOT NULL,
    baseline_window_start date NOT NULL,
    baseline_window_end date NOT NULL,
    observed numeric NOT NULL,
    baseline numeric NOT NULL,
    observed_n integer DEFAULT 0 NOT NULL,
    baseline_n integer DEFAULT 0 NOT NULL,
    delta_rel numeric,
    headline text NOT NULL,
    hypothesis text,
    impact_estimate text,
    recommended_action text,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(20) DEFAULT 'new'::character varying NOT NULL,
    first_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    acknowledged_at timestamp with time zone,
    acknowledged_by integer,
    resolved_at timestamp with time zone,
    CONSTRAINT chk_pi_cause CHECK (((cause_code)::text = ANY ((ARRAY['list_targeting'::character varying, 'deliverability_sender'::character varying, 'deliverability_domain'::character varying, 'message_step'::character varying, 'timing_cadence'::character varying, 'rep_execution'::character varying, 'capacity_volume'::character varying, 'list_exhaustion'::character varying, 'mixed_confounded'::character varying])::text[]))),
    CONSTRAINT chk_pi_status CHECK (((status)::text = ANY ((ARRAY['new'::character varying, 'acknowledged'::character varying, 'resolved'::character varying])::text[])))
);


--
-- Name: TABLE prospecting_insights; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.prospecting_insights IS 'Aggregate diagnostic findings for the outbound motion, written nightly by OutboundInsightEngine from prospecting_metric_daily. Full lineage per row; evidence arrays are the drill-down. Upsert key (org_id, metric, cause_code, segment_hash); auto-resolves when the condition clears. See docs/INSIGHTS_WBR_DESIGN.md Phase 3.';


--
-- Name: COLUMN prospecting_insights.evidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prospecting_insights.evidence IS 'Drill-down payload: sampled raw-row IDs (step_log_ids, prospect_ids, delivery_event_ids ΓÇö capped at 50 each) plus the per-segment breakdown table shown at drill level 2. IDs are samples from the current window matching the segment, not exhaustive.';


--
-- Name: prospecting_insights_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prospecting_insights_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prospecting_insights_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prospecting_insights_id_seq OWNED BY public.prospecting_insights.id;


--
-- Name: prospecting_metric_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prospecting_metric_daily (
    id bigint NOT NULL,
    org_id integer NOT NULL,
    metric_date date NOT NULL,
    campaign_id integer DEFAULT 0 NOT NULL,
    sequence_id integer DEFAULT 0 NOT NULL,
    sequence_step_id integer DEFAULT 0 NOT NULL,
    channel character varying(50) DEFAULT 'none'::character varying NOT NULL,
    sender_account_id integer DEFAULT 0 NOT NULL,
    owner_id integer DEFAULT 0 NOT NULL,
    fit_band character varying(20) DEFAULT 'unknown'::character varying NOT NULL,
    enrolled integer DEFAULT 0 NOT NULL,
    sent integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    replied_steps integer DEFAULT 0 NOT NULL,
    replies integer DEFAULT 0 NOT NULL,
    ooo_replies integer DEFAULT 0 NOT NULL,
    connections_sent integer DEFAULT 0 NOT NULL,
    connections_accepted integer DEFAULT 0 NOT NULL,
    calls_logged integer DEFAULT 0 NOT NULL,
    meetings_booked integer DEFAULT 0 NOT NULL,
    qualified integer DEFAULT 0 NOT NULL,
    converted integer DEFAULT 0 NOT NULL,
    prospects_added integer DEFAULT 0 NOT NULL,
    tasks_overdue integer DEFAULT 0 NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    bounces_hard integer DEFAULT 0 NOT NULL,
    bounces_soft integer DEFAULT 0 NOT NULL,
    blocks integer DEFAULT 0 NOT NULL,
    opens integer DEFAULT 0 NOT NULL,
    clicks integer DEFAULT 0 NOT NULL
);


--
-- Name: TABLE prospecting_metric_daily; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.prospecting_metric_daily IS 'Daily-grain raw-count snapshot of the outbound motion. Written nightly by MetricSnapshotService (trailing 7 org-local days, DELETE+INSERT). Feeds WBR frames and OutboundInsightEngine. Rates are NEVER stored here ΓÇö always recomputed from summed counts. See docs/INSIGHTS_WBR_DESIGN.md.';


--
-- Name: COLUMN prospecting_metric_daily.metric_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prospecting_metric_daily.metric_date IS 'Org-local calendar date (org timezone from organizations.settings->calendar->>timezone), not UTC.';


--
-- Name: COLUMN prospecting_metric_daily.campaign_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prospecting_metric_daily.campaign_id IS '0 = unattributed (prospects.campaign_id IS NULL). Never NULL ΓÇö sentinel keeps the unique grain sound.';


--
-- Name: COLUMN prospecting_metric_daily.replied_steps; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prospecting_metric_daily.replied_steps IS 'Step logs whose status reached ''replied''. Subset of sent. team-overview parity: its "sent" = this table''s (sent - replied_steps); its "replied" = replied_steps.';


--
-- Name: COLUMN prospecting_metric_daily.replies; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prospecting_metric_daily.replies IS 'Replies counted on the date RECEIVED (period-based reply attribution, D18). Reply rate for a period = SUM(replies)/SUM(sent) over that period ΓÇö not a per-send cohort rate.';


--
-- Name: COLUMN prospecting_metric_daily.tasks_overdue; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prospecting_metric_daily.tasks_overdue IS 'Point-in-time gauge: open prospecting_actions past due as of the nightly run. Only written for the current org-local date; zero for historical dates.';


--
-- Name: COLUMN prospecting_metric_daily.bounces_hard; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prospecting_metric_daily.bounces_hard IS 'email_delivery_events hard_bounce, by detected date. Bounce rate for a period = SUM(bounces_hard + bounces_soft + blocks) / SUM(sent) over that period.';


--
-- Name: COLUMN prospecting_metric_daily.opens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prospecting_metric_daily.opens IS 'Human-classified (is_bot=false) opens by occurred date. UNIQUE per (step_log, day) ΓÇö repeat opens of the same send on the same day count once. Directional metric (Apple MPP inflation).';


--
-- Name: prospecting_metric_daily_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prospecting_metric_daily_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prospecting_metric_daily_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prospecting_metric_daily_id_seq OWNED BY public.prospecting_metric_daily.id;


--
-- Name: prospecting_sender_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prospecting_sender_accounts (
    id integer NOT NULL,
    org_id integer NOT NULL,
    user_id integer,
    provider character varying(20) NOT NULL,
    email character varying(255) NOT NULL,
    label character varying(100),
    access_token text NOT NULL,
    refresh_token text,
    expires_at timestamp with time zone,
    account_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    daily_limit integer,
    min_delay_minutes integer,
    emails_sent_today integer DEFAULT 0 NOT NULL,
    last_reset_at date DEFAULT CURRENT_DATE NOT NULL,
    last_sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    display_name text,
    signature text,
    client_id integer,
    linkedin_signature text,
    CONSTRAINT chk_psa_owner CHECK ((((user_id IS NOT NULL) AND (client_id IS NULL)) OR ((user_id IS NULL) AND (client_id IS NOT NULL)))),
    CONSTRAINT prospecting_sender_accounts_daily_limit_check CHECK (((daily_limit IS NULL) OR (daily_limit > 0))),
    CONSTRAINT prospecting_sender_accounts_emails_sent_today_check CHECK ((emails_sent_today >= 0)),
    CONSTRAINT prospecting_sender_accounts_min_delay_minutes_check CHECK (((min_delay_minutes IS NULL) OR (min_delay_minutes >= 0))),
    CONSTRAINT prospecting_sender_accounts_provider_check CHECK (((provider)::text = ANY ((ARRAY['gmail'::character varying, 'outlook'::character varying])::text[])))
);


--
-- Name: COLUMN prospecting_sender_accounts.display_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prospecting_sender_accounts.display_name IS 'Human-readable sender name shown in the From / sign-off, e.g. "Jane Smith"';


--
-- Name: COLUMN prospecting_sender_accounts.signature; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prospecting_sender_accounts.signature IS 'Plain-text (or light HTML) email signature appended to every outbound draft/send';


--
-- Name: prospecting_sender_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prospecting_sender_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prospecting_sender_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prospecting_sender_accounts_id_seq OWNED BY public.prospecting_sender_accounts.id;


--
-- Name: prospects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prospects (
    id integer NOT NULL,
    org_id integer NOT NULL,
    owner_id integer NOT NULL,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    email character varying(255),
    phone character varying(50),
    linkedin_url character varying(500),
    title character varying(255),
    location character varying(255),
    company_name character varying(255),
    company_domain character varying(255),
    company_size character varying(50),
    company_industry character varying(100),
    account_id integer,
    contact_id integer,
    deal_id integer,
    stage character varying(50) DEFAULT 'target'::character varying NOT NULL,
    stage_changed_at timestamp without time zone,
    revisit_disposition text,
    revisit_date date,
    playbook_id integer,
    source character varying(100),
    icp_score integer,
    icp_signals jsonb DEFAULT '{}'::jsonb,
    last_outreach_at timestamp without time zone,
    last_response_at timestamp without time zone,
    outreach_count integer DEFAULT 0,
    response_count integer DEFAULT 0,
    current_sequence_step integer DEFAULT 0,
    preferred_channel character varying(50),
    channel_data jsonb DEFAULT '{}'::jsonb,
    research_notes text,
    tags jsonb DEFAULT '[]'::jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamp without time zone,
    research_meta jsonb DEFAULT '{}'::jsonb,
    client_id integer,
    linkedin_headline text,
    external_refs jsonb DEFAULT '{}'::jsonb NOT NULL,
    disqualified_reason_code character varying(30),
    linkedin_about text,
    linkedin_activity jsonb DEFAULT '[]'::jsonb NOT NULL,
    linkedin_enrichment_meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    campaign_id integer,
    CONSTRAINT chk_prospect_revisit_disposition CHECK (((revisit_disposition IS NULL) OR (revisit_disposition = ANY (ARRAY['kill'::text, 'long_term'::text, 'unable_to_decide'::text]))))
);


--
-- Name: COLUMN prospects.research_meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prospects.research_meta IS 'Metadata about the AI generation: provider, model, prompt_id, prompt_source, account_research_used, generated_by_user_id, generated_at, confidence.';


--
-- Name: COLUMN prospects.linkedin_headline; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prospects.linkedin_headline IS 'Free-text headline shown on the prospect''s LinkedIn profile. Distinct from title (job title). Populated by the Chrome extension.';


--
-- Name: prospects_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prospects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prospects_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prospects_id_seq OWNED BY public.prospects.id;


--
-- Name: rule_violations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rule_violations (
    id integer NOT NULL,
    rule_id integer NOT NULL,
    execution_id integer,
    entity_id integer NOT NULL,
    entity_type character varying(20) NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: rule_violations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rule_violations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rule_violations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rule_violations_id_seq OWNED BY public.rule_violations.id;


--
-- Name: sales_handover_commitments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_handover_commitments (
    id integer NOT NULL,
    handover_id integer NOT NULL,
    org_id integer NOT NULL,
    description text NOT NULL,
    commitment_type character varying(20) DEFAULT 'promise'::character varying NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sales_handover_commitments_commitment_type_check CHECK (((commitment_type)::text = ANY ((ARRAY['promise'::character varying, 'risk'::character varying, 'red_flag'::character varying])::text[])))
);


--
-- Name: TABLE sales_handover_commitments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sales_handover_commitments IS 'Promises made to the customer, known risks, and red flags captured by sales before submitting the handover. Visible to service team.';


--
-- Name: sales_handover_commitments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_handover_commitments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_handover_commitments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_handover_commitments_id_seq OWNED BY public.sales_handover_commitments.id;


--
-- Name: sales_handover_plays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_handover_plays (
    id integer NOT NULL,
    handover_id integer NOT NULL,
    play_instance_id integer NOT NULL,
    org_id integer NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE sales_handover_plays; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sales_handover_plays IS 'Join between a sales_handover and the deal_play_instances created by the handover_s2i playbook for that deal. The handover form reads its section list from here. completed_at is kept in sync with deal_play_instances.completed_at for efficient gate checking without a join.';


--
-- Name: sales_handover_plays_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_handover_plays_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_handover_plays_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_handover_plays_id_seq OWNED BY public.sales_handover_plays.id;


--
-- Name: sales_handover_stakeholders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_handover_stakeholders (
    id integer NOT NULL,
    handover_id integer NOT NULL,
    org_id integer NOT NULL,
    contact_id integer,
    account_team_id integer,
    name character varying(150) NOT NULL,
    handover_role character varying(50) DEFAULT 'other'::character varying NOT NULL,
    relationship_notes text,
    is_primary_contact boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sales_handover_stakeholders_handover_role_check CHECK (((handover_role)::text = ANY ((ARRAY['implementation_lead'::character varying, 'day_to_day_admin'::character varying, 'go_live_approver'::character varying, 'exec_sponsor'::character varying, 'technical_lead'::character varying, 'other'::character varying])::text[])))
);


--
-- Name: TABLE sales_handover_stakeholders; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sales_handover_stakeholders IS 'Customer-side people relevant to this handover. Pre-populated from deal_contacts on draft creation; sales rep can edit before submitting.';


--
-- Name: sales_handover_stakeholders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_handover_stakeholders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_handover_stakeholders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_handover_stakeholders_id_seq OWNED BY public.sales_handover_stakeholders.id;


--
-- Name: sales_handovers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_handovers (
    id integer NOT NULL,
    org_id integer NOT NULL,
    deal_id integer NOT NULL,
    account_id integer NOT NULL,
    assigned_service_owner_id integer,
    status character varying(30) DEFAULT 'draft'::character varying NOT NULL,
    go_live_date date,
    contract_value numeric(15,2),
    commercial_terms_summary text,
    playbook_id integer,
    created_by integer NOT NULL,
    submitted_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sales_handovers_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'submitted'::character varying, 'acknowledged'::character varying, 'in_progress'::character varying])::text[])))
);


--
-- Name: TABLE sales_handovers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sales_handovers IS 'One record per closed_won deal. Created automatically when a deal enters the closed_won stage. Sales fills it; service acknowledges and works it.';


--
-- Name: COLUMN sales_handovers.playbook_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sales_handovers.playbook_id IS 'The handover_s2i playbook active at time of creation. Play instances are linked via sales_handover_plays. Nullable ΓÇö handover works without it.';


--
-- Name: sales_handovers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sales_handovers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sales_handovers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sales_handovers_id_seq OWNED BY public.sales_handovers.id;


--
-- Name: sequence_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequence_enrollments (
    id integer NOT NULL,
    org_id integer NOT NULL,
    sequence_id integer NOT NULL,
    prospect_id integer NOT NULL,
    enrolled_by integer NOT NULL,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    current_step integer DEFAULT 1 NOT NULL,
    next_step_due timestamp with time zone,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    stopped_at timestamp with time zone,
    stop_reason character varying(100),
    personalised_steps jsonb DEFAULT '{}'::jsonb
);


--
-- Name: sequence_enrollments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sequence_enrollments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sequence_enrollments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sequence_enrollments_id_seq OWNED BY public.sequence_enrollments.id;


--
-- Name: sequence_step_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequence_step_logs (
    id integer NOT NULL,
    org_id integer NOT NULL,
    enrollment_id integer NOT NULL,
    sequence_step_id integer NOT NULL,
    prospect_id integer NOT NULL,
    channel character varying(50) NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying NOT NULL,
    subject text,
    body text,
    error_message text,
    fired_at timestamp with time zone DEFAULT now(),
    email_id integer,
    scheduled_send_at timestamp with time zone,
    personalize_sources jsonb,
    approved_at timestamp with time zone,
    approved_by integer,
    CONSTRAINT sequence_step_logs_status_check CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('sent'::character varying)::text, ('completed'::character varying)::text, ('replied'::character varying)::text, ('skipped'::character varying)::text, ('active'::character varying)::text, ('failed'::character varying)::text, ('scheduled'::character varying)::text, ('sending'::character varying)::text])))
);


--
-- Name: COLUMN sequence_step_logs.approved_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sequence_step_logs.approved_at IS 'When a rep approved this draft for paced sending (draft -> scheduled). NULL for auto-send rows.';


--
-- Name: COLUMN sequence_step_logs.approved_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sequence_step_logs.approved_by IS 'users.id of the rep who approved the draft for paced sending. NULL for auto-send rows.';


--
-- Name: sequence_step_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sequence_step_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sequence_step_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sequence_step_logs_id_seq OWNED BY public.sequence_step_logs.id;


--
-- Name: sequence_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequence_steps (
    id integer NOT NULL,
    sequence_id integer NOT NULL,
    org_id integer NOT NULL,
    step_order integer NOT NULL,
    channel character varying(50) NOT NULL,
    delay_days integer DEFAULT 0 NOT NULL,
    subject_template text,
    body_template text,
    task_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    require_approval boolean,
    personalize_config jsonb,
    step_intent text
);


--
-- Name: COLUMN sequence_steps.step_intent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sequence_steps.step_intent IS 'Optional override for personalization dispatcher. NULL = auto-infer. Email intents: first_touch, follow_up, breakup. LinkedIn intents: connection_request, post_accept_message, nurture_dm.';


--
-- Name: sequence_steps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sequence_steps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sequence_steps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sequence_steps_id_seq OWNED BY public.sequence_steps.id;


--
-- Name: sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sequences (
    id integer NOT NULL,
    org_id integer NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    require_approval boolean DEFAULT true NOT NULL,
    client_id integer,
    personalize_config_default jsonb,
    ai_enabled boolean DEFAULT true NOT NULL,
    visibility text DEFAULT 'shared'::text NOT NULL,
    allow_manager_edit boolean DEFAULT false NOT NULL,
    CONSTRAINT sequences_visibility_chk CHECK ((visibility = ANY (ARRAY['shared'::text, 'private'::text])))
);


--
-- Name: COLUMN sequences.ai_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sequences.ai_enabled IS 'Whether this sequence uses AI personalization. Drives the builder master toggle, the campaign drawer''s AI-config visibility, and the default runSkill for preview/bulk-activate. When FALSE, steps send their templates verbatim and no skill is called.';


--
-- Name: sequences_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sequences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sequences_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sequences_id_seq OWNED BY public.sequences.id;


--
-- Name: sf_activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sf_activity_log (
    id integer NOT NULL,
    org_id integer NOT NULL,
    sf_object_id character varying(18) NOT NULL,
    sf_object_type character varying(50) NOT NULL,
    direction character varying(20) DEFAULT 'inbound'::character varying NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL,
    gw_action_id integer,
    gw_entity_type character varying(50),
    gw_entity_id integer
);


--
-- Name: sf_activity_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sf_activity_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sf_activity_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sf_activity_log_id_seq OWNED BY public.sf_activity_log.id;


--
-- Name: skill_prompt_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skill_prompt_versions (
    hash text NOT NULL,
    skill_name text NOT NULL,
    prompt_text text NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: skill_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skill_runs (
    id bigint NOT NULL,
    org_id integer NOT NULL,
    user_id integer,
    skill_name text NOT NULL,
    prospect_id integer,
    deal_id integer,
    input_payload jsonb NOT NULL,
    prompt_hash text,
    methodology text,
    output jsonb,
    raw_output text,
    hook_category text,
    hook_signal_id text,
    model text NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    cost_usd numeric(10,6) DEFAULT 0 NOT NULL,
    latency_ms integer,
    status text NOT NULL,
    error_detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cache_read_tokens integer DEFAULT 0 NOT NULL,
    cache_creation_tokens integer DEFAULT 0 NOT NULL,
    CONSTRAINT skill_runs_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'parse_failed'::text, 'execution_failed'::text, 'skipped'::text])))
);


--
-- Name: skill_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.skill_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: skill_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.skill_runs_id_seq OWNED BY public.skill_runs.id;


--
-- Name: sla_tiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sla_tiers (
    id integer NOT NULL,
    org_id integer NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    response_target_hours numeric(6,2) DEFAULT 4 NOT NULL,
    resolution_target_hours numeric(6,2) DEFAULT 24 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sla_tiers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sla_tiers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sla_tiers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sla_tiers_id_seq OWNED BY public.sla_tiers.id;


--
-- Name: storage_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storage_files (
    id integer NOT NULL,
    user_id integer NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    deal_id integer,
    contact_id integer,
    provider character varying(50) NOT NULL,
    provider_file_id text NOT NULL,
    web_url text,
    file_name text NOT NULL,
    file_size bigint,
    mime_type character varying(255),
    category character varying(50),
    last_modified_at timestamp with time zone,
    processing_status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    processed_at timestamp with time zone,
    pipelines_run text[],
    processing_error text,
    ai_summary text,
    ai_action_items jsonb,
    ai_sentiment character varying(50),
    ai_analysis_type character varying(100),
    deal_health_signals jsonb,
    competitors_found jsonb,
    health_score_after integer,
    health_status_after character varying(20),
    actions_generated integer DEFAULT 0,
    source_label text,
    org_id integer NOT NULL
);


--
-- Name: TABLE storage_files; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.storage_files IS 'References to files imported from cloud storage (OneDrive, Google Drive). Files are not duplicated here ΓÇö web_url opens them directly in the provider. Only extracted insights and short evidence snippets are stored.';


--
-- Name: COLUMN storage_files.provider_file_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.storage_files.provider_file_id IS 'Opaque provider-specific file ID (e.g. OneDrive item ID or Google Drive file ID). Used internally for API calls ΓÇö never shown to users. See source_label instead.';


--
-- Name: COLUMN storage_files.source_label; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.storage_files.source_label IS 'Human-readable identifier shown in the actions table. Format: "<Provider>: <FileName>". E.g. "OneDrive: Q3 Proposal Final.docx"';


--
-- Name: storage_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.storage_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: storage_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.storage_files_id_seq OWNED BY public.storage_files.id;


--
-- Name: strap_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strap_actions (
    id integer NOT NULL,
    strap_id integer NOT NULL,
    action_table character varying(30) DEFAULT 'actions'::character varying NOT NULL,
    action_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT strap_actions_action_table_check CHECK (((action_table)::text = ANY ((ARRAY['actions'::character varying, 'prospecting_actions'::character varying])::text[])))
);


--
-- Name: strap_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.strap_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: strap_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.strap_actions_id_seq OWNED BY public.strap_actions.id;


--
-- Name: straps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.straps (
    id integer NOT NULL,
    org_id integer NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id integer NOT NULL,
    hurdle_type character varying(60) NOT NULL,
    hurdle_title character varying(255) NOT NULL,
    situation text,
    target text,
    response text,
    action_plan text,
    priority character varying(10) DEFAULT 'medium'::character varying NOT NULL,
    source character varying(10) DEFAULT 'auto'::character varying NOT NULL,
    auto_hurdle_type character varying(60),
    auto_hurdle_title character varying(255),
    override_by integer,
    override_reason text,
    override_at timestamp with time zone,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    resolved_by integer,
    resolved_at timestamp with time zone,
    resolution_type character varying(20),
    resolution_note text,
    ai_model character varying(50),
    ai_tokens_used integer,
    created_by integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT straps_entity_type_check CHECK (((entity_type)::text = ANY ((ARRAY['deal'::character varying, 'account'::character varying, 'prospect'::character varying, 'implementation'::character varying])::text[]))),
    CONSTRAINT straps_priority_check CHECK (((priority)::text = ANY ((ARRAY['critical'::character varying, 'high'::character varying, 'medium'::character varying, 'low'::character varying])::text[]))),
    CONSTRAINT straps_resolution_type_check CHECK (((resolution_type)::text = ANY ((ARRAY['manual'::character varying, 'auto_detected'::character varying, 'superseded'::character varying])::text[]))),
    CONSTRAINT straps_source_check CHECK (((source)::text = ANY ((ARRAY['auto'::character varying, 'manual'::character varying])::text[]))),
    CONSTRAINT straps_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'resolved'::character varying, 'superseded'::character varying])::text[])))
);


--
-- Name: straps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.straps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: straps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.straps_id_seq OWNED BY public.straps.id;


--
-- Name: super_admin_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.super_admin_audit_log (
    id integer NOT NULL,
    super_admin_id integer NOT NULL,
    action character varying(100) NOT NULL,
    target_type character varying(50),
    target_id integer,
    payload jsonb,
    ip_address inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: super_admin_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.super_admin_audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: super_admin_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.super_admin_audit_log_id_seq OWNED BY public.super_admin_audit_log.id;


--
-- Name: super_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.super_admins (
    id integer NOT NULL,
    user_id integer NOT NULL,
    granted_by integer,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    notes text
);


--
-- Name: super_admins_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.super_admins_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: super_admins_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.super_admins_id_seq OWNED BY public.super_admins.id;


--
-- Name: team_dimensions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_dimensions (
    id integer NOT NULL,
    org_id integer NOT NULL,
    key character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    applies_to character varying(20) DEFAULT 'both'::character varying NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT team_dimensions_applies_to_check CHECK (((applies_to)::text = ANY ((ARRAY['internal'::character varying, 'customer'::character varying, 'both'::character varying])::text[])))
);


--
-- Name: TABLE team_dimensions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.team_dimensions IS 'Org-configurable vocabulary for team groupings. System dimensions are seeded on org creation and cannot be deleted. applies_to controls which dimension picker surfaces this entry: internal teams, customer account teams, or both.';


--
-- Name: COLUMN team_dimensions.key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_dimensions.key IS 'Stable machine key ΓÇö used in code, never changes after creation.';


--
-- Name: COLUMN team_dimensions.applies_to; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_dimensions.applies_to IS 'internal = only shown in Teams config; customer = only shown in Account Teams panel; both = shown everywhere.';


--
-- Name: team_dimensions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.team_dimensions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: team_dimensions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.team_dimensions_id_seq OWNED BY public.team_dimensions.id;


--
-- Name: team_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_memberships (
    id integer NOT NULL,
    org_id integer NOT NULL,
    user_id integer NOT NULL,
    team_id integer NOT NULL,
    role character varying(30) DEFAULT 'member'::character varying,
    is_primary boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: team_memberships_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.team_memberships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: team_memberships_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.team_memberships_id_seq OWNED BY public.team_memberships.id;


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id integer NOT NULL,
    org_id integer NOT NULL,
    name character varying(150) NOT NULL,
    dimension character varying(50) NOT NULL,
    parent_team_id integer,
    description text,
    settings jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT true,
    created_by integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    org_role_key character varying(100)
);


--
-- Name: teams_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.teams_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: teams_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.teams_id_seq OWNED BY public.teams.id;


--
-- Name: tracking_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tracking_domains (
    id integer NOT NULL,
    org_id integer NOT NULL,
    hostname character varying(255) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    cf_hostname_id character varying(64),
    last_checked_at timestamp with time zone,
    error_message text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_td_status CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'verifying'::character varying, 'active'::character varying, 'failed'::character varying, 'disabled'::character varying])::text[])))
);


--
-- Name: TABLE tracking_domains; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tracking_domains IS 'Per-customer CNAME tracking domains (Phase 7). status=active means DNS verified AND TLS cert issued ΓÇö only then does send-time decoration run. The CNAME target (track.gowarmcrm.com) is the stable customer contract; TLS provider is swappable (D38).';


--
-- Name: tracking_domains_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tracking_domains_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tracking_domains_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tracking_domains_id_seq OWNED BY public.tracking_domains.id;


--
-- Name: user_linkedin_seats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_linkedin_seats (
    id bigint NOT NULL,
    org_id integer NOT NULL,
    user_id integer NOT NULL,
    public_identifier text NOT NULL,
    display_name text,
    member_urn text,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE user_linkedin_seats; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_linkedin_seats IS 'Binds a LinkedIn member (publicIdentifier) to a GoWarm user. Created lazily on first extension connection-sync. One seat per org may bind to only one user.';


--
-- Name: COLUMN user_linkedin_seats.public_identifier; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_linkedin_seats.public_identifier IS 'LinkedIn /in/<slug>. Uniqueness and matching are on lower(public_identifier) per org.';


--
-- Name: user_linkedin_seats_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_linkedin_seats_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_linkedin_seats_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_linkedin_seats_id_seq OWNED BY public.user_linkedin_seats.id;


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    user_id integer NOT NULL,
    org_id integer NOT NULL,
    preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: TABLE user_preferences; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_preferences IS 'User-level config overrides. Merged on top of org settings at runtime.';


--
-- Name: user_prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_prompts (
    id integer NOT NULL,
    user_id integer NOT NULL,
    template_type character varying(50) NOT NULL,
    template_data text NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    org_id integer NOT NULL
);


--
-- Name: user_prompts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_prompts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_prompts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_prompts_id_seq OWNED BY public.user_prompts.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    role character varying(50) DEFAULT 'user'::character varying,
    avatar_url character varying(500),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    outlook_connected boolean DEFAULT false,
    outlook_email character varying(255),
    org_id integer NOT NULL,
    gmail_connected boolean DEFAULT false,
    gmail_email character varying(255),
    department text,
    phone character varying(32),
    twilio_did character varying(32),
    twilio_did_sid character varying(64),
    twilio_did_provisioned_at timestamp with time zone,
    timezone text
);


--
-- Name: COLUMN users.outlook_connected; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.outlook_connected IS 'Whether user has connected their Outlook account';


--
-- Name: COLUMN users.outlook_email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.outlook_email IS 'Users Outlook email address';


--
-- Name: COLUMN users.department; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.department IS 'Functional department: sales | legal | implementation | customer_support | finance | executive | other';


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: workflow_branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_branches (
    id integer NOT NULL,
    step_id integer NOT NULL,
    condition jsonb NOT NULL,
    true_step_id integer,
    false_step_id integer,
    sort_order integer DEFAULT 0 NOT NULL
);


--
-- Name: workflow_branches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workflow_branches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workflow_branches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workflow_branches_id_seq OWNED BY public.workflow_branches.id;


--
-- Name: workflow_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_executions (
    id integer NOT NULL,
    workflow_id integer NOT NULL,
    entity_id integer NOT NULL,
    entity_type character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'running'::character varying NOT NULL,
    triggered_by integer,
    trigger character varying(30) NOT NULL,
    step_results jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: workflow_executions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workflow_executions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workflow_executions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workflow_executions_id_seq OWNED BY public.workflow_executions.id;


--
-- Name: workflow_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_rules (
    id integer NOT NULL,
    step_id integer,
    org_id integer,
    entity character varying(20) NOT NULL,
    rule_type character varying(30) NOT NULL,
    name character varying(255) NOT NULL,
    severity character varying(10) DEFAULT 'block'::character varying NOT NULL,
    trigger character varying(30) NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    action jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_locked boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workflow_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workflow_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workflow_rules_id_seq OWNED BY public.workflow_rules.id;


--
-- Name: workflow_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_steps (
    id integer NOT NULL,
    workflow_id integer NOT NULL,
    step_type character varying(20) NOT NULL,
    name character varying(255) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    on_pass integer,
    on_fail integer,
    exec_mode character varying(10) DEFAULT 'sync'::character varying NOT NULL,
    depends_on integer[] DEFAULT '{}'::integer[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_steps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workflow_steps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workflow_steps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workflow_steps_id_seq OWNED BY public.workflow_steps.id;


--
-- Name: workflows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflows (
    id integer NOT NULL,
    org_id integer,
    scope character varying(20) DEFAULT 'org'::character varying NOT NULL,
    entity character varying(20) NOT NULL,
    trigger character varying(30) NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    is_locked boolean DEFAULT false NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflows_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workflows_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workflows_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workflows_id_seq OWNED BY public.workflows.id;


--
-- Name: account_hierarchy id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_hierarchy ALTER COLUMN id SET DEFAULT nextval('public.account_hierarchy_id_seq'::regclass);


--
-- Name: account_team_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_team_members ALTER COLUMN id SET DEFAULT nextval('public.account_team_members_id_seq'::regclass);


--
-- Name: account_teams id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_teams ALTER COLUMN id SET DEFAULT nextval('public.account_teams_id_seq'::regclass);


--
-- Name: accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts ALTER COLUMN id SET DEFAULT nextval('public.accounts_id_seq'::regclass);


--
-- Name: action_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_config ALTER COLUMN id SET DEFAULT nextval('public.action_config_id_seq'::regclass);


--
-- Name: action_suggestions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_suggestions ALTER COLUMN id SET DEFAULT nextval('public.action_suggestions_id_seq'::regclass);


--
-- Name: actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions ALTER COLUMN id SET DEFAULT nextval('public.actions_id_seq'::regclass);


--
-- Name: agent_proposals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals ALTER COLUMN id SET DEFAULT nextval('public.agent_proposals_id_seq'::regclass);


--
-- Name: ai_processing_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_processing_log ALTER COLUMN id SET DEFAULT nextval('public.ai_processing_log_id_seq'::regclass);


--
-- Name: ai_token_usage id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_usage ALTER COLUMN id SET DEFAULT nextval('public.ai_token_usage_id_seq'::regclass);


--
-- Name: calendar_sync_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_sync_history ALTER COLUMN id SET DEFAULT nextval('public.calendar_sync_history_id_seq'::regclass);


--
-- Name: calls id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls ALTER COLUMN id SET DEFAULT nextval('public.calls_id_seq'::regclass);


--
-- Name: case_notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_notes ALTER COLUMN id SET DEFAULT nextval('public.case_notes_id_seq'::regclass);


--
-- Name: case_plays id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_plays ALTER COLUMN id SET DEFAULT nextval('public.case_plays_id_seq'::regclass);


--
-- Name: case_status_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_status_history ALTER COLUMN id SET DEFAULT nextval('public.case_status_history_id_seq'::regclass);


--
-- Name: cases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases ALTER COLUMN id SET DEFAULT nextval('public.cases_id_seq'::regclass);


--
-- Name: client_activities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_activities ALTER COLUMN id SET DEFAULT nextval('public.client_activities_id_seq'::regclass);


--
-- Name: client_portal_users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_portal_users ALTER COLUMN id SET DEFAULT nextval('public.client_portal_users_id_seq'::regclass);


--
-- Name: client_team_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_team_members ALTER COLUMN id SET DEFAULT nextval('public.client_team_members_id_seq'::regclass);


--
-- Name: clients id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients ALTER COLUMN id SET DEFAULT nextval('public.clients_id_seq'::regclass);


--
-- Name: competitors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competitors ALTER COLUMN id SET DEFAULT nextval('public.competitors_id_seq'::regclass);


--
-- Name: contact_activities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_activities ALTER COLUMN id SET DEFAULT nextval('public.contact_activities_id_seq'::regclass);


--
-- Name: contact_dotted_lines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_dotted_lines ALTER COLUMN id SET DEFAULT nextval('public.contact_dotted_lines_id_seq'::regclass);


--
-- Name: contact_identities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_identities ALTER COLUMN id SET DEFAULT nextval('public.contact_identities_id_seq'::regclass);


--
-- Name: contacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts ALTER COLUMN id SET DEFAULT nextval('public.contacts_id_seq'::regclass);


--
-- Name: contract_approval_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_approval_config ALTER COLUMN id SET DEFAULT nextval('public.contract_approval_config_id_seq'::regclass);


--
-- Name: contract_approvals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_approvals ALTER COLUMN id SET DEFAULT nextval('public.contract_approvals_id_seq'::regclass);


--
-- Name: contract_document_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_document_versions ALTER COLUMN id SET DEFAULT nextval('public.contract_document_versions_id_seq'::regclass);


--
-- Name: contract_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_events ALTER COLUMN id SET DEFAULT nextval('public.contract_events_id_seq'::regclass);


--
-- Name: contract_play_instances id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_play_instances ALTER COLUMN id SET DEFAULT nextval('public.contract_play_instances_id_seq'::regclass);


--
-- Name: contract_plays id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_plays ALTER COLUMN id SET DEFAULT nextval('public.contract_plays_id_seq'::regclass);


--
-- Name: contract_signatories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_signatories ALTER COLUMN id SET DEFAULT nextval('public.contract_signatories_id_seq'::regclass);


--
-- Name: contract_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_templates ALTER COLUMN id SET DEFAULT nextval('public.contract_templates_id_seq'::regclass);


--
-- Name: contract_workflow_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_workflow_config ALTER COLUMN id SET DEFAULT nextval('public.contract_workflow_config_id_seq'::regclass);


--
-- Name: contracts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts ALTER COLUMN id SET DEFAULT nextval('public.contracts_id_seq'::regclass);


--
-- Name: conversation_starters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_starters ALTER COLUMN id SET DEFAULT nextval('public.conversation_starters_id_seq'::regclass);


--
-- Name: deal_activities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_activities ALTER COLUMN id SET DEFAULT nextval('public.deal_activities_id_seq'::regclass);


--
-- Name: deal_health_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_health_config ALTER COLUMN id SET DEFAULT nextval('public.deal_health_config_id_seq'::regclass);


--
-- Name: deal_play_assignees id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_assignees ALTER COLUMN id SET DEFAULT nextval('public.deal_play_assignees_id_seq'::regclass);


--
-- Name: deal_play_instances id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_instances ALTER COLUMN id SET DEFAULT nextval('public.deal_play_instances_id_seq'::regclass);


--
-- Name: deal_products id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_products ALTER COLUMN id SET DEFAULT nextval('public.deal_products_id_seq'::regclass);


--
-- Name: deal_team_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_team_members ALTER COLUMN id SET DEFAULT nextval('public.deal_team_members_id_seq'::regclass);


--
-- Name: deal_value_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_value_history ALTER COLUMN id SET DEFAULT nextval('public.deal_value_history_id_seq'::regclass);


--
-- Name: deals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals ALTER COLUMN id SET DEFAULT nextval('public.deals_id_seq'::regclass);


--
-- Name: discovered_models id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovered_models ALTER COLUMN id SET DEFAULT nextval('public.discovered_models_id_seq'::regclass);


--
-- Name: domain_health_daily id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_health_daily ALTER COLUMN id SET DEFAULT nextval('public.domain_health_daily_id_seq'::regclass);


--
-- Name: email_delivery_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_delivery_events ALTER COLUMN id SET DEFAULT nextval('public.email_delivery_events_id_seq'::regclass);


--
-- Name: email_engagement_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_engagement_events ALTER COLUMN id SET DEFAULT nextval('public.email_engagement_events_id_seq'::regclass);


--
-- Name: email_filter_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_filter_log ALTER COLUMN id SET DEFAULT nextval('public.email_filter_log_id_seq'::regclass);


--
-- Name: email_sync_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sync_history ALTER COLUMN id SET DEFAULT nextval('public.email_sync_history_id_seq'::regclass);


--
-- Name: emails id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails ALTER COLUMN id SET DEFAULT nextval('public.emails_id_seq'::regclass);


--
-- Name: enrichment_credit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_credit_log ALTER COLUMN id SET DEFAULT nextval('public.enrichment_credit_log_id_seq'::regclass);


--
-- Name: entity_custom_fields id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_custom_fields ALTER COLUMN id SET DEFAULT nextval('public.entity_custom_fields_id_seq'::regclass);


--
-- Name: linkedin_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linkedin_profiles ALTER COLUMN id SET DEFAULT nextval('public.linkedin_profiles_id_seq'::regclass);


--
-- Name: meeting_transcripts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_transcripts ALTER COLUMN id SET DEFAULT nextval('public.meeting_transcripts_id_seq'::regclass);


--
-- Name: meetings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings ALTER COLUMN id SET DEFAULT nextval('public.meetings_id_seq'::regclass);


--
-- Name: merged_contacts_archive id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.merged_contacts_archive ALTER COLUMN id SET DEFAULT nextval('public.merged_contacts_archive_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: oauth_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens ALTER COLUMN id SET DEFAULT nextval('public.oauth_tokens_id_seq'::regclass);


--
-- Name: org_action_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_action_config ALTER COLUMN id SET DEFAULT nextval('public.org_action_config_id_seq'::regclass);


--
-- Name: org_credentials id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_credentials ALTER COLUMN id SET DEFAULT nextval('public.ai_credentials_id_seq'::regclass);


--
-- Name: org_hierarchy id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_hierarchy ALTER COLUMN id SET DEFAULT nextval('public.org_hierarchy_id_seq'::regclass);


--
-- Name: org_integrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_integrations ALTER COLUMN id SET DEFAULT nextval('public.org_integrations_id_seq'::regclass);


--
-- Name: org_invitations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations ALTER COLUMN id SET DEFAULT nextval('public.org_invitations_id_seq'::regclass);


--
-- Name: org_invites id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invites ALTER COLUMN id SET DEFAULT nextval('public.org_invites_id_seq'::regclass);


--
-- Name: org_roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_roles ALTER COLUMN id SET DEFAULT nextval('public.org_roles_id_seq'::regclass);


--
-- Name: organizations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations ALTER COLUMN id SET DEFAULT nextval('public.organizations_id_seq'::regclass);


--
-- Name: password_reset_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens ALTER COLUMN id SET DEFAULT nextval('public.password_reset_tokens_id_seq'::regclass);


--
-- Name: pipeline_stages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_stages ALTER COLUMN id SET DEFAULT nextval('public.pipeline_stages_id_seq'::regclass);


--
-- Name: playbook_play_roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_play_roles ALTER COLUMN id SET DEFAULT nextval('public.playbook_play_roles_id_seq'::regclass);


--
-- Name: playbook_plays id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_plays ALTER COLUMN id SET DEFAULT nextval('public.playbook_plays_id_seq'::regclass);


--
-- Name: playbook_registrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_registrations ALTER COLUMN id SET DEFAULT nextval('public.playbook_registrations_id_seq'::regclass);


--
-- Name: playbook_roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_roles ALTER COLUMN id SET DEFAULT nextval('public.playbook_roles_id_seq'::regclass);


--
-- Name: playbook_stages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_stages ALTER COLUMN id SET DEFAULT nextval('public.playbook_stages_id_seq'::regclass);


--
-- Name: playbook_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_versions ALTER COLUMN id SET DEFAULT nextval('public.playbook_versions_id_seq'::regclass);


--
-- Name: playbooks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbooks ALTER COLUMN id SET DEFAULT nextval('public.playbooks_id_seq'::regclass);


--
-- Name: product_catalog id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_catalog ALTER COLUMN id SET DEFAULT nextval('public.product_catalog_id_seq'::regclass);


--
-- Name: product_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_groups ALTER COLUMN id SET DEFAULT nextval('public.product_groups_id_seq'::regclass);


--
-- Name: prompts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompts ALTER COLUMN id SET DEFAULT nextval('public.prompts_id_seq'::regclass);


--
-- Name: proposals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals ALTER COLUMN id SET DEFAULT nextval('public.proposals_id_seq'::regclass);


--
-- Name: prospecting_actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_actions ALTER COLUMN id SET DEFAULT nextval('public.prospecting_actions_id_seq'::regclass);


--
-- Name: prospecting_activities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_activities ALTER COLUMN id SET DEFAULT nextval('public.prospecting_activities_id_seq'::regclass);


--
-- Name: prospecting_campaigns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_campaigns ALTER COLUMN id SET DEFAULT nextval('public.prospecting_campaigns_id_seq'::regclass);


--
-- Name: prospecting_edit_grants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_edit_grants ALTER COLUMN id SET DEFAULT nextval('public.prospecting_edit_grants_id_seq'::regclass);


--
-- Name: prospecting_insights id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_insights ALTER COLUMN id SET DEFAULT nextval('public.prospecting_insights_id_seq'::regclass);


--
-- Name: prospecting_metric_daily id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_metric_daily ALTER COLUMN id SET DEFAULT nextval('public.prospecting_metric_daily_id_seq'::regclass);


--
-- Name: prospecting_sender_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_sender_accounts ALTER COLUMN id SET DEFAULT nextval('public.prospecting_sender_accounts_id_seq'::regclass);


--
-- Name: prospects id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospects ALTER COLUMN id SET DEFAULT nextval('public.prospects_id_seq'::regclass);


--
-- Name: rule_violations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rule_violations ALTER COLUMN id SET DEFAULT nextval('public.rule_violations_id_seq'::regclass);


--
-- Name: sales_handover_commitments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_commitments ALTER COLUMN id SET DEFAULT nextval('public.sales_handover_commitments_id_seq'::regclass);


--
-- Name: sales_handover_plays id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_plays ALTER COLUMN id SET DEFAULT nextval('public.sales_handover_plays_id_seq'::regclass);


--
-- Name: sales_handover_stakeholders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_stakeholders ALTER COLUMN id SET DEFAULT nextval('public.sales_handover_stakeholders_id_seq'::regclass);


--
-- Name: sales_handovers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handovers ALTER COLUMN id SET DEFAULT nextval('public.sales_handovers_id_seq'::regclass);


--
-- Name: sequence_enrollments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_enrollments ALTER COLUMN id SET DEFAULT nextval('public.sequence_enrollments_id_seq'::regclass);


--
-- Name: sequence_step_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_step_logs ALTER COLUMN id SET DEFAULT nextval('public.sequence_step_logs_id_seq'::regclass);


--
-- Name: sequence_steps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_steps ALTER COLUMN id SET DEFAULT nextval('public.sequence_steps_id_seq'::regclass);


--
-- Name: sequences id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequences ALTER COLUMN id SET DEFAULT nextval('public.sequences_id_seq'::regclass);


--
-- Name: sf_activity_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sf_activity_log ALTER COLUMN id SET DEFAULT nextval('public.sf_activity_log_id_seq'::regclass);


--
-- Name: skill_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_runs ALTER COLUMN id SET DEFAULT nextval('public.skill_runs_id_seq'::regclass);


--
-- Name: sla_tiers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sla_tiers ALTER COLUMN id SET DEFAULT nextval('public.sla_tiers_id_seq'::regclass);


--
-- Name: storage_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_files ALTER COLUMN id SET DEFAULT nextval('public.storage_files_id_seq'::regclass);


--
-- Name: strap_actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strap_actions ALTER COLUMN id SET DEFAULT nextval('public.strap_actions_id_seq'::regclass);


--
-- Name: straps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.straps ALTER COLUMN id SET DEFAULT nextval('public.straps_id_seq'::regclass);


--
-- Name: super_admin_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.super_admin_audit_log ALTER COLUMN id SET DEFAULT nextval('public.super_admin_audit_log_id_seq'::regclass);


--
-- Name: super_admins id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.super_admins ALTER COLUMN id SET DEFAULT nextval('public.super_admins_id_seq'::regclass);


--
-- Name: team_dimensions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_dimensions ALTER COLUMN id SET DEFAULT nextval('public.team_dimensions_id_seq'::regclass);


--
-- Name: team_memberships id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_memberships ALTER COLUMN id SET DEFAULT nextval('public.team_memberships_id_seq'::regclass);


--
-- Name: teams id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams ALTER COLUMN id SET DEFAULT nextval('public.teams_id_seq'::regclass);


--
-- Name: tracking_domains id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tracking_domains ALTER COLUMN id SET DEFAULT nextval('public.tracking_domains_id_seq'::regclass);


--
-- Name: user_linkedin_seats id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_linkedin_seats ALTER COLUMN id SET DEFAULT nextval('public.user_linkedin_seats_id_seq'::regclass);


--
-- Name: user_prompts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_prompts ALTER COLUMN id SET DEFAULT nextval('public.user_prompts_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: workflow_branches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_branches ALTER COLUMN id SET DEFAULT nextval('public.workflow_branches_id_seq'::regclass);


--
-- Name: workflow_executions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_executions ALTER COLUMN id SET DEFAULT nextval('public.workflow_executions_id_seq'::regclass);


--
-- Name: workflow_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_rules ALTER COLUMN id SET DEFAULT nextval('public.workflow_rules_id_seq'::regclass);


--
-- Name: workflow_steps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_steps ALTER COLUMN id SET DEFAULT nextval('public.workflow_steps_id_seq'::regclass);


--
-- Name: workflows id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflows ALTER COLUMN id SET DEFAULT nextval('public.workflows_id_seq'::regclass);


--
-- Name: account_hierarchy account_hierarchy_org_id_parent_account_id_child_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_hierarchy
    ADD CONSTRAINT account_hierarchy_org_id_parent_account_id_child_account_id_key UNIQUE (org_id, parent_account_id, child_account_id);


--
-- Name: account_hierarchy account_hierarchy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_hierarchy
    ADD CONSTRAINT account_hierarchy_pkey PRIMARY KEY (id);


--
-- Name: account_team_members account_team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_team_members
    ADD CONSTRAINT account_team_members_pkey PRIMARY KEY (id);


--
-- Name: account_team_members account_team_members_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_team_members
    ADD CONSTRAINT account_team_members_unique UNIQUE (account_team_id, contact_id);


--
-- Name: account_teams account_teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_teams
    ADD CONSTRAINT account_teams_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: action_config action_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_config
    ADD CONSTRAINT action_config_pkey PRIMARY KEY (id);


--
-- Name: action_suggestions action_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_suggestions
    ADD CONSTRAINT action_suggestions_pkey PRIMARY KEY (id);


--
-- Name: actions actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_pkey PRIMARY KEY (id);


--
-- Name: agent_proposals agent_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_pkey PRIMARY KEY (id);


--
-- Name: org_credentials ai_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_credentials
    ADD CONSTRAINT ai_credentials_pkey PRIMARY KEY (id);


--
-- Name: ai_processing_log ai_processing_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_processing_log
    ADD CONSTRAINT ai_processing_log_pkey PRIMARY KEY (id);


--
-- Name: ai_token_usage ai_token_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_usage
    ADD CONSTRAINT ai_token_usage_pkey PRIMARY KEY (id);


--
-- Name: calendar_sync_history calendar_sync_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_sync_history
    ADD CONSTRAINT calendar_sync_history_pkey PRIMARY KEY (id);


--
-- Name: calls calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_pkey PRIMARY KEY (id);


--
-- Name: case_notes case_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_notes
    ADD CONSTRAINT case_notes_pkey PRIMARY KEY (id);


--
-- Name: case_plays case_plays_case_id_play_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_plays
    ADD CONSTRAINT case_plays_case_id_play_id_key UNIQUE (case_id, play_id);


--
-- Name: case_plays case_plays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_plays
    ADD CONSTRAINT case_plays_pkey PRIMARY KEY (id);


--
-- Name: case_status_history case_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_status_history
    ADD CONSTRAINT case_status_history_pkey PRIMARY KEY (id);


--
-- Name: cases cases_org_case_number_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_org_case_number_uq UNIQUE (org_id, case_number);


--
-- Name: cases cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_pkey PRIMARY KEY (id);


--
-- Name: client_activities client_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_activities
    ADD CONSTRAINT client_activities_pkey PRIMARY KEY (id);


--
-- Name: client_portal_users client_portal_users_client_id_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_portal_users
    ADD CONSTRAINT client_portal_users_client_id_email_key UNIQUE (client_id, email);


--
-- Name: client_portal_users client_portal_users_invite_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_portal_users
    ADD CONSTRAINT client_portal_users_invite_token_key UNIQUE (invite_token);


--
-- Name: client_portal_users client_portal_users_magic_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_portal_users
    ADD CONSTRAINT client_portal_users_magic_token_key UNIQUE (magic_token);


--
-- Name: client_portal_users client_portal_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_portal_users
    ADD CONSTRAINT client_portal_users_pkey PRIMARY KEY (id);


--
-- Name: client_team_members client_team_members_client_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_team_members
    ADD CONSTRAINT client_team_members_client_id_user_id_key UNIQUE (client_id, user_id);


--
-- Name: client_team_members client_team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_team_members
    ADD CONSTRAINT client_team_members_pkey PRIMARY KEY (id);


--
-- Name: clients clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (id);


--
-- Name: clients clients_report_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_report_token_key UNIQUE (report_token);


--
-- Name: competitors competitors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competitors
    ADD CONSTRAINT competitors_pkey PRIMARY KEY (id);


--
-- Name: contact_activities contact_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_activities
    ADD CONSTRAINT contact_activities_pkey PRIMARY KEY (id);


--
-- Name: contact_dotted_lines contact_dotted_lines_org_id_contact_id_dotted_manager_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_dotted_lines
    ADD CONSTRAINT contact_dotted_lines_org_id_contact_id_dotted_manager_id_key UNIQUE (org_id, contact_id, dotted_manager_id);


--
-- Name: contact_dotted_lines contact_dotted_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_dotted_lines
    ADD CONSTRAINT contact_dotted_lines_pkey PRIMARY KEY (id);


--
-- Name: contact_identities contact_identities_org_id_identity_type_identity_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_identities
    ADD CONSTRAINT contact_identities_org_id_identity_type_identity_value_key UNIQUE (org_id, identity_type, identity_value);


--
-- Name: contact_identities contact_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_identities
    ADD CONSTRAINT contact_identities_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: contract_approval_config contract_approval_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_approval_config
    ADD CONSTRAINT contract_approval_config_pkey PRIMARY KEY (id);


--
-- Name: contract_approvals contract_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_approvals
    ADD CONSTRAINT contract_approvals_pkey PRIMARY KEY (id);


--
-- Name: contract_document_versions contract_document_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_document_versions
    ADD CONSTRAINT contract_document_versions_pkey PRIMARY KEY (id);


--
-- Name: contract_events contract_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_events
    ADD CONSTRAINT contract_events_pkey PRIMARY KEY (id);


--
-- Name: contract_play_instances contract_play_instances_contract_id_play_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_play_instances
    ADD CONSTRAINT contract_play_instances_contract_id_play_id_key UNIQUE (contract_id, play_id);


--
-- Name: contract_play_instances contract_play_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_play_instances
    ADD CONSTRAINT contract_play_instances_pkey PRIMARY KEY (id);


--
-- Name: contract_plays contract_plays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_plays
    ADD CONSTRAINT contract_plays_pkey PRIMARY KEY (id);


--
-- Name: contract_signatories contract_signatories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_signatories
    ADD CONSTRAINT contract_signatories_pkey PRIMARY KEY (id);


--
-- Name: contract_templates contract_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_templates
    ADD CONSTRAINT contract_templates_pkey PRIMARY KEY (id);


--
-- Name: contract_workflow_config contract_workflow_config_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_workflow_config
    ADD CONSTRAINT contract_workflow_config_org_id_key UNIQUE (org_id);


--
-- Name: contract_workflow_config contract_workflow_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_workflow_config
    ADD CONSTRAINT contract_workflow_config_pkey PRIMARY KEY (id);


--
-- Name: contracts contracts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_pkey PRIMARY KEY (id);


--
-- Name: conversation_starters conversation_starters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_starters
    ADD CONSTRAINT conversation_starters_pkey PRIMARY KEY (id);


--
-- Name: deal_activities deal_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_activities
    ADD CONSTRAINT deal_activities_pkey PRIMARY KEY (id);


--
-- Name: deal_contacts deal_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_contacts
    ADD CONSTRAINT deal_contacts_pkey PRIMARY KEY (deal_id, contact_id);


--
-- Name: deal_health_config deal_health_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_health_config
    ADD CONSTRAINT deal_health_config_pkey PRIMARY KEY (id);


--
-- Name: deal_play_assignees deal_play_assignees_instance_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_assignees
    ADD CONSTRAINT deal_play_assignees_instance_id_user_id_key UNIQUE (instance_id, user_id);


--
-- Name: deal_play_assignees deal_play_assignees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_assignees
    ADD CONSTRAINT deal_play_assignees_pkey PRIMARY KEY (id);


--
-- Name: deal_play_instances deal_play_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_instances
    ADD CONSTRAINT deal_play_instances_pkey PRIMARY KEY (id);


--
-- Name: deal_products deal_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_products
    ADD CONSTRAINT deal_products_pkey PRIMARY KEY (id);


--
-- Name: deal_team_members deal_team_members_deal_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_team_members
    ADD CONSTRAINT deal_team_members_deal_id_user_id_key UNIQUE (deal_id, user_id);


--
-- Name: deal_team_members deal_team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_team_members
    ADD CONSTRAINT deal_team_members_pkey PRIMARY KEY (id);


--
-- Name: deal_value_history deal_value_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_value_history
    ADD CONSTRAINT deal_value_history_pkey PRIMARY KEY (id);


--
-- Name: deals deals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_pkey PRIMARY KEY (id);


--
-- Name: discovered_models discovered_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovered_models
    ADD CONSTRAINT discovered_models_pkey PRIMARY KEY (id);


--
-- Name: discovered_models discovered_models_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discovered_models
    ADD CONSTRAINT discovered_models_unique UNIQUE (provider, model_id);


--
-- Name: domain_health_daily domain_health_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domain_health_daily
    ADD CONSTRAINT domain_health_daily_pkey PRIMARY KEY (id);


--
-- Name: email_delivery_events email_delivery_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_delivery_events
    ADD CONSTRAINT email_delivery_events_pkey PRIMARY KEY (id);


--
-- Name: email_engagement_events email_engagement_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_engagement_events
    ADD CONSTRAINT email_engagement_events_pkey PRIMARY KEY (id);


--
-- Name: email_filter_log email_filter_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_filter_log
    ADD CONSTRAINT email_filter_log_pkey PRIMARY KEY (id);


--
-- Name: email_sync_history email_sync_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sync_history
    ADD CONSTRAINT email_sync_history_pkey PRIMARY KEY (id);


--
-- Name: emails emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails
    ADD CONSTRAINT emails_pkey PRIMARY KEY (id);


--
-- Name: enrichment_credit_log enrichment_credit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_credit_log
    ADD CONSTRAINT enrichment_credit_log_pkey PRIMARY KEY (id);


--
-- Name: entity_custom_fields entity_custom_fields_org_id_entity_type_entity_id_field_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_custom_fields
    ADD CONSTRAINT entity_custom_fields_org_id_entity_type_entity_id_field_key_key UNIQUE (org_id, entity_type, entity_id, field_key);


--
-- Name: entity_custom_fields entity_custom_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_custom_fields
    ADD CONSTRAINT entity_custom_fields_pkey PRIMARY KEY (id);


--
-- Name: linkedin_profiles linkedin_profiles_org_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linkedin_profiles
    ADD CONSTRAINT linkedin_profiles_org_slug_unique UNIQUE (org_id, linkedin_slug);


--
-- Name: linkedin_profiles linkedin_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linkedin_profiles
    ADD CONSTRAINT linkedin_profiles_pkey PRIMARY KEY (id);


--
-- Name: meeting_attendees meeting_attendees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendees
    ADD CONSTRAINT meeting_attendees_pkey PRIMARY KEY (meeting_id, contact_id);


--
-- Name: meeting_transcripts meeting_transcripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_transcripts
    ADD CONSTRAINT meeting_transcripts_pkey PRIMARY KEY (id);


--
-- Name: meetings meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_pkey PRIMARY KEY (id);


--
-- Name: merged_contacts_archive merged_contacts_archive_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.merged_contacts_archive
    ADD CONSTRAINT merged_contacts_archive_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: oauth_tokens oauth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_pkey PRIMARY KEY (id);


--
-- Name: oauth_tokens oauth_tokens_user_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_user_id_provider_key UNIQUE (user_id, provider);


--
-- Name: org_action_config org_action_config_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_action_config
    ADD CONSTRAINT org_action_config_org_id_key UNIQUE (org_id);


--
-- Name: org_action_config org_action_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_action_config
    ADD CONSTRAINT org_action_config_pkey PRIMARY KEY (id);


--
-- Name: org_hierarchy org_hierarchy_org_user_reports_to_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_hierarchy
    ADD CONSTRAINT org_hierarchy_org_user_reports_to_key UNIQUE (org_id, user_id, reports_to);


--
-- Name: org_hierarchy org_hierarchy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_hierarchy
    ADD CONSTRAINT org_hierarchy_pkey PRIMARY KEY (id);


--
-- Name: org_integrations org_integrations_org_id_integration_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_integrations
    ADD CONSTRAINT org_integrations_org_id_integration_type_key UNIQUE (org_id, integration_type);


--
-- Name: org_integrations org_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_integrations
    ADD CONSTRAINT org_integrations_pkey PRIMARY KEY (id);


--
-- Name: org_invitations org_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_pkey PRIMARY KEY (id);


--
-- Name: org_invitations org_invitations_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_token_key UNIQUE (token);


--
-- Name: org_invites org_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_pkey PRIMARY KEY (id);


--
-- Name: org_invites org_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_token_key UNIQUE (token);


--
-- Name: org_roles org_roles_org_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_roles
    ADD CONSTRAINT org_roles_org_id_key_key UNIQUE (org_id, key);


--
-- Name: org_roles org_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_roles
    ADD CONSTRAINT org_roles_pkey PRIMARY KEY (id);


--
-- Name: org_users org_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_users
    ADD CONSTRAINT org_users_pkey PRIMARY KEY (org_id, user_id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_key UNIQUE (slug);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: pipeline_stages pipeline_stages_org_id_pipeline_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_stages
    ADD CONSTRAINT pipeline_stages_org_id_pipeline_key_key UNIQUE (org_id, pipeline, key);


--
-- Name: pipeline_stages pipeline_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_stages
    ADD CONSTRAINT pipeline_stages_pkey PRIMARY KEY (id);


--
-- Name: platform_esign_tokens platform_esign_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_esign_tokens
    ADD CONSTRAINT platform_esign_tokens_pkey PRIMARY KEY (provider);


--
-- Name: platform_settings platform_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_pkey PRIMARY KEY (key);


--
-- Name: playbook_play_roles playbook_play_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_play_roles
    ADD CONSTRAINT playbook_play_roles_pkey PRIMARY KEY (id);


--
-- Name: playbook_play_roles playbook_play_roles_play_id_role_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_play_roles
    ADD CONSTRAINT playbook_play_roles_play_id_role_id_key UNIQUE (play_id, role_id);


--
-- Name: playbook_plays playbook_plays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_plays
    ADD CONSTRAINT playbook_plays_pkey PRIMARY KEY (id);


--
-- Name: playbook_registrations playbook_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_registrations
    ADD CONSTRAINT playbook_registrations_pkey PRIMARY KEY (id);


--
-- Name: playbook_roles playbook_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_roles
    ADD CONSTRAINT playbook_roles_pkey PRIMARY KEY (id);


--
-- Name: playbook_roles playbook_roles_playbook_id_role_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_roles
    ADD CONSTRAINT playbook_roles_playbook_id_role_id_key UNIQUE (playbook_id, role_id);


--
-- Name: playbook_stages playbook_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_stages
    ADD CONSTRAINT playbook_stages_pkey PRIMARY KEY (id);


--
-- Name: playbook_stages playbook_stages_playbook_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_stages
    ADD CONSTRAINT playbook_stages_playbook_id_key_key UNIQUE (playbook_id, key);


--
-- Name: playbook_teams playbook_teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_teams
    ADD CONSTRAINT playbook_teams_pkey PRIMARY KEY (playbook_id, team_id);


--
-- Name: playbook_user_access playbook_user_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_user_access
    ADD CONSTRAINT playbook_user_access_pkey PRIMARY KEY (playbook_id, user_id);


--
-- Name: playbook_versions playbook_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_versions
    ADD CONSTRAINT playbook_versions_pkey PRIMARY KEY (id);


--
-- Name: playbook_versions playbook_versions_playbook_id_version_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_versions
    ADD CONSTRAINT playbook_versions_playbook_id_version_number_key UNIQUE (playbook_id, version_number);


--
-- Name: playbooks playbooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_pkey PRIMARY KEY (id);


--
-- Name: product_catalog product_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_catalog
    ADD CONSTRAINT product_catalog_pkey PRIMARY KEY (id);


--
-- Name: product_groups product_groups_org_id_parent_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_groups
    ADD CONSTRAINT product_groups_org_id_parent_id_name_key UNIQUE (org_id, parent_id, name);


--
-- Name: product_groups product_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_groups
    ADD CONSTRAINT product_groups_pkey PRIMARY KEY (id);


--
-- Name: prompts prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompts
    ADD CONSTRAINT prompts_pkey PRIMARY KEY (id);


--
-- Name: proposals proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_pkey PRIMARY KEY (id);


--
-- Name: prospecting_actions prospecting_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_actions
    ADD CONSTRAINT prospecting_actions_pkey PRIMARY KEY (id);


--
-- Name: prospecting_activities prospecting_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_activities
    ADD CONSTRAINT prospecting_activities_pkey PRIMARY KEY (id);


--
-- Name: prospecting_campaigns prospecting_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_campaigns
    ADD CONSTRAINT prospecting_campaigns_pkey PRIMARY KEY (id);


--
-- Name: prospecting_edit_grants prospecting_edit_grants_org_id_owner_id_manager_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_edit_grants
    ADD CONSTRAINT prospecting_edit_grants_org_id_owner_id_manager_id_key UNIQUE (org_id, owner_id, manager_id);


--
-- Name: prospecting_edit_grants prospecting_edit_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_edit_grants
    ADD CONSTRAINT prospecting_edit_grants_pkey PRIMARY KEY (id);


--
-- Name: prospecting_insights prospecting_insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_insights
    ADD CONSTRAINT prospecting_insights_pkey PRIMARY KEY (id);


--
-- Name: prospecting_metric_daily prospecting_metric_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_metric_daily
    ADD CONSTRAINT prospecting_metric_daily_pkey PRIMARY KEY (id);


--
-- Name: prospecting_sender_accounts prospecting_sender_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_sender_accounts
    ADD CONSTRAINT prospecting_sender_accounts_pkey PRIMARY KEY (id);


--
-- Name: prospects prospects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospects
    ADD CONSTRAINT prospects_pkey PRIMARY KEY (id);


--
-- Name: rule_violations rule_violations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rule_violations
    ADD CONSTRAINT rule_violations_pkey PRIMARY KEY (id);


--
-- Name: sales_handover_commitments sales_handover_commitments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_commitments
    ADD CONSTRAINT sales_handover_commitments_pkey PRIMARY KEY (id);


--
-- Name: sales_handover_plays sales_handover_plays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_plays
    ADD CONSTRAINT sales_handover_plays_pkey PRIMARY KEY (id);


--
-- Name: sales_handover_plays sales_handover_plays_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_plays
    ADD CONSTRAINT sales_handover_plays_unique UNIQUE (handover_id, play_instance_id);


--
-- Name: sales_handover_stakeholders sales_handover_stakeholders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_stakeholders
    ADD CONSTRAINT sales_handover_stakeholders_pkey PRIMARY KEY (id);


--
-- Name: sales_handovers sales_handovers_deal_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handovers
    ADD CONSTRAINT sales_handovers_deal_unique UNIQUE (deal_id);


--
-- Name: sales_handovers sales_handovers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handovers
    ADD CONSTRAINT sales_handovers_pkey PRIMARY KEY (id);


--
-- Name: sequence_enrollments sequence_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_enrollments
    ADD CONSTRAINT sequence_enrollments_pkey PRIMARY KEY (id);


--
-- Name: sequence_enrollments sequence_enrollments_sequence_id_prospect_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_enrollments
    ADD CONSTRAINT sequence_enrollments_sequence_id_prospect_id_key UNIQUE (sequence_id, prospect_id);


--
-- Name: sequence_step_logs sequence_step_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_step_logs
    ADD CONSTRAINT sequence_step_logs_pkey PRIMARY KEY (id);


--
-- Name: sequence_steps sequence_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_steps
    ADD CONSTRAINT sequence_steps_pkey PRIMARY KEY (id);


--
-- Name: sequence_steps sequence_steps_sequence_id_step_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_steps
    ADD CONSTRAINT sequence_steps_sequence_id_step_order_key UNIQUE (sequence_id, step_order);


--
-- Name: sequences sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequences
    ADD CONSTRAINT sequences_pkey PRIMARY KEY (id);


--
-- Name: sf_activity_log sf_activity_log_org_id_sf_object_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sf_activity_log
    ADD CONSTRAINT sf_activity_log_org_id_sf_object_id_key UNIQUE (org_id, sf_object_id);


--
-- Name: sf_activity_log sf_activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sf_activity_log
    ADD CONSTRAINT sf_activity_log_pkey PRIMARY KEY (id);


--
-- Name: skill_prompt_versions skill_prompt_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_prompt_versions
    ADD CONSTRAINT skill_prompt_versions_pkey PRIMARY KEY (hash);


--
-- Name: skill_runs skill_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_runs
    ADD CONSTRAINT skill_runs_pkey PRIMARY KEY (id);


--
-- Name: sla_tiers sla_tiers_org_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sla_tiers
    ADD CONSTRAINT sla_tiers_org_id_name_key UNIQUE (org_id, name);


--
-- Name: sla_tiers sla_tiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sla_tiers
    ADD CONSTRAINT sla_tiers_pkey PRIMARY KEY (id);


--
-- Name: storage_files storage_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_files
    ADD CONSTRAINT storage_files_pkey PRIMARY KEY (id);


--
-- Name: strap_actions strap_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strap_actions
    ADD CONSTRAINT strap_actions_pkey PRIMARY KEY (id);


--
-- Name: strap_actions strap_actions_strap_id_action_table_action_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strap_actions
    ADD CONSTRAINT strap_actions_strap_id_action_table_action_id_key UNIQUE (strap_id, action_table, action_id);


--
-- Name: straps straps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.straps
    ADD CONSTRAINT straps_pkey PRIMARY KEY (id);


--
-- Name: super_admin_audit_log super_admin_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.super_admin_audit_log
    ADD CONSTRAINT super_admin_audit_log_pkey PRIMARY KEY (id);


--
-- Name: super_admins super_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.super_admins
    ADD CONSTRAINT super_admins_pkey PRIMARY KEY (id);


--
-- Name: super_admins super_admins_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.super_admins
    ADD CONSTRAINT super_admins_user_id_key UNIQUE (user_id);


--
-- Name: team_dimensions team_dimensions_org_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_dimensions
    ADD CONSTRAINT team_dimensions_org_key_unique UNIQUE (org_id, key);


--
-- Name: team_dimensions team_dimensions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_dimensions
    ADD CONSTRAINT team_dimensions_pkey PRIMARY KEY (id);


--
-- Name: team_memberships team_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT team_memberships_pkey PRIMARY KEY (id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: tracking_domains tracking_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tracking_domains
    ADD CONSTRAINT tracking_domains_pkey PRIMARY KEY (id);


--
-- Name: deal_health_config uq_deal_health_config_user_org; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_health_config
    ADD CONSTRAINT uq_deal_health_config_user_org UNIQUE (user_id, org_id);


--
-- Name: storage_files uq_storage_file_deal; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_files
    ADD CONSTRAINT uq_storage_file_deal UNIQUE (user_id, provider, provider_file_id, deal_id);


--
-- Name: team_memberships uq_team_memberships_user_team; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT uq_team_memberships_user_team UNIQUE (user_id, team_id);


--
-- Name: teams uq_teams_org_dimension_name; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT uq_teams_org_dimension_name UNIQUE (org_id, dimension, name);


--
-- Name: user_linkedin_seats user_linkedin_seats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_linkedin_seats
    ADD CONSTRAINT user_linkedin_seats_pkey PRIMARY KEY (id);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id, org_id);


--
-- Name: user_prompts user_prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_prompts
    ADD CONSTRAINT user_prompts_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: workflow_branches workflow_branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_branches
    ADD CONSTRAINT workflow_branches_pkey PRIMARY KEY (id);


--
-- Name: workflow_executions workflow_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_executions
    ADD CONSTRAINT workflow_executions_pkey PRIMARY KEY (id);


--
-- Name: workflow_rules workflow_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_rules
    ADD CONSTRAINT workflow_rules_pkey PRIMARY KEY (id);


--
-- Name: workflow_steps workflow_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_steps
    ADD CONSTRAINT workflow_steps_pkey PRIMARY KEY (id);


--
-- Name: workflows workflows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);


--
-- Name: ai_credentials_org_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_credentials_org_provider_idx ON public.org_credentials USING btree (org_id, provider) WHERE ((user_id IS NULL) AND (status = 'active'::text));


--
-- Name: ai_credentials_unique_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_credentials_unique_active ON public.org_credentials USING btree (org_id, COALESCE(user_id, 0), provider) WHERE (status = 'active'::text);


--
-- Name: ai_credentials_user_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_credentials_user_provider_idx ON public.org_credentials USING btree (org_id, user_id, provider) WHERE ((user_id IS NOT NULL) AND (status = 'active'::text));


--
-- Name: ai_token_usage_billing_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_token_usage_billing_idx ON public.ai_token_usage USING btree (org_id, key_source, created_at);


--
-- Name: deals_playbook_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_playbook_id ON public.deals USING btree (playbook_id);


--
-- Name: discovered_models_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX discovered_models_provider_idx ON public.discovered_models USING btree (provider);


--
-- Name: emails_external_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX emails_external_id_unique ON public.emails USING btree (external_id) WHERE (external_id IS NOT NULL);


--
-- Name: idx_account_team_members_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_team_members_contact ON public.account_team_members USING btree (contact_id, org_id);


--
-- Name: idx_account_team_members_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_team_members_team ON public.account_team_members USING btree (account_team_id);


--
-- Name: idx_account_teams_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_teams_account ON public.account_teams USING btree (account_id, org_id, is_active);


--
-- Name: idx_account_teams_dimension; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_account_teams_dimension ON public.account_teams USING btree (org_id, dimension);


--
-- Name: idx_accounts_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_client_id ON public.accounts USING btree (client_id) WHERE (client_id IS NOT NULL);


--
-- Name: idx_accounts_external_refs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_external_refs ON public.accounts USING gin (external_refs);


--
-- Name: idx_accounts_needs_domain_review; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_needs_domain_review ON public.accounts USING btree (org_id) WHERE (needs_domain_review = true);


--
-- Name: idx_accounts_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_org ON public.accounts USING btree (org_id);


--
-- Name: idx_accounts_research_meta_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_research_meta_provider ON public.accounts USING gin (research_meta);


--
-- Name: idx_accounts_research_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_research_updated_at ON public.accounts USING btree (research_updated_at) WHERE (research_updated_at IS NOT NULL);


--
-- Name: idx_accounts_revisit_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_revisit_date ON public.accounts USING btree (org_id, account_revisit_date) WHERE (account_revisit_date IS NOT NULL);


--
-- Name: idx_accounts_sla_tier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_accounts_sla_tier ON public.accounts USING btree (sla_tier_id) WHERE (sla_tier_id IS NOT NULL);


--
-- Name: idx_acct_hierarchy_child; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_acct_hierarchy_child ON public.account_hierarchy USING btree (org_id, child_account_id);


--
-- Name: idx_acct_hierarchy_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_acct_hierarchy_parent ON public.account_hierarchy USING btree (org_id, parent_account_id);


--
-- Name: idx_action_config_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_action_config_org ON public.action_config USING btree (org_id);


--
-- Name: idx_action_config_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_action_config_user ON public.action_config USING btree (user_id);


--
-- Name: idx_action_suggestions_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_action_suggestions_action ON public.action_suggestions USING btree (action_id);


--
-- Name: idx_action_suggestions_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_action_suggestions_org ON public.action_suggestions USING btree (org_id);


--
-- Name: idx_action_suggestions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_action_suggestions_status ON public.action_suggestions USING btree (action_id, status);


--
-- Name: idx_action_suggestions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_action_suggestions_user ON public.action_suggestions USING btree (user_id, status);


--
-- Name: idx_actions_case_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_case_id ON public.actions USING btree (case_id) WHERE (case_id IS NOT NULL);


--
-- Name: idx_actions_completed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_completed ON public.actions USING btree (completed);


--
-- Name: idx_actions_contract_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_contract_id ON public.actions USING btree (contract_id) WHERE (contract_id IS NOT NULL);


--
-- Name: idx_actions_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_deal ON public.actions USING btree (deal_id);


--
-- Name: idx_actions_deal_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_deal_open ON public.actions USING btree (deal_id) WHERE ((deal_id IS NOT NULL) AND ((status)::text <> 'completed'::text));


--
-- Name: idx_actions_deal_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_deal_stage ON public.actions USING btree (deal_id, deal_stage);


--
-- Name: idx_actions_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_due_date ON public.actions USING btree (due_date);


--
-- Name: idx_actions_due_date_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_due_date_open ON public.actions USING btree (due_date, org_id) WHERE ((status)::text <> 'completed'::text);


--
-- Name: idx_actions_escalation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_escalation ON public.actions USING btree (org_id, user_id, status, due_date) WHERE (((status)::text = 'pending'::text) AND (due_date IS NOT NULL));


--
-- Name: idx_actions_external_refs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_external_refs ON public.actions USING gin (external_refs);


--
-- Name: idx_actions_keywords; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_keywords ON public.actions USING gin (keywords);


--
-- Name: idx_actions_notification; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_notification ON public.actions USING btree (org_id, user_id, status, due_date) WHERE (((status)::text = 'pending'::text) AND (due_date IS NOT NULL));


--
-- Name: idx_actions_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_open ON public.actions USING btree (deal_id, completed) WHERE (completed = false);


--
-- Name: idx_actions_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_org ON public.actions USING btree (org_id);


--
-- Name: idx_actions_org_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_org_deal ON public.actions USING btree (org_id, deal_id);


--
-- Name: idx_actions_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_org_status ON public.actions USING btree (org_id, status);


--
-- Name: idx_actions_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_org_user ON public.actions USING btree (org_id, user_id);


--
-- Name: idx_actions_org_user_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_org_user_open ON public.actions USING btree (org_id, user_id, status) WHERE ((status)::text <> 'completed'::text);


--
-- Name: idx_actions_org_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_org_user_status ON public.actions USING btree (org_id, user_id, status);


--
-- Name: idx_actions_playbook_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_playbook_id ON public.actions USING btree (playbook_id) WHERE (playbook_id IS NOT NULL);


--
-- Name: idx_actions_playbook_play; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_playbook_play ON public.actions USING btree (playbook_play_id) WHERE (playbook_play_id IS NOT NULL);


--
-- Name: idx_actions_snoozed_until; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_snoozed_until ON public.actions USING btree (snoozed_until) WHERE (snoozed_until IS NOT NULL);


--
-- Name: idx_actions_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_source ON public.actions USING btree (source);


--
-- Name: idx_actions_source_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_source_module ON public.actions USING btree (org_id, source_module) WHERE (source_module IS NOT NULL);


--
-- Name: idx_actions_source_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_source_rule ON public.actions USING btree (deal_id, user_id, source_rule) WHERE ((completed = false) AND (source_rule IS NOT NULL));


--
-- Name: idx_actions_strap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_strap_id ON public.actions USING btree (strap_id) WHERE (strap_id IS NOT NULL);


--
-- Name: idx_actions_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_type ON public.actions USING btree (action_type);


--
-- Name: idx_actions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_user ON public.actions USING btree (user_id);


--
-- Name: idx_actions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_actions_user_id ON public.actions USING btree (user_id);


--
-- Name: idx_agent_proposals_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_proposals_created ON public.agent_proposals USING btree (created_at DESC);


--
-- Name: idx_agent_proposals_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_proposals_deal ON public.agent_proposals USING btree (deal_id) WHERE (deal_id IS NOT NULL);


--
-- Name: idx_agent_proposals_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_proposals_expires ON public.agent_proposals USING btree (expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: idx_agent_proposals_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_proposals_org_status ON public.agent_proposals USING btree (org_id, status);


--
-- Name: idx_agent_proposals_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_proposals_org_user ON public.agent_proposals USING btree (org_id, user_id);


--
-- Name: idx_agent_proposals_user_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_proposals_user_pending ON public.agent_proposals USING btree (user_id, status) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_ai_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_log_created_at ON public.ai_processing_log USING btree (created_at);


--
-- Name: idx_ai_log_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_log_user_id ON public.ai_processing_log USING btree (user_id);


--
-- Name: idx_ai_processing_log_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_processing_log_org ON public.ai_processing_log USING btree (org_id);


--
-- Name: idx_ai_token_usage_call_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_token_usage_call_type ON public.ai_token_usage USING btree (call_type);


--
-- Name: idx_ai_token_usage_org_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_token_usage_org_date ON public.ai_token_usage USING btree (org_id, created_at DESC);


--
-- Name: idx_ai_token_usage_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_token_usage_org_user ON public.ai_token_usage USING btree (org_id, user_id);


--
-- Name: idx_ai_token_usage_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_token_usage_user_date ON public.ai_token_usage USING btree (user_id, created_at DESC);


--
-- Name: idx_cacfg_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cacfg_org ON public.contract_approval_config USING btree (org_id);


--
-- Name: idx_calendar_sync_history_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_sync_history_org ON public.calendar_sync_history USING btree (org_id);


--
-- Name: idx_calendar_sync_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_sync_status ON public.calendar_sync_history USING btree (status);


--
-- Name: idx_calendar_sync_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_sync_user ON public.calendar_sync_history USING btree (user_id);


--
-- Name: idx_calls_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_account ON public.calls USING btree (account_id, occurred_at DESC) WHERE (account_id IS NOT NULL);


--
-- Name: idx_calls_callback_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_callback_due ON public.calls USING btree (org_id, callback_requested_at) WHERE (callback_requested_at IS NOT NULL);


--
-- Name: idx_calls_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_contact ON public.calls USING btree (contact_id, occurred_at DESC) WHERE (contact_id IS NOT NULL);


--
-- Name: idx_calls_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_deal ON public.calls USING btree (deal_id, occurred_at DESC) WHERE (deal_id IS NOT NULL);


--
-- Name: idx_calls_org_outcome; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_org_outcome ON public.calls USING btree (org_id, outcome);


--
-- Name: idx_calls_prospect; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_prospect ON public.calls USING btree (prospect_id, occurred_at DESC) WHERE (prospect_id IS NOT NULL);


--
-- Name: idx_calls_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_status ON public.calls USING btree (org_id, status) WHERE ((status)::text <> ALL ((ARRAY['logged'::character varying, 'completed'::character varying])::text[]));


--
-- Name: idx_calls_step_log; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_step_log ON public.calls USING btree (sequence_step_log_id) WHERE (sequence_step_log_id IS NOT NULL);


--
-- Name: idx_calls_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calls_user ON public.calls USING btree (user_id, occurred_at DESC);


--
-- Name: idx_campaigns_with_config_override; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaigns_with_config_override ON public.prospecting_campaigns USING btree (((prospecting_config_override IS NOT NULL))) WHERE (prospecting_config_override IS NOT NULL);


--
-- Name: idx_campaigns_with_schedule_override; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaigns_with_schedule_override ON public.prospecting_campaigns USING btree ((((daily_activation_cap IS NOT NULL) OR (send_window_start_hour IS NOT NULL)))) WHERE ((daily_activation_cap IS NOT NULL) OR (send_window_start_hour IS NOT NULL));


--
-- Name: idx_cappr_approver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cappr_approver ON public.contract_approvals USING btree (approver_user_id) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_cappr_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cappr_contract ON public.contract_approvals USING btree (contract_id);


--
-- Name: idx_case_history_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_case_history_case ON public.case_status_history USING btree (case_id);


--
-- Name: idx_case_history_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_case_history_org ON public.case_status_history USING btree (org_id);


--
-- Name: idx_case_notes_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_case_notes_author ON public.case_notes USING btree (author_id);


--
-- Name: idx_case_notes_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_case_notes_case ON public.case_notes USING btree (case_id);


--
-- Name: idx_case_notes_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_case_notes_org ON public.case_notes USING btree (org_id);


--
-- Name: idx_case_plays_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_case_plays_action ON public.case_plays USING btree (action_id) WHERE (action_id IS NOT NULL);


--
-- Name: idx_case_plays_case; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_case_plays_case ON public.case_plays USING btree (case_id);


--
-- Name: idx_case_plays_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_case_plays_org ON public.case_plays USING btree (org_id);


--
-- Name: idx_case_plays_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_case_plays_user ON public.case_plays USING btree (assigned_to);


--
-- Name: idx_cases_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cases_account ON public.cases USING btree (account_id);


--
-- Name: idx_cases_assigned_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cases_assigned_to ON public.cases USING btree (assigned_to);


--
-- Name: idx_cases_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cases_client_id ON public.cases USING btree (client_id) WHERE (client_id IS NOT NULL);


--
-- Name: idx_cases_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cases_contact ON public.cases USING btree (contact_id);


--
-- Name: idx_cases_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cases_created_by ON public.cases USING btree (created_by);


--
-- Name: idx_cases_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cases_deal ON public.cases USING btree (deal_id);


--
-- Name: idx_cases_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cases_org ON public.cases USING btree (org_id);


--
-- Name: idx_cases_sla; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cases_sla ON public.cases USING btree (org_id, response_due_at, resolution_due_at);


--
-- Name: idx_cases_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cases_status ON public.cases USING btree (org_id, status);


--
-- Name: idx_cases_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cases_team ON public.cases USING btree (assigned_team_id);


--
-- Name: idx_cdl_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cdl_contact ON public.contact_dotted_lines USING btree (contact_id);


--
-- Name: idx_cdl_manager; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cdl_manager ON public.contact_dotted_lines USING btree (dotted_manager_id);


--
-- Name: idx_cdl_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cdl_org ON public.contact_dotted_lines USING btree (org_id);


--
-- Name: idx_cdv_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cdv_contract ON public.contract_document_versions USING btree (contract_id);


--
-- Name: idx_cdv_current; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cdv_current ON public.contract_document_versions USING btree (contract_id, is_current);


--
-- Name: idx_cev_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cev_contract ON public.contract_events USING btree (contract_id, created_at DESC);


--
-- Name: idx_client_activities_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_activities_client_id ON public.client_activities USING btree (client_id);


--
-- Name: idx_client_activities_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_activities_created_at ON public.client_activities USING btree (client_id, created_at DESC);


--
-- Name: idx_client_team_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_team_client_id ON public.client_team_members USING btree (client_id);


--
-- Name: idx_client_team_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_client_team_user_id ON public.client_team_members USING btree (user_id);


--
-- Name: idx_clients_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clients_account_id ON public.clients USING btree (account_id);


--
-- Name: idx_clients_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clients_org_id ON public.clients USING btree (org_id);


--
-- Name: idx_clients_report_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clients_report_token ON public.clients USING btree (report_token) WHERE (report_token IS NOT NULL);


--
-- Name: idx_competitors_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competitors_org ON public.competitors USING btree (org_id);


--
-- Name: idx_competitors_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competitors_org_id ON public.competitors USING btree (org_id);


--
-- Name: idx_competitors_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_competitors_user ON public.competitors USING btree (user_id);


--
-- Name: idx_contact_activities_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_activities_contact ON public.contact_activities USING btree (contact_id);


--
-- Name: idx_contact_activities_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_activities_created ON public.contact_activities USING btree (created_at);


--
-- Name: idx_contact_identities_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_identities_contact ON public.contact_identities USING btree (canonical_contact_id) WHERE (canonical_contact_id IS NOT NULL);


--
-- Name: idx_contact_identities_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_identities_lookup ON public.contact_identities USING btree (org_id, identity_type, identity_value);


--
-- Name: idx_contact_identities_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_identities_pending ON public.contact_identities USING btree (org_id, status) WHERE ((status)::text = 'pending_review'::text);


--
-- Name: idx_contact_identities_prospect; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_identities_prospect ON public.contact_identities USING btree (canonical_prospect_id) WHERE (canonical_prospect_id IS NOT NULL);


--
-- Name: idx_contacts_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_account ON public.contacts USING btree (account_id);


--
-- Name: idx_contacts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_email ON public.contacts USING btree (email);


--
-- Name: idx_contacts_email_snoozed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_email_snoozed ON public.contacts USING btree (org_id, email_snoozed) WHERE (email_snoozed = true);


--
-- Name: idx_contacts_external_refs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_external_refs ON public.contacts USING gin (external_refs);


--
-- Name: idx_contacts_last_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_last_contact ON public.contacts USING btree (last_contact_date);


--
-- Name: idx_contacts_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_org ON public.contacts USING btree (org_id);


--
-- Name: idx_contacts_org_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_org_account ON public.contacts USING btree (org_id, account_id);


--
-- Name: idx_contacts_org_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_org_email ON public.contacts USING btree (org_id, email);


--
-- Name: idx_contacts_reports_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_reports_to ON public.contacts USING btree (reports_to_contact_id) WHERE (reports_to_contact_id IS NOT NULL);


--
-- Name: idx_contacts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_user_id ON public.contacts USING btree (user_id);


--
-- Name: idx_contract_plays_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contract_plays_contract ON public.contract_plays USING btree (contract_id);


--
-- Name: idx_contract_plays_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contract_plays_org_status ON public.contract_plays USING btree (org_id, status);


--
-- Name: idx_contract_plays_play; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contract_plays_play ON public.contract_plays USING btree (play_id);


--
-- Name: idx_contract_templates_org_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contract_templates_org_type ON public.contract_templates USING btree (org_id, contract_type) WHERE (is_active = true);


--
-- Name: idx_contracts_assignee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contracts_assignee ON public.contracts USING btree (legal_assignee_id) WHERE (legal_assignee_id IS NOT NULL);


--
-- Name: idx_contracts_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contracts_deal ON public.contracts USING btree (deal_id);


--
-- Name: idx_contracts_esign_request_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contracts_esign_request_id ON public.contracts USING btree (esign_request_id) WHERE (esign_request_id IS NOT NULL);


--
-- Name: idx_contracts_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contracts_expiry ON public.contracts USING btree (expiry_date) WHERE ((status)::text = 'active'::text);


--
-- Name: idx_contracts_in_review_sub_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contracts_in_review_sub_status ON public.contracts USING btree (org_id, review_sub_status) WHERE ((status)::text = 'in_review'::text);


--
-- Name: idx_contracts_legal_q; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contracts_legal_q ON public.contracts USING btree (org_id, legal_queue) WHERE ((status)::text = 'in_legal_review'::text);


--
-- Name: idx_contracts_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contracts_org ON public.contracts USING btree (org_id);


--
-- Name: idx_contracts_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contracts_owner ON public.contracts USING btree (owner_id);


--
-- Name: idx_contracts_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contracts_parent ON public.contracts USING btree (parent_contract_id) WHERE (parent_contract_id IS NOT NULL);


--
-- Name: idx_contracts_playbook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contracts_playbook ON public.contracts USING btree (playbook_id) WHERE (playbook_id IS NOT NULL);


--
-- Name: idx_contracts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contracts_status ON public.contracts USING btree (status);


--
-- Name: idx_cpi_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cpi_action ON public.contract_play_instances USING btree (action_id) WHERE (action_id IS NOT NULL);


--
-- Name: idx_cpi_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cpi_contract ON public.contract_play_instances USING btree (contract_id, stage_key);


--
-- Name: idx_cpi_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cpi_org ON public.contract_play_instances USING btree (org_id);


--
-- Name: idx_cpi_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cpi_status ON public.contract_play_instances USING btree (contract_id, status);


--
-- Name: idx_csig_contract; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_csig_contract ON public.contract_signatories USING btree (contract_id);


--
-- Name: idx_deal_activities_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_activities_created ON public.deal_activities USING btree (created_at);


--
-- Name: idx_deal_activities_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_activities_deal ON public.deal_activities USING btree (deal_id);


--
-- Name: idx_deal_health_config_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_health_config_org ON public.deal_health_config USING btree (org_id);


--
-- Name: idx_deal_health_config_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_health_config_org_id ON public.deal_health_config USING btree (org_id);


--
-- Name: idx_deal_plays_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_plays_action ON public.deal_play_instances USING btree (action_id) WHERE (action_id IS NOT NULL);


--
-- Name: idx_deal_plays_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_plays_deal ON public.deal_play_instances USING btree (deal_id, stage_key);


--
-- Name: idx_deal_plays_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_plays_org ON public.deal_play_instances USING btree (org_id);


--
-- Name: idx_deal_plays_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_plays_status ON public.deal_play_instances USING btree (deal_id, status);


--
-- Name: idx_deal_plays_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_deal_plays_unique ON public.deal_play_instances USING btree (deal_id, play_id) WHERE (play_id IS NOT NULL);


--
-- Name: idx_deal_products_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_products_deal ON public.deal_products USING btree (deal_id);


--
-- Name: idx_deal_products_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_products_org ON public.deal_products USING btree (org_id);


--
-- Name: idx_deal_products_prod; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_products_prod ON public.deal_products USING btree (product_id);


--
-- Name: idx_deal_team_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_team_deal ON public.deal_team_members USING btree (deal_id);


--
-- Name: idx_deal_team_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_team_org ON public.deal_team_members USING btree (org_id);


--
-- Name: idx_deal_team_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deal_team_user ON public.deal_team_members USING btree (user_id);


--
-- Name: idx_deals_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_account ON public.deals USING btree (account_id);


--
-- Name: idx_deals_close_push; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_close_push ON public.deals USING btree (close_date_push_count);


--
-- Name: idx_deals_expected_close; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_expected_close ON public.deals USING btree (expected_close_date);


--
-- Name: idx_deals_external_refs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_external_refs ON public.deals USING gin (external_refs);


--
-- Name: idx_deals_handover_playbook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_handover_playbook ON public.deals USING btree (handover_playbook_id) WHERE (handover_playbook_id IS NOT NULL);


--
-- Name: idx_deals_health_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_health_score ON public.deals USING btree (health_score);


--
-- Name: idx_deals_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_org ON public.deals USING btree (org_id);


--
-- Name: idx_deals_org_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_org_owner ON public.deals USING btree (org_id, owner_id);


--
-- Name: idx_deals_org_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_org_stage ON public.deals USING btree (org_id, stage);


--
-- Name: idx_deals_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_owner ON public.deals USING btree (owner_id);


--
-- Name: idx_deals_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_stage ON public.deals USING btree (stage);


--
-- Name: idx_deals_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_user_id ON public.deals USING btree (user_id);


--
-- Name: idx_dpi_playbook_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_dpi_playbook_id ON public.deal_play_instances USING btree (playbook_id) WHERE (playbook_id IS NOT NULL);


--
-- Name: idx_ecf_date_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ecf_date_value ON public.entity_custom_fields USING btree (org_id, entity_type, field_key, value_date) WHERE (value_date IS NOT NULL);


--
-- Name: idx_ecf_number_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ecf_number_value ON public.entity_custom_fields USING btree (org_id, entity_type, field_key, value_number) WHERE (value_number IS NOT NULL);


--
-- Name: idx_ecf_org_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ecf_org_entity ON public.entity_custom_fields USING btree (org_id, entity_type, entity_id);


--
-- Name: idx_ecf_org_type_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ecf_org_type_key ON public.entity_custom_fields USING btree (org_id, entity_type, field_key);


--
-- Name: idx_ede_org_detected; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ede_org_detected ON public.email_delivery_events USING btree (org_id, detected_at);


--
-- Name: idx_ede_prospect; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ede_prospect ON public.email_delivery_events USING btree (prospect_id) WHERE (prospect_id IS NOT NULL);


--
-- Name: idx_eee_org_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eee_org_time ON public.email_engagement_events USING btree (org_id, occurred_at);


--
-- Name: idx_eee_step_log; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eee_step_log ON public.email_engagement_events USING btree (step_log_id);


--
-- Name: idx_email_filter_log_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_filter_log_org ON public.email_filter_log USING btree (org_id, sync_date DESC);


--
-- Name: idx_email_filter_log_reason; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_filter_log_reason ON public.email_filter_log USING btree (org_id, reason, sync_date DESC);


--
-- Name: idx_email_filter_log_sync_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_filter_log_sync_date ON public.email_filter_log USING btree (sync_date);


--
-- Name: idx_email_sync_history_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_sync_history_org ON public.email_sync_history USING btree (org_id);


--
-- Name: idx_email_sync_history_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_sync_history_user ON public.email_sync_history USING btree (user_id, created_at DESC);


--
-- Name: idx_emails_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_contact ON public.emails USING btree (contact_id);


--
-- Name: idx_emails_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_conversation_id ON public.emails USING btree (conversation_id) WHERE (conversation_id IS NOT NULL);


--
-- Name: idx_emails_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_deal ON public.emails USING btree (deal_id);


--
-- Name: idx_emails_deal_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_deal_conversation ON public.emails USING btree (org_id, user_id, deal_id, conversation_id) WHERE ((deal_id IS NOT NULL) AND (conversation_id IS NOT NULL));


--
-- Name: idx_emails_external_data; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_external_data ON public.emails USING gin (external_data);


--
-- Name: idx_emails_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_external_id ON public.emails USING btree (user_id, external_id);


--
-- Name: idx_emails_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_org ON public.emails USING btree (org_id);


--
-- Name: idx_emails_org_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_org_deal ON public.emails USING btree (org_id, deal_id);


--
-- Name: idx_emails_prospect; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_prospect ON public.emails USING btree (prospect_id) WHERE (prospect_id IS NOT NULL);


--
-- Name: idx_emails_prospect_inbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_prospect_inbox ON public.emails USING btree (org_id, sent_at DESC) WHERE (prospect_id IS NOT NULL);


--
-- Name: idx_emails_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_provider ON public.emails USING btree (provider);


--
-- Name: idx_emails_sender_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_sender_account ON public.emails USING btree (sender_account_id) WHERE (sender_account_id IS NOT NULL);


--
-- Name: idx_emails_sent_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_sent_at ON public.emails USING btree (sent_at);


--
-- Name: idx_emails_untagged; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_untagged ON public.emails USING btree (org_id, contact_id) WHERE ((deal_id IS NULL) AND (contact_id IS NOT NULL));


--
-- Name: idx_emails_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emails_user_id ON public.emails USING btree (user_id);


--
-- Name: idx_enrichment_credit_log_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrichment_credit_log_account ON public.enrichment_credit_log USING btree (account_id) WHERE (account_id IS NOT NULL);


--
-- Name: idx_enrichment_credit_log_org_provider_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrichment_credit_log_org_provider_time ON public.enrichment_credit_log USING btree (org_id, provider, occurred_at DESC);


--
-- Name: idx_enrichment_credit_log_org_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrichment_credit_log_org_time ON public.enrichment_credit_log USING btree (org_id, occurred_at DESC);


--
-- Name: idx_enrichment_credit_log_prospect; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrichment_credit_log_prospect ON public.enrichment_credit_log USING btree (prospect_id) WHERE (prospect_id IS NOT NULL);


--
-- Name: idx_enrichment_credit_log_provider_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrichment_credit_log_provider_time ON public.enrichment_credit_log USING btree (provider, occurred_at DESC);


--
-- Name: idx_handover_commitments_handover; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_handover_commitments_handover ON public.sales_handover_commitments USING btree (handover_id, commitment_type);


--
-- Name: idx_handover_plays_handover; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_handover_plays_handover ON public.sales_handover_plays USING btree (handover_id);


--
-- Name: idx_handover_plays_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_handover_plays_instance ON public.sales_handover_plays USING btree (play_instance_id);


--
-- Name: idx_handover_stakeholders_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_handover_stakeholders_contact ON public.sales_handover_stakeholders USING btree (contact_id) WHERE (contact_id IS NOT NULL);


--
-- Name: idx_handover_stakeholders_handover; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_handover_stakeholders_handover ON public.sales_handover_stakeholders USING btree (handover_id);


--
-- Name: idx_linkedin_profiles_activity_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_linkedin_profiles_activity_gin ON public.linkedin_profiles USING gin (activity);


--
-- Name: idx_linkedin_profiles_experience_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_linkedin_profiles_experience_gin ON public.linkedin_profiles USING gin (experience);


--
-- Name: idx_linkedin_profiles_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_linkedin_profiles_org ON public.linkedin_profiles USING btree (org_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_linkedin_profiles_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_linkedin_profiles_slug ON public.linkedin_profiles USING btree (org_id, linkedin_slug) WHERE (deleted_at IS NULL);


--
-- Name: idx_ma_meeting_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ma_meeting_contact ON public.meeting_attendees USING btree (meeting_id, contact_id) WHERE (contact_id IS NOT NULL);


--
-- Name: idx_ma_meeting_prospect; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_ma_meeting_prospect ON public.meeting_attendees USING btree (meeting_id, prospect_id) WHERE (prospect_id IS NOT NULL);


--
-- Name: idx_meeting_attendees_meeting_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meeting_attendees_meeting_org ON public.meeting_attendees USING btree (meeting_id, org_id);


--
-- Name: idx_meeting_attendees_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meeting_attendees_org_id ON public.meeting_attendees USING btree (org_id);


--
-- Name: idx_meeting_attendees_prospect_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meeting_attendees_prospect_id ON public.meeting_attendees USING btree (prospect_id) WHERE (prospect_id IS NOT NULL);


--
-- Name: idx_meeting_transcripts_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meeting_transcripts_org ON public.meeting_transcripts USING btree (org_id);


--
-- Name: idx_meetings_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_account_id ON public.meetings USING btree (account_id) WHERE (account_id IS NOT NULL);


--
-- Name: idx_meetings_action_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_action_id ON public.meetings USING btree (action_id) WHERE (action_id IS NOT NULL);


--
-- Name: idx_meetings_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_external_id ON public.meetings USING btree (external_id);


--
-- Name: idx_meetings_handover_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_handover_id ON public.meetings USING btree (handover_id) WHERE (handover_id IS NOT NULL);


--
-- Name: idx_meetings_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_org ON public.meetings USING btree (org_id);


--
-- Name: idx_meetings_prospect_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_prospect_id ON public.meetings USING btree (prospect_id) WHERE (prospect_id IS NOT NULL);


--
-- Name: idx_meetings_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_source ON public.meetings USING btree (source);


--
-- Name: idx_meetings_start_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_start_time ON public.meetings USING btree (start_time);


--
-- Name: idx_meetings_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_user ON public.meetings USING btree (user_id);


--
-- Name: idx_notif_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notif_org ON public.notifications USING btree (org_id);


--
-- Name: idx_notif_user_all; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notif_user_all ON public.notifications USING btree (user_id, created_at DESC);


--
-- Name: idx_notif_user_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notif_user_unread ON public.notifications USING btree (user_id, created_at DESC) WHERE (read_at IS NULL);


--
-- Name: idx_oauth_tokens_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_tokens_org ON public.oauth_tokens USING btree (org_id);


--
-- Name: idx_oauth_tokens_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_tokens_org_user ON public.oauth_tokens USING btree (org_id, user_id);


--
-- Name: idx_oauth_tokens_user_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_tokens_user_provider ON public.oauth_tokens USING btree (user_id, provider);


--
-- Name: idx_org_action_config_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_action_config_org ON public.org_action_config USING btree (org_id);


--
-- Name: idx_org_credentials_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_credentials_lookup ON public.org_credentials USING btree (org_id, purpose, provider) WHERE (status = 'active'::text);


--
-- Name: idx_org_hierarchy_one_solid; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_org_hierarchy_one_solid ON public.org_hierarchy USING btree (org_id, user_id) WHERE ((relationship_type)::text = 'solid'::text);


--
-- Name: idx_org_hierarchy_org_reports_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_hierarchy_org_reports_to ON public.org_hierarchy USING btree (org_id, reports_to);


--
-- Name: idx_org_hierarchy_org_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_hierarchy_org_user ON public.org_hierarchy USING btree (org_id, user_id);


--
-- Name: idx_org_hierarchy_relationship_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_hierarchy_relationship_type ON public.org_hierarchy USING btree (org_id, relationship_type);


--
-- Name: idx_org_hierarchy_reports_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_hierarchy_reports_to ON public.org_hierarchy USING btree (reports_to);


--
-- Name: idx_org_integrations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_integrations_org ON public.org_integrations USING btree (org_id);


--
-- Name: idx_org_integrations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_integrations_status ON public.org_integrations USING btree (org_id, status);


--
-- Name: idx_org_integrations_sync_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_integrations_sync_status ON public.org_integrations USING btree (integration_type, sync_status);


--
-- Name: idx_org_invitations_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_invitations_email ON public.org_invitations USING btree (email);


--
-- Name: idx_org_invitations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_invitations_org ON public.org_invitations USING btree (org_id);


--
-- Name: idx_org_invitations_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_invitations_token ON public.org_invitations USING btree (token);


--
-- Name: idx_org_roles_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_roles_org ON public.org_roles USING btree (org_id) WHERE (is_active = true);


--
-- Name: idx_org_users_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_users_org_id ON public.org_users USING btree (org_id);


--
-- Name: idx_org_users_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_users_user_id ON public.org_users USING btree (user_id);


--
-- Name: idx_organizations_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organizations_slug ON public.organizations USING btree (slug);


--
-- Name: idx_organizations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organizations_status ON public.organizations USING btree (status);


--
-- Name: idx_pactions_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pactions_due ON public.prospecting_actions USING btree (due_date) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_pactions_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pactions_org ON public.prospecting_actions USING btree (org_id);


--
-- Name: idx_pactions_playbook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pactions_playbook ON public.prospecting_actions USING btree (playbook_id) WHERE (playbook_id IS NOT NULL);


--
-- Name: idx_pactions_prospect; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pactions_prospect ON public.prospecting_actions USING btree (prospect_id);


--
-- Name: idx_pactions_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pactions_scheduled ON public.prospecting_actions USING btree (scheduled_at) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_pactions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pactions_status ON public.prospecting_actions USING btree (org_id, user_id, status);


--
-- Name: idx_pactions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pactions_user ON public.prospecting_actions USING btree (org_id, user_id);


--
-- Name: idx_pactivities_prospect; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pactivities_prospect ON public.prospecting_activities USING btree (prospect_id);


--
-- Name: idx_pe_grants_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pe_grants_lookup ON public.prospecting_edit_grants USING btree (org_id, owner_id, manager_id);


--
-- Name: idx_pi_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pi_org_status ON public.prospecting_insights USING btree (org_id, status, last_seen_at DESC);


--
-- Name: idx_pipeline_stages_org_pipeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pipeline_stages_org_pipeline ON public.pipeline_stages USING btree (org_id, pipeline);


--
-- Name: idx_play_assignees_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_play_assignees_instance ON public.deal_play_assignees USING btree (instance_id);


--
-- Name: idx_play_assignees_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_play_assignees_user ON public.deal_play_assignees USING btree (user_id);


--
-- Name: idx_play_roles_play; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_play_roles_play ON public.playbook_play_roles USING btree (play_id);


--
-- Name: idx_play_roles_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_play_roles_role ON public.playbook_play_roles USING btree (role_id);


--
-- Name: idx_playbook_plays_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_plays_org ON public.playbook_plays USING btree (org_id);


--
-- Name: idx_playbook_plays_playbook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_plays_playbook ON public.playbook_plays USING btree (playbook_id, stage_key, sort_order);


--
-- Name: idx_playbook_plays_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_plays_version ON public.playbook_plays USING btree (playbook_id, version_number);


--
-- Name: idx_playbook_registrations_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_registrations_org_id ON public.playbook_registrations USING btree (org_id);


--
-- Name: idx_playbook_registrations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_registrations_status ON public.playbook_registrations USING btree (status);


--
-- Name: idx_playbook_registrations_submitter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_registrations_submitter ON public.playbook_registrations USING btree (submitter_id);


--
-- Name: idx_playbook_roles_playbook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_roles_playbook ON public.playbook_roles USING btree (playbook_id);


--
-- Name: idx_playbook_roles_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_roles_role ON public.playbook_roles USING btree (role_id);


--
-- Name: idx_playbook_stages_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_stages_org ON public.playbook_stages USING btree (org_id);


--
-- Name: idx_playbook_stages_playbook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_stages_playbook ON public.playbook_stages USING btree (playbook_id);


--
-- Name: idx_playbook_teams_team_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_teams_team_id ON public.playbook_teams USING btree (team_id);


--
-- Name: idx_playbook_user_access_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_user_access_user_id ON public.playbook_user_access USING btree (user_id);


--
-- Name: idx_playbook_versions_playbook_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_versions_playbook_id ON public.playbook_versions USING btree (playbook_id);


--
-- Name: idx_playbook_versions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbook_versions_status ON public.playbook_versions USING btree (status);


--
-- Name: idx_playbooks_current_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbooks_current_version ON public.playbooks USING btree (current_version_id);


--
-- Name: idx_playbooks_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_playbooks_is_active ON public.playbooks USING btree (is_active);


--
-- Name: idx_pmd_org_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pmd_org_date ON public.prospecting_metric_daily USING btree (org_id, metric_date);


--
-- Name: idx_portal_users_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_users_client_id ON public.client_portal_users USING btree (client_id);


--
-- Name: idx_portal_users_invite_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_users_invite_token ON public.client_portal_users USING btree (invite_token) WHERE (invite_token IS NOT NULL);


--
-- Name: idx_portal_users_magic_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_portal_users_magic_token ON public.client_portal_users USING btree (magic_token) WHERE (magic_token IS NOT NULL);


--
-- Name: idx_product_catalog_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_catalog_group ON public.product_catalog USING btree (group_id);


--
-- Name: idx_product_catalog_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_catalog_org ON public.product_catalog USING btree (org_id);


--
-- Name: idx_product_catalog_sku; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_product_catalog_sku ON public.product_catalog USING btree (org_id, sku) WHERE ((sku IS NOT NULL) AND ((sku)::text <> ''::text));


--
-- Name: idx_product_catalog_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_catalog_status ON public.product_catalog USING btree (org_id, status);


--
-- Name: idx_product_groups_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_groups_org ON public.product_groups USING btree (org_id);


--
-- Name: idx_product_groups_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_product_groups_parent ON public.product_groups USING btree (parent_id);


--
-- Name: idx_prompts_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prompts_org ON public.prompts USING btree (org_id);


--
-- Name: idx_proposals_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proposals_org ON public.proposals USING btree (org_id);


--
-- Name: idx_prospecting_actions_escalation_scan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospecting_actions_escalation_scan ON public.prospecting_actions USING btree (org_id, due_date, escalation_tier) WHERE (((status)::text = 'pending'::text) AND (escalation_tier < 3));


--
-- Name: idx_prospecting_actions_immediate_scan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospecting_actions_immediate_scan ON public.prospecting_actions USING btree (org_id, due_date) WHERE (((status)::text = 'pending'::text) AND (notification_sent_at IS NULL));


--
-- Name: idx_prospecting_actions_strap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospecting_actions_strap_id ON public.prospecting_actions USING btree (strap_id) WHERE (strap_id IS NOT NULL);


--
-- Name: idx_prospecting_activities_org_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospecting_activities_org_created ON public.prospecting_activities USING btree (org_id, created_at DESC);


--
-- Name: idx_prospecting_activities_org_prospect_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospecting_activities_org_prospect_type ON public.prospecting_activities USING btree (org_id, prospect_id, activity_type);


--
-- Name: idx_prospecting_campaigns_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospecting_campaigns_org ON public.prospecting_campaigns USING btree (org_id);


--
-- Name: idx_prospecting_campaigns_org_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospecting_campaigns_org_owner ON public.prospecting_campaigns USING btree (org_id, owner_id);


--
-- Name: idx_prospecting_campaigns_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospecting_campaigns_org_status ON public.prospecting_campaigns USING btree (org_id, status);


--
-- Name: idx_prospecting_campaigns_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospecting_campaigns_owner ON public.prospecting_campaigns USING btree (owner_id);


--
-- Name: idx_prospects_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_account ON public.prospects USING btree (account_id) WHERE (account_id IS NOT NULL);


--
-- Name: idx_prospects_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_campaign ON public.prospects USING btree (campaign_id) WHERE (campaign_id IS NOT NULL);


--
-- Name: idx_prospects_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_client_id ON public.prospects USING btree (client_id) WHERE (client_id IS NOT NULL);


--
-- Name: idx_prospects_company_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_company_domain ON public.prospects USING btree (org_id, company_domain);


--
-- Name: idx_prospects_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_contact ON public.prospects USING btree (contact_id) WHERE (contact_id IS NOT NULL);


--
-- Name: idx_prospects_deleted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_deleted ON public.prospects USING btree (org_id, deleted_at);


--
-- Name: idx_prospects_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_email ON public.prospects USING btree (org_id, email);


--
-- Name: idx_prospects_external_refs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_external_refs ON public.prospects USING gin (external_refs);


--
-- Name: idx_prospects_linkedin_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_linkedin_activity ON public.prospects USING gin (linkedin_activity);


--
-- Name: idx_prospects_linkedin_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_linkedin_slug ON public.prospects USING btree (org_id, lower("substring"((linkedin_url)::text, '/in/([^/?#]+)'::text))) WHERE ((linkedin_url IS NOT NULL) AND (deleted_at IS NULL));


--
-- Name: idx_prospects_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_org ON public.prospects USING btree (org_id);


--
-- Name: idx_prospects_org_campaign_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_org_campaign_stage ON public.prospects USING btree (org_id, campaign_id, stage) WHERE (deleted_at IS NULL);


--
-- Name: idx_prospects_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_owner ON public.prospects USING btree (org_id, owner_id);


--
-- Name: idx_prospects_research_meta_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_research_meta_provider ON public.prospects USING gin (research_meta);


--
-- Name: idx_prospects_revisit_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_revisit_date ON public.prospects USING btree (org_id, stage, revisit_date) WHERE (revisit_date IS NOT NULL);


--
-- Name: idx_prospects_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prospects_stage ON public.prospects USING btree (org_id, stage);


--
-- Name: idx_prt_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prt_expires_at ON public.password_reset_tokens USING btree (expires_at);


--
-- Name: idx_prt_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prt_token_hash ON public.password_reset_tokens USING btree (token_hash);


--
-- Name: idx_prt_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prt_user_id ON public.password_reset_tokens USING btree (user_id);


--
-- Name: idx_psa_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_psa_active ON public.prospecting_sender_accounts USING btree (org_id, user_id) WHERE (is_active = true);


--
-- Name: idx_psa_client_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_psa_client_active ON public.prospecting_sender_accounts USING btree (org_id, client_id) WHERE (is_active = true);


--
-- Name: idx_psa_client_email_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_psa_client_email_unique ON public.prospecting_sender_accounts USING btree (client_id, email) WHERE (client_id IS NOT NULL);


--
-- Name: idx_psa_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_psa_org ON public.prospecting_sender_accounts USING btree (org_id);


--
-- Name: idx_psa_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_psa_user ON public.prospecting_sender_accounts USING btree (org_id, user_id);


--
-- Name: idx_psa_user_email_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_psa_user_email_unique ON public.prospecting_sender_accounts USING btree (user_id, email) WHERE (user_id IS NOT NULL);


--
-- Name: idx_rule_violations_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rule_violations_entity ON public.rule_violations USING btree (entity_type, entity_id) WHERE (resolved_at IS NULL);


--
-- Name: idx_rule_violations_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rule_violations_rule ON public.rule_violations USING btree (rule_id, detected_at DESC);


--
-- Name: idx_sa_audit_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sa_audit_admin ON public.super_admin_audit_log USING btree (super_admin_id);


--
-- Name: idx_sa_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sa_audit_created ON public.super_admin_audit_log USING btree (created_at DESC);


--
-- Name: idx_sa_audit_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sa_audit_target ON public.super_admin_audit_log USING btree (target_type, target_id);


--
-- Name: idx_sales_handovers_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_handovers_account ON public.sales_handovers USING btree (account_id, org_id);


--
-- Name: idx_sales_handovers_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_handovers_org_status ON public.sales_handovers USING btree (org_id, status);


--
-- Name: idx_sales_handovers_service_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sales_handovers_service_owner ON public.sales_handovers USING btree (assigned_service_owner_id, status);


--
-- Name: idx_seq_enrollments_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seq_enrollments_org_id ON public.sequence_enrollments USING btree (org_id);


--
-- Name: idx_seq_enrollments_prospect_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seq_enrollments_prospect_id ON public.sequence_enrollments USING btree (prospect_id);


--
-- Name: idx_seq_enrollments_status_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seq_enrollments_status_due ON public.sequence_enrollments USING btree (status, next_step_due) WHERE ((status)::text = 'active'::text);


--
-- Name: idx_seq_step_logs_draft_overdue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seq_step_logs_draft_overdue ON public.sequence_step_logs USING btree (scheduled_send_at) WHERE ((status)::text = 'draft'::text);


--
-- Name: idx_seq_step_logs_enrollment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seq_step_logs_enrollment_id ON public.sequence_step_logs USING btree (enrollment_id);


--
-- Name: idx_seq_step_logs_prospect_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seq_step_logs_prospect_id ON public.sequence_step_logs USING btree (prospect_id);


--
-- Name: idx_seq_step_logs_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seq_step_logs_scheduled ON public.sequence_step_logs USING btree (scheduled_send_at) WHERE ((status)::text = 'scheduled'::text);


--
-- Name: idx_seq_step_logs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seq_step_logs_status ON public.sequence_step_logs USING btree (org_id, status) WHERE ((status)::text = 'draft'::text);


--
-- Name: idx_sequence_step_logs_health; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sequence_step_logs_health ON public.sequence_step_logs USING btree (org_id, status, fired_at DESC) WHERE ((status)::text = ANY ((ARRAY['failed'::character varying, 'draft'::character varying, 'sent'::character varying, 'completed'::character varying])::text[]));


--
-- Name: idx_sequence_steps_sequence_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sequence_steps_sequence_id ON public.sequence_steps USING btree (sequence_id);


--
-- Name: idx_sequences_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sequences_client_id ON public.sequences USING btree (client_id) WHERE (client_id IS NOT NULL);


--
-- Name: idx_sequences_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sequences_org_id ON public.sequences USING btree (org_id);


--
-- Name: idx_sf_activity_log_dir; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sf_activity_log_dir ON public.sf_activity_log USING btree (org_id, direction);


--
-- Name: idx_sf_activity_log_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sf_activity_log_org ON public.sf_activity_log USING btree (org_id, processed_at DESC);


--
-- Name: idx_skill_prompt_versions_skill; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_skill_prompt_versions_skill ON public.skill_prompt_versions USING btree (skill_name, first_seen DESC);


--
-- Name: idx_skill_runs_org_hook; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_skill_runs_org_hook ON public.skill_runs USING btree (org_id, skill_name, hook_category);


--
-- Name: idx_skill_runs_org_prospect; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_skill_runs_org_prospect ON public.skill_runs USING btree (org_id, prospect_id) WHERE (prospect_id IS NOT NULL);


--
-- Name: idx_skill_runs_org_skill_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_skill_runs_org_skill_created ON public.skill_runs USING btree (org_id, skill_name, created_at DESC);


--
-- Name: idx_sla_tiers_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sla_tiers_org ON public.sla_tiers USING btree (org_id) WHERE (is_active = true);


--
-- Name: idx_storage_files_contact_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_files_contact_id ON public.storage_files USING btree (contact_id);


--
-- Name: idx_storage_files_deal_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_files_deal_id ON public.storage_files USING btree (deal_id);


--
-- Name: idx_storage_files_imported; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_files_imported ON public.storage_files USING btree (imported_at DESC);


--
-- Name: idx_storage_files_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_files_org ON public.storage_files USING btree (org_id);


--
-- Name: idx_storage_files_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_files_provider ON public.storage_files USING btree (provider, provider_file_id);


--
-- Name: idx_storage_files_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_storage_files_user_id ON public.storage_files USING btree (user_id);


--
-- Name: idx_strap_actions_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_strap_actions_action ON public.strap_actions USING btree (action_table, action_id);


--
-- Name: idx_strap_actions_strap; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_strap_actions_strap ON public.strap_actions USING btree (strap_id);


--
-- Name: idx_straps_active_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_straps_active_entity ON public.straps USING btree (entity_type, entity_id) WHERE ((status)::text = 'active'::text);


--
-- Name: idx_straps_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_straps_created_at ON public.straps USING btree (created_at DESC);


--
-- Name: idx_straps_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_straps_entity ON public.straps USING btree (entity_type, entity_id);


--
-- Name: idx_straps_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_straps_org_id ON public.straps USING btree (org_id);


--
-- Name: idx_straps_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_straps_status ON public.straps USING btree (status);


--
-- Name: idx_super_admins_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_super_admins_active ON public.super_admins USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_super_admins_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_super_admins_user_id ON public.super_admins USING btree (user_id);


--
-- Name: idx_td_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_td_org ON public.tracking_domains USING btree (org_id, status);


--
-- Name: idx_team_dimensions_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_dimensions_org ON public.team_dimensions USING btree (org_id, is_active, sort_order);


--
-- Name: idx_team_memberships_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_memberships_org ON public.team_memberships USING btree (org_id);


--
-- Name: idx_team_memberships_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_memberships_team ON public.team_memberships USING btree (team_id);


--
-- Name: idx_team_memberships_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_memberships_user ON public.team_memberships USING btree (user_id);


--
-- Name: idx_team_memberships_user_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_memberships_user_org ON public.team_memberships USING btree (user_id, org_id);


--
-- Name: idx_teams_org_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teams_org_active ON public.teams USING btree (org_id, is_active);


--
-- Name: idx_teams_org_dimension; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teams_org_dimension ON public.teams USING btree (org_id, dimension);


--
-- Name: idx_teams_org_role_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teams_org_role_key ON public.teams USING btree (org_id, org_role_key) WHERE ((is_active = true) AND (org_role_key IS NOT NULL));


--
-- Name: idx_teams_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teams_parent ON public.teams USING btree (parent_team_id);


--
-- Name: idx_transcripts_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transcripts_deal ON public.meeting_transcripts USING btree (deal_id);


--
-- Name: idx_transcripts_fulltext; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transcripts_fulltext ON public.meeting_transcripts USING gin (to_tsvector('english'::regconfig, transcript_text));


--
-- Name: idx_transcripts_meeting; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transcripts_meeting ON public.meeting_transcripts USING btree (meeting_id);


--
-- Name: idx_transcripts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transcripts_status ON public.meeting_transcripts USING btree (analysis_status);


--
-- Name: idx_transcripts_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transcripts_user ON public.meeting_transcripts USING btree (user_id);


--
-- Name: idx_user_linkedin_seats_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_linkedin_seats_user ON public.user_linkedin_seats USING btree (org_id, user_id);


--
-- Name: idx_user_preferences_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_preferences_org ON public.user_preferences USING btree (org_id);


--
-- Name: idx_user_prompts_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_prompts_org ON public.user_prompts USING btree (org_id);


--
-- Name: idx_user_prompts_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_prompts_user ON public.user_prompts USING btree (user_id);


--
-- Name: idx_users_department; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_department ON public.users USING btree (department) WHERE (department IS NOT NULL);


--
-- Name: idx_users_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_org ON public.users USING btree (org_id);


--
-- Name: idx_users_twilio_did; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_users_twilio_did ON public.users USING btree (twilio_did) WHERE (twilio_did IS NOT NULL);


--
-- Name: idx_users_twilio_did_sid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_twilio_did_sid ON public.users USING btree (twilio_did_sid) WHERE (twilio_did_sid IS NOT NULL);


--
-- Name: idx_value_history_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_value_history_date ON public.deal_value_history USING btree (changed_at);


--
-- Name: idx_value_history_deal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_value_history_deal ON public.deal_value_history USING btree (deal_id);


--
-- Name: idx_workflow_branches_step; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_branches_step ON public.workflow_branches USING btree (step_id, sort_order);


--
-- Name: idx_workflow_executions_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_entity ON public.workflow_executions USING btree (entity_type, entity_id, started_at DESC);


--
-- Name: idx_workflow_executions_workflow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_workflow ON public.workflow_executions USING btree (workflow_id, started_at DESC);


--
-- Name: idx_workflow_rules_org_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_rules_org_entity ON public.workflow_rules USING btree (org_id, entity, trigger) WHERE ((is_active = true) AND (step_id IS NULL));


--
-- Name: idx_workflow_rules_step; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_rules_step ON public.workflow_rules USING btree (step_id);


--
-- Name: idx_workflow_steps_workflow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_steps_workflow ON public.workflow_steps USING btree (workflow_id, sort_order);


--
-- Name: idx_workflows_org_entity_trigger; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflows_org_entity_trigger ON public.workflows USING btree (org_id, entity, trigger) WHERE (is_active = true);


--
-- Name: org_credentials_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX org_credentials_active_unique ON public.org_credentials USING btree (org_id, purpose, COALESCE(user_id, 0), provider) WHERE (status = 'active'::text);


--
-- Name: org_integrations_org_type_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX org_integrations_org_type_unique ON public.org_integrations USING btree (org_id, integration_type);


--
-- Name: playbooks_org_default_clm; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX playbooks_org_default_clm ON public.playbooks USING btree (org_id) WHERE ((is_default = true) AND ((type)::text = 'clm'::text));


--
-- Name: playbooks_org_default_custom; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX playbooks_org_default_custom ON public.playbooks USING btree (org_id) WHERE ((is_default = true) AND ((type)::text = 'custom'::text));


--
-- Name: playbooks_org_default_handover_s2i; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX playbooks_org_default_handover_s2i ON public.playbooks USING btree (org_id) WHERE ((is_default = true) AND ((type)::text = 'handover_s2i'::text));


--
-- Name: playbooks_org_default_market; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX playbooks_org_default_market ON public.playbooks USING btree (org_id) WHERE ((is_default = true) AND ((type)::text = 'market'::text));


--
-- Name: playbooks_org_default_product; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX playbooks_org_default_product ON public.playbooks USING btree (org_id) WHERE ((is_default = true) AND ((type)::text = 'product'::text));


--
-- Name: playbooks_org_default_prospecting; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX playbooks_org_default_prospecting ON public.playbooks USING btree (org_id) WHERE ((is_default = true) AND ((type)::text = 'prospecting'::text));


--
-- Name: playbooks_org_default_sales; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX playbooks_org_default_sales ON public.playbooks USING btree (org_id) WHERE ((is_default = true) AND ((type)::text = 'sales'::text));


--
-- Name: playbooks_org_default_service; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX playbooks_org_default_service ON public.playbooks USING btree (org_id) WHERE ((is_default = true) AND ((type)::text = 'service'::text));


--
-- Name: playbooks_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX playbooks_org_id ON public.playbooks USING btree (org_id);


--
-- Name: prompts_org_default_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX prompts_org_default_unique ON public.prompts USING btree (org_id, key) WHERE (user_id IS NULL);


--
-- Name: prompts_user_override_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX prompts_user_override_unique ON public.prompts USING btree (org_id, user_id, key) WHERE (user_id IS NOT NULL);


--
-- Name: uq_action_config_user_org; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_action_config_user_org ON public.action_config USING btree (user_id, org_id);


--
-- Name: uq_actions_case_play; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_actions_case_play ON public.actions USING btree (case_id, playbook_play_id) WHERE ((case_id IS NOT NULL) AND (playbook_play_id IS NOT NULL));


--
-- Name: uq_actions_case_source_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_actions_case_source_rule ON public.actions USING btree (case_id, source_rule) WHERE ((case_id IS NOT NULL) AND (source_rule IS NOT NULL));


--
-- Name: uq_actions_contract_play; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_actions_contract_play ON public.actions USING btree (contract_id, playbook_play_id) WHERE ((contract_id IS NOT NULL) AND (playbook_play_id IS NOT NULL));


--
-- Name: uq_actions_contract_source_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_actions_contract_source_rule ON public.actions USING btree (contract_id, source_rule) WHERE ((contract_id IS NOT NULL) AND (source_rule IS NOT NULL));


--
-- Name: uq_actions_deal_play; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_actions_deal_play ON public.actions USING btree (deal_id, playbook_play_id) WHERE ((deal_id IS NOT NULL) AND (playbook_play_id IS NOT NULL));


--
-- Name: uq_actions_deal_source_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_actions_deal_source_rule ON public.actions USING btree (deal_id, source_rule) WHERE ((deal_id IS NOT NULL) AND (source_rule IS NOT NULL));


--
-- Name: uq_dhd_grain; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_dhd_grain ON public.domain_health_daily USING btree (org_id, domain, metric_date, source);


--
-- Name: uq_ede_ndr_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_ede_ndr_recipient ON public.email_delivery_events USING btree (org_id, ndr_external_id, failed_recipient) WHERE (ndr_external_id IS NOT NULL);


--
-- Name: uq_pactions_prospect_play; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_pactions_prospect_play ON public.prospecting_actions USING btree (prospect_id, play_id) WHERE ((prospect_id IS NOT NULL) AND (play_id IS NOT NULL));


--
-- Name: uq_pactions_prospect_source_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_pactions_prospect_source_rule ON public.prospecting_actions USING btree (prospect_id, source_rule) WHERE ((prospect_id IS NOT NULL) AND (source_rule IS NOT NULL));


--
-- Name: uq_pi_finding; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_pi_finding ON public.prospecting_insights USING btree (org_id, metric, cause_code, segment_hash);


--
-- Name: uq_pmd_grain; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_pmd_grain ON public.prospecting_metric_daily USING btree (org_id, metric_date, campaign_id, sequence_id, sequence_step_id, channel, sender_account_id, owner_id, fit_band);


--
-- Name: uq_prompts_user_org_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_prompts_user_org_key ON public.prompts USING btree (user_id, org_id, key);


--
-- Name: uq_seq_step_logs_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_seq_step_logs_pending ON public.sequence_step_logs USING btree (enrollment_id, sequence_step_id) WHERE ((status)::text = ANY (ARRAY['scheduled'::text, 'sending'::text]));


--
-- Name: uq_td_hostname; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_td_hostname ON public.tracking_domains USING btree (hostname);


--
-- Name: uq_user_linkedin_seats_org_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_user_linkedin_seats_org_slug ON public.user_linkedin_seats USING btree (org_id, lower(public_identifier));


--
-- Name: uq_user_prompts_user_org_type; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_user_prompts_user_org_type ON public.user_prompts USING btree (user_id, org_id, template_type);


--
-- Name: uq_users_email_lower; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_users_email_lower ON public.users USING btree (lower((email)::text));


--
-- Name: linkedin_profiles linkedin_profiles_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER linkedin_profiles_set_updated_at BEFORE UPDATE ON public.linkedin_profiles FOR EACH ROW EXECUTE FUNCTION public.trg_linkedin_profiles_set_updated_at();


--
-- Name: straps straps_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER straps_updated_at BEFORE UPDATE ON public.straps FOR EACH ROW EXECUTE FUNCTION public.trg_straps_updated_at();


--
-- Name: contracts trg_contracts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_contracts_updated_at BEFORE UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: contract_workflow_config trg_cwc_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_cwc_updated_at BEFORE UPDATE ON public.contract_workflow_config FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: deal_products trg_deal_products_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_deal_products_updated BEFORE UPDATE ON public.deal_products FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: entity_custom_fields trg_ecf_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ecf_updated_at BEFORE UPDATE ON public.entity_custom_fields FOR EACH ROW EXECUTE FUNCTION public.update_entity_custom_fields_updated_at();


--
-- Name: org_integrations trg_org_integrations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_org_integrations_updated_at BEFORE UPDATE ON public.org_integrations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: organizations trg_organizations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_organizations_updated_at BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: product_catalog trg_product_catalog_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_product_catalog_updated BEFORE UPDATE ON public.product_catalog FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: product_groups trg_product_groups_updated; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_product_groups_updated BEFORE UPDATE ON public.product_groups FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: prospecting_campaigns trg_prospecting_campaigns_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_prospecting_campaigns_updated_at BEFORE UPDATE ON public.prospecting_campaigns FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: deals trg_sync_deal_stage_type; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_deal_stage_type BEFORE INSERT OR UPDATE OF stage ON public.deals FOR EACH ROW EXECUTE FUNCTION public.fn_sync_deal_stage_type();


--
-- Name: action_config update_action_config_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_action_config_updated_at BEFORE UPDATE ON public.action_config FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: action_suggestions update_action_suggestions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_action_suggestions_updated_at BEFORE UPDATE ON public.action_suggestions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: account_hierarchy account_hierarchy_child_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_hierarchy
    ADD CONSTRAINT account_hierarchy_child_account_id_fkey FOREIGN KEY (child_account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: account_hierarchy account_hierarchy_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_hierarchy
    ADD CONSTRAINT account_hierarchy_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: account_hierarchy account_hierarchy_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_hierarchy
    ADD CONSTRAINT account_hierarchy_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: account_hierarchy account_hierarchy_parent_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_hierarchy
    ADD CONSTRAINT account_hierarchy_parent_account_id_fkey FOREIGN KEY (parent_account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: account_team_members account_team_members_account_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_team_members
    ADD CONSTRAINT account_team_members_account_team_id_fkey FOREIGN KEY (account_team_id) REFERENCES public.account_teams(id) ON DELETE CASCADE;


--
-- Name: account_team_members account_team_members_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_team_members
    ADD CONSTRAINT account_team_members_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: account_team_members account_team_members_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_team_members
    ADD CONSTRAINT account_team_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: account_teams account_teams_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_teams
    ADD CONSTRAINT account_teams_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: account_teams account_teams_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_teams
    ADD CONSTRAINT account_teams_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: account_teams account_teams_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_teams
    ADD CONSTRAINT account_teams_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: account_teams account_teams_parent_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_teams
    ADD CONSTRAINT account_teams_parent_team_id_fkey FOREIGN KEY (parent_team_id) REFERENCES public.account_teams(id) ON DELETE SET NULL;


--
-- Name: accounts accounts_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;


--
-- Name: accounts accounts_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: accounts accounts_sla_tier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_sla_tier_id_fkey FOREIGN KEY (sla_tier_id) REFERENCES public.sla_tiers(id) ON DELETE SET NULL;


--
-- Name: action_config action_config_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_config
    ADD CONSTRAINT action_config_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: action_suggestions action_suggestions_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_suggestions
    ADD CONSTRAINT action_suggestions_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.actions(id) ON DELETE CASCADE;


--
-- Name: action_suggestions action_suggestions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_suggestions
    ADD CONSTRAINT action_suggestions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: actions actions_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: actions actions_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id);


--
-- Name: actions actions_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);


--
-- Name: actions actions_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE SET NULL;


--
-- Name: actions actions_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: actions actions_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE SET NULL;


--
-- Name: actions actions_playbook_play_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_playbook_play_id_fkey FOREIGN KEY (playbook_play_id) REFERENCES public.playbook_plays(id) ON DELETE SET NULL;


--
-- Name: actions actions_strap_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_strap_id_fkey FOREIGN KEY (strap_id) REFERENCES public.straps(id);


--
-- Name: actions actions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT actions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: agent_proposals agent_proposals_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: agent_proposals agent_proposals_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.actions(id);


--
-- Name: agent_proposals agent_proposals_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);


--
-- Name: agent_proposals agent_proposals_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id);


--
-- Name: agent_proposals agent_proposals_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: agent_proposals agent_proposals_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: agent_proposals agent_proposals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_proposals
    ADD CONSTRAINT agent_proposals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: org_credentials ai_credentials_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_credentials
    ADD CONSTRAINT ai_credentials_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: org_credentials ai_credentials_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_credentials
    ADD CONSTRAINT ai_credentials_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_credentials ai_credentials_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_credentials
    ADD CONSTRAINT ai_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_processing_log ai_processing_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_processing_log
    ADD CONSTRAINT ai_processing_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_token_usage ai_token_usage_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_usage
    ADD CONSTRAINT ai_token_usage_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.actions(id);


--
-- Name: ai_token_usage ai_token_usage_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_usage
    ADD CONSTRAINT ai_token_usage_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id);


--
-- Name: ai_token_usage ai_token_usage_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_usage
    ADD CONSTRAINT ai_token_usage_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_token_usage ai_token_usage_proposal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_usage
    ADD CONSTRAINT ai_token_usage_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES public.agent_proposals(id);


--
-- Name: ai_token_usage ai_token_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_usage
    ADD CONSTRAINT ai_token_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: calendar_sync_history calendar_sync_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_sync_history
    ADD CONSTRAINT calendar_sync_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: calls calls_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: calls calls_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: calls calls_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: calls calls_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: calls calls_prospect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_prospect_id_fkey FOREIGN KEY (prospect_id) REFERENCES public.prospects(id) ON DELETE CASCADE;


--
-- Name: calls calls_sequence_step_log_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_sequence_step_log_id_fkey FOREIGN KEY (sequence_step_log_id) REFERENCES public.sequence_step_logs(id) ON DELETE SET NULL;


--
-- Name: calls calls_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calls
    ADD CONSTRAINT calls_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: case_notes case_notes_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_notes
    ADD CONSTRAINT case_notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: case_notes case_notes_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_notes
    ADD CONSTRAINT case_notes_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_notes case_notes_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_notes
    ADD CONSTRAINT case_notes_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: case_plays case_plays_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_plays
    ADD CONSTRAINT case_plays_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.actions(id) ON DELETE SET NULL;


--
-- Name: case_plays case_plays_assigned_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_plays
    ADD CONSTRAINT case_plays_assigned_role_id_fkey FOREIGN KEY (assigned_role_id) REFERENCES public.org_roles(id) ON DELETE SET NULL;


--
-- Name: case_plays case_plays_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_plays
    ADD CONSTRAINT case_plays_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: case_plays case_plays_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_plays
    ADD CONSTRAINT case_plays_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_plays case_plays_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_plays
    ADD CONSTRAINT case_plays_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: case_plays case_plays_play_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_plays
    ADD CONSTRAINT case_plays_play_id_fkey FOREIGN KEY (play_id) REFERENCES public.playbook_plays(id) ON DELETE CASCADE;


--
-- Name: case_status_history case_status_history_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_status_history
    ADD CONSTRAINT case_status_history_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.cases(id) ON DELETE CASCADE;


--
-- Name: case_status_history case_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_status_history
    ADD CONSTRAINT case_status_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: case_status_history case_status_history_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.case_status_history
    ADD CONSTRAINT case_status_history_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: cases cases_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: cases cases_assigned_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_assigned_team_id_fkey FOREIGN KEY (assigned_team_id) REFERENCES public.teams(id) ON DELETE SET NULL;


--
-- Name: cases cases_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cases cases_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;


--
-- Name: cases cases_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: cases cases_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: cases cases_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE SET NULL;


--
-- Name: cases cases_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: cases cases_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE SET NULL;


--
-- Name: cases cases_sla_tier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cases
    ADD CONSTRAINT cases_sla_tier_id_fkey FOREIGN KEY (sla_tier_id) REFERENCES public.sla_tiers(id) ON DELETE SET NULL;


--
-- Name: client_activities client_activities_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_activities
    ADD CONSTRAINT client_activities_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: client_activities client_activities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_activities
    ADD CONSTRAINT client_activities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: client_portal_users client_portal_users_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_portal_users
    ADD CONSTRAINT client_portal_users_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: client_team_members client_team_members_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_team_members
    ADD CONSTRAINT client_team_members_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: client_team_members client_team_members_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_team_members
    ADD CONSTRAINT client_team_members_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: client_team_members client_team_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_team_members
    ADD CONSTRAINT client_team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: clients clients_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: clients clients_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: clients clients_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: competitors competitors_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competitors
    ADD CONSTRAINT competitors_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: contact_activities contact_activities_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_activities
    ADD CONSTRAINT contact_activities_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contact_activities contact_activities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_activities
    ADD CONSTRAINT contact_activities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: contact_dotted_lines contact_dotted_lines_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_dotted_lines
    ADD CONSTRAINT contact_dotted_lines_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contact_dotted_lines contact_dotted_lines_dotted_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_dotted_lines
    ADD CONSTRAINT contact_dotted_lines_dotted_manager_id_fkey FOREIGN KEY (dotted_manager_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contact_dotted_lines contact_dotted_lines_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_dotted_lines
    ADD CONSTRAINT contact_dotted_lines_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: contact_identities contact_identities_canonical_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_identities
    ADD CONSTRAINT contact_identities_canonical_contact_id_fkey FOREIGN KEY (canonical_contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contact_identities contact_identities_canonical_prospect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_identities
    ADD CONSTRAINT contact_identities_canonical_prospect_id_fkey FOREIGN KEY (canonical_prospect_id) REFERENCES public.prospects(id) ON DELETE CASCADE;


--
-- Name: contact_identities contact_identities_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_identities
    ADD CONSTRAINT contact_identities_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contact_identities contact_identities_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_identities
    ADD CONSTRAINT contact_identities_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_converted_from_prospect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_converted_from_prospect_id_fkey FOREIGN KEY (converted_from_prospect_id) REFERENCES public.prospects(id);


--
-- Name: contacts contacts_email_snoozed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_email_snoozed_by_fkey FOREIGN KEY (email_snoozed_by) REFERENCES public.users(id);


--
-- Name: contacts contacts_reports_to_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_reports_to_contact_id_fkey FOREIGN KEY (reports_to_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: contract_approval_config contract_approval_config_approver_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_approval_config
    ADD CONSTRAINT contract_approval_config_approver_user_id_fkey FOREIGN KEY (approver_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contract_approvals contract_approvals_approver_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_approvals
    ADD CONSTRAINT contract_approvals_approver_user_id_fkey FOREIGN KEY (approver_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contract_approvals contract_approvals_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_approvals
    ADD CONSTRAINT contract_approvals_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_document_versions contract_document_versions_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_document_versions
    ADD CONSTRAINT contract_document_versions_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_document_versions contract_document_versions_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_document_versions
    ADD CONSTRAINT contract_document_versions_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: contract_events contract_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_events
    ADD CONSTRAINT contract_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contract_events contract_events_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_events
    ADD CONSTRAINT contract_events_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_play_instances contract_play_instances_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_play_instances
    ADD CONSTRAINT contract_play_instances_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.actions(id) ON DELETE SET NULL;


--
-- Name: contract_play_instances contract_play_instances_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_play_instances
    ADD CONSTRAINT contract_play_instances_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id);


--
-- Name: contract_play_instances contract_play_instances_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_play_instances
    ADD CONSTRAINT contract_play_instances_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_play_instances contract_play_instances_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_play_instances
    ADD CONSTRAINT contract_play_instances_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: contract_play_instances contract_play_instances_play_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_play_instances
    ADD CONSTRAINT contract_play_instances_play_id_fkey FOREIGN KEY (play_id) REFERENCES public.playbook_plays(id) ON DELETE SET NULL;


--
-- Name: contract_plays contract_plays_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_plays
    ADD CONSTRAINT contract_plays_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contract_plays contract_plays_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_plays
    ADD CONSTRAINT contract_plays_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contract_plays contract_plays_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_plays
    ADD CONSTRAINT contract_plays_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_plays contract_plays_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_plays
    ADD CONSTRAINT contract_plays_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: contract_plays contract_plays_play_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_plays
    ADD CONSTRAINT contract_plays_play_id_fkey FOREIGN KEY (play_id) REFERENCES public.playbook_plays(id) ON DELETE CASCADE;


--
-- Name: contract_plays contract_plays_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_plays
    ADD CONSTRAINT contract_plays_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE CASCADE;


--
-- Name: contract_signatories contract_signatories_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_signatories
    ADD CONSTRAINT contract_signatories_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES public.contracts(id) ON DELETE CASCADE;


--
-- Name: contract_templates contract_templates_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_templates
    ADD CONSTRAINT contract_templates_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: contract_templates contract_templates_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_templates
    ADD CONSTRAINT contract_templates_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contract_workflow_config contract_workflow_config_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contract_workflow_config
    ADD CONSTRAINT contract_workflow_config_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: contracts contracts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: contracts contracts_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE SET NULL;


--
-- Name: contracts contracts_legal_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_legal_assignee_id_fkey FOREIGN KEY (legal_assignee_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: contracts contracts_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: contracts contracts_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: contracts contracts_parent_contract_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_parent_contract_id_fkey FOREIGN KEY (parent_contract_id) REFERENCES public.contracts(id) ON DELETE SET NULL;


--
-- Name: contracts contracts_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contracts
    ADD CONSTRAINT contracts_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE SET NULL;


--
-- Name: conversation_starters conversation_starters_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_starters
    ADD CONSTRAINT conversation_starters_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: deal_activities deal_activities_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_activities
    ADD CONSTRAINT deal_activities_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: deal_activities deal_activities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_activities
    ADD CONSTRAINT deal_activities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: deal_contacts deal_contacts_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_contacts
    ADD CONSTRAINT deal_contacts_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: deal_contacts deal_contacts_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_contacts
    ADD CONSTRAINT deal_contacts_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: deal_health_config deal_health_config_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_health_config
    ADD CONSTRAINT deal_health_config_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: deal_play_assignees deal_play_assignees_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_assignees
    ADD CONSTRAINT deal_play_assignees_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id);


--
-- Name: deal_play_assignees deal_play_assignees_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_assignees
    ADD CONSTRAINT deal_play_assignees_instance_id_fkey FOREIGN KEY (instance_id) REFERENCES public.deal_play_instances(id) ON DELETE CASCADE;


--
-- Name: deal_play_assignees deal_play_assignees_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_assignees
    ADD CONSTRAINT deal_play_assignees_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.org_roles(id) ON DELETE SET NULL;


--
-- Name: deal_play_assignees deal_play_assignees_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_assignees
    ADD CONSTRAINT deal_play_assignees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: deal_play_instances deal_play_instances_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_instances
    ADD CONSTRAINT deal_play_instances_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.actions(id) ON DELETE SET NULL;


--
-- Name: deal_play_instances deal_play_instances_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_instances
    ADD CONSTRAINT deal_play_instances_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id);


--
-- Name: deal_play_instances deal_play_instances_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_instances
    ADD CONSTRAINT deal_play_instances_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: deal_play_instances deal_play_instances_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_instances
    ADD CONSTRAINT deal_play_instances_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: deal_play_instances deal_play_instances_overridden_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_instances
    ADD CONSTRAINT deal_play_instances_overridden_by_fkey FOREIGN KEY (overridden_by) REFERENCES public.users(id);


--
-- Name: deal_play_instances deal_play_instances_play_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_instances
    ADD CONSTRAINT deal_play_instances_play_id_fkey FOREIGN KEY (play_id) REFERENCES public.playbook_plays(id) ON DELETE SET NULL;


--
-- Name: deal_play_instances deal_play_instances_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_play_instances
    ADD CONSTRAINT deal_play_instances_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE SET NULL;


--
-- Name: deal_products deal_products_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_products
    ADD CONSTRAINT deal_products_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: deal_products deal_products_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_products
    ADD CONSTRAINT deal_products_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: deal_products deal_products_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_products
    ADD CONSTRAINT deal_products_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.product_catalog(id) ON DELETE SET NULL;


--
-- Name: org_roles deal_roles_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_roles
    ADD CONSTRAINT deal_roles_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: deal_team_members deal_team_members_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_team_members
    ADD CONSTRAINT deal_team_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: deal_team_members deal_team_members_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_team_members
    ADD CONSTRAINT deal_team_members_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: deal_team_members deal_team_members_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_team_members
    ADD CONSTRAINT deal_team_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: deal_team_members deal_team_members_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_team_members
    ADD CONSTRAINT deal_team_members_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.org_roles(id) ON DELETE SET NULL;


--
-- Name: deal_team_members deal_team_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_team_members
    ADD CONSTRAINT deal_team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: deal_value_history deal_value_history_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_value_history
    ADD CONSTRAINT deal_value_history_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: deal_value_history deal_value_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_value_history
    ADD CONSTRAINT deal_value_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: deals deals_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: deals deals_economic_buyer_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_economic_buyer_contact_id_fkey FOREIGN KEY (economic_buyer_contact_id) REFERENCES public.contacts(id);


--
-- Name: deals deals_handover_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_handover_playbook_id_fkey FOREIGN KEY (handover_playbook_id) REFERENCES public.playbooks(id) ON DELETE SET NULL;


--
-- Name: deals deals_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: deals deals_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE SET NULL;


--
-- Name: deals deals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: email_filter_log email_filter_log_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_filter_log
    ADD CONSTRAINT email_filter_log_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: email_filter_log email_filter_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_filter_log
    ADD CONSTRAINT email_filter_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: email_sync_history email_sync_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sync_history
    ADD CONSTRAINT email_sync_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: emails emails_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails
    ADD CONSTRAINT emails_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);


--
-- Name: emails emails_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails
    ADD CONSTRAINT emails_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: emails emails_prospect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails
    ADD CONSTRAINT emails_prospect_id_fkey FOREIGN KEY (prospect_id) REFERENCES public.prospects(id);


--
-- Name: emails emails_sender_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails
    ADD CONSTRAINT emails_sender_account_id_fkey FOREIGN KEY (sender_account_id) REFERENCES public.prospecting_sender_accounts(id) ON DELETE SET NULL;


--
-- Name: emails emails_tagged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails
    ADD CONSTRAINT emails_tagged_by_fkey FOREIGN KEY (tagged_by) REFERENCES public.users(id);


--
-- Name: emails emails_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails
    ADD CONSTRAINT emails_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: enrichment_credit_log enrichment_credit_log_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_credit_log
    ADD CONSTRAINT enrichment_credit_log_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: enrichment_credit_log enrichment_credit_log_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_credit_log
    ADD CONSTRAINT enrichment_credit_log_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: enrichment_credit_log enrichment_credit_log_prospect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrichment_credit_log
    ADD CONSTRAINT enrichment_credit_log_prospect_id_fkey FOREIGN KEY (prospect_id) REFERENCES public.prospects(id) ON DELETE SET NULL;


--
-- Name: entity_custom_fields entity_custom_fields_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_custom_fields
    ADD CONSTRAINT entity_custom_fields_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: accounts fk_accounts_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT fk_accounts_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: action_config fk_action_config_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_config
    ADD CONSTRAINT fk_action_config_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: action_suggestions fk_action_suggestions_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_suggestions
    ADD CONSTRAINT fk_action_suggestions_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: actions fk_actions_account; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT fk_actions_account FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: actions fk_actions_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.actions
    ADD CONSTRAINT fk_actions_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: ai_processing_log fk_ai_processing_log_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_processing_log
    ADD CONSTRAINT fk_ai_processing_log_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: calendar_sync_history fk_calendar_sync_history_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_sync_history
    ADD CONSTRAINT fk_calendar_sync_history_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: competitors fk_competitors_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competitors
    ADD CONSTRAINT fk_competitors_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: contacts fk_contacts_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT fk_contacts_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: deal_health_config fk_deal_health_config_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_health_config
    ADD CONSTRAINT fk_deal_health_config_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: deals fk_deals_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT fk_deals_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: email_sync_history fk_email_sync_history_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_sync_history
    ADD CONSTRAINT fk_email_sync_history_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: emails fk_emails_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails
    ADD CONSTRAINT fk_emails_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: meeting_attendees fk_meeting_attendees_org_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendees
    ADD CONSTRAINT fk_meeting_attendees_org_id FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: meeting_transcripts fk_meeting_transcripts_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_transcripts
    ADD CONSTRAINT fk_meeting_transcripts_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: meetings fk_meetings_account_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT fk_meetings_account_id FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: meetings fk_meetings_handover_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT fk_meetings_handover_id FOREIGN KEY (handover_id) REFERENCES public.sales_handovers(id) ON DELETE SET NULL;


--
-- Name: meetings fk_meetings_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT fk_meetings_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: meetings fk_meetings_prospect_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT fk_meetings_prospect_id FOREIGN KEY (prospect_id) REFERENCES public.prospects(id) ON DELETE SET NULL;


--
-- Name: oauth_tokens fk_oauth_tokens_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT fk_oauth_tokens_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: prompts fk_prompts_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompts
    ADD CONSTRAINT fk_prompts_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: proposals fk_proposals_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT fk_proposals_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: storage_files fk_storage_files_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_files
    ADD CONSTRAINT fk_storage_files_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: user_prompts fk_user_prompts_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_prompts
    ADD CONSTRAINT fk_user_prompts_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: users fk_users_org; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: linkedin_profiles linkedin_profiles_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.linkedin_profiles
    ADD CONSTRAINT linkedin_profiles_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: meeting_attendees meeting_attendees_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendees
    ADD CONSTRAINT meeting_attendees_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: meeting_attendees meeting_attendees_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendees
    ADD CONSTRAINT meeting_attendees_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_attendees meeting_attendees_prospect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_attendees
    ADD CONSTRAINT meeting_attendees_prospect_id_fkey FOREIGN KEY (prospect_id) REFERENCES public.prospects(id) ON DELETE SET NULL;


--
-- Name: meeting_transcripts meeting_transcripts_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_transcripts
    ADD CONSTRAINT meeting_transcripts_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE SET NULL;


--
-- Name: meeting_transcripts meeting_transcripts_meeting_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_transcripts
    ADD CONSTRAINT meeting_transcripts_meeting_id_fkey FOREIGN KEY (meeting_id) REFERENCES public.meetings(id) ON DELETE CASCADE;


--
-- Name: meeting_transcripts meeting_transcripts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meeting_transcripts
    ADD CONSTRAINT meeting_transcripts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: meetings meetings_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.actions(id) ON DELETE SET NULL;


--
-- Name: meetings meetings_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: meetings meetings_transcript_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_transcript_id_fkey FOREIGN KEY (transcript_id) REFERENCES public.meeting_transcripts(id);


--
-- Name: meetings meetings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: oauth_tokens oauth_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: org_action_config org_action_config_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_action_config
    ADD CONSTRAINT org_action_config_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_action_config org_action_config_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_action_config
    ADD CONSTRAINT org_action_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: org_hierarchy org_hierarchy_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_hierarchy
    ADD CONSTRAINT org_hierarchy_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_hierarchy org_hierarchy_reports_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_hierarchy
    ADD CONSTRAINT org_hierarchy_reports_to_fkey FOREIGN KEY (reports_to) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: org_hierarchy org_hierarchy_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_hierarchy
    ADD CONSTRAINT org_hierarchy_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: org_integrations org_integrations_connected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_integrations
    ADD CONSTRAINT org_integrations_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: org_integrations org_integrations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_integrations
    ADD CONSTRAINT org_integrations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_invitations org_invitations_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id);


--
-- Name: org_invitations org_invitations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_invites org_invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id);


--
-- Name: org_invites org_invites_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invites
    ADD CONSTRAINT org_invites_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: org_users org_users_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_users
    ADD CONSTRAINT org_users_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id);


--
-- Name: org_users org_users_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_users
    ADD CONSTRAINT org_users_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_users org_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_users
    ADD CONSTRAINT org_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: organizations organizations_suspended_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_suspended_by_fkey FOREIGN KEY (suspended_by) REFERENCES public.users(id);


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: pipeline_stages pipeline_stages_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipeline_stages
    ADD CONSTRAINT pipeline_stages_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: platform_settings platform_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: playbook_play_roles playbook_play_roles_play_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_play_roles
    ADD CONSTRAINT playbook_play_roles_play_id_fkey FOREIGN KEY (play_id) REFERENCES public.playbook_plays(id) ON DELETE CASCADE;


--
-- Name: playbook_play_roles playbook_play_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_play_roles
    ADD CONSTRAINT playbook_play_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.org_roles(id) ON DELETE CASCADE;


--
-- Name: playbook_plays playbook_plays_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_plays
    ADD CONSTRAINT playbook_plays_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: playbook_plays playbook_plays_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_plays
    ADD CONSTRAINT playbook_plays_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: playbook_plays playbook_plays_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_plays
    ADD CONSTRAINT playbook_plays_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE CASCADE;


--
-- Name: playbook_plays playbook_plays_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_plays
    ADD CONSTRAINT playbook_plays_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.org_roles(id);


--
-- Name: playbook_plays playbook_plays_unlocks_play_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_plays
    ADD CONSTRAINT playbook_plays_unlocks_play_id_fkey FOREIGN KEY (unlocks_play_id) REFERENCES public.playbook_plays(id) ON DELETE SET NULL;


--
-- Name: playbook_registrations playbook_registrations_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_registrations
    ADD CONSTRAINT playbook_registrations_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: playbook_registrations playbook_registrations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_registrations
    ADD CONSTRAINT playbook_registrations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: playbook_registrations playbook_registrations_owner_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_registrations
    ADD CONSTRAINT playbook_registrations_owner_team_id_fkey FOREIGN KEY (owner_team_id) REFERENCES public.teams(id);


--
-- Name: playbook_registrations playbook_registrations_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_registrations
    ADD CONSTRAINT playbook_registrations_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.users(id);


--
-- Name: playbook_registrations playbook_registrations_submitter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_registrations
    ADD CONSTRAINT playbook_registrations_submitter_id_fkey FOREIGN KEY (submitter_id) REFERENCES public.users(id);


--
-- Name: playbook_roles playbook_roles_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_roles
    ADD CONSTRAINT playbook_roles_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE CASCADE;


--
-- Name: playbook_roles playbook_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_roles
    ADD CONSTRAINT playbook_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.org_roles(id) ON DELETE CASCADE;


--
-- Name: playbook_stages playbook_stages_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_stages
    ADD CONSTRAINT playbook_stages_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: playbook_stages playbook_stages_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_stages
    ADD CONSTRAINT playbook_stages_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE CASCADE;


--
-- Name: playbook_teams playbook_teams_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_teams
    ADD CONSTRAINT playbook_teams_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE CASCADE;


--
-- Name: playbook_teams playbook_teams_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_teams
    ADD CONSTRAINT playbook_teams_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: playbook_user_access playbook_user_access_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_user_access
    ADD CONSTRAINT playbook_user_access_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE CASCADE;


--
-- Name: playbook_user_access playbook_user_access_set_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_user_access
    ADD CONSTRAINT playbook_user_access_set_by_fkey FOREIGN KEY (set_by) REFERENCES public.users(id);


--
-- Name: playbook_user_access playbook_user_access_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_user_access
    ADD CONSTRAINT playbook_user_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: playbook_versions playbook_versions_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_versions
    ADD CONSTRAINT playbook_versions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: playbook_versions playbook_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_versions
    ADD CONSTRAINT playbook_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: playbook_versions playbook_versions_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbook_versions
    ADD CONSTRAINT playbook_versions_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE CASCADE;


--
-- Name: playbooks playbooks_archived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES public.users(id);


--
-- Name: playbooks playbooks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: playbooks playbooks_current_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_current_version_id_fkey FOREIGN KEY (current_version_id) REFERENCES public.playbook_versions(id);


--
-- Name: playbooks playbooks_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: playbooks playbooks_replacement_pb_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_replacement_pb_id_fkey FOREIGN KEY (replacement_pb_id) REFERENCES public.playbooks(id);


--
-- Name: product_catalog product_catalog_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_catalog
    ADD CONSTRAINT product_catalog_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.product_groups(id) ON DELETE SET NULL;


--
-- Name: product_catalog product_catalog_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_catalog
    ADD CONSTRAINT product_catalog_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: product_groups product_groups_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_groups
    ADD CONSTRAINT product_groups_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: product_groups product_groups_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_groups
    ADD CONSTRAINT product_groups_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.product_groups(id) ON DELETE CASCADE;


--
-- Name: prompts prompts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompts
    ADD CONSTRAINT prompts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: proposals proposals_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: proposals proposals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: prospecting_actions prospecting_actions_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_actions
    ADD CONSTRAINT prospecting_actions_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.users(id);


--
-- Name: prospecting_actions prospecting_actions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_actions
    ADD CONSTRAINT prospecting_actions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: prospecting_actions prospecting_actions_play_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_actions
    ADD CONSTRAINT prospecting_actions_play_id_fkey FOREIGN KEY (play_id) REFERENCES public.playbook_plays(id) ON DELETE SET NULL;


--
-- Name: prospecting_actions prospecting_actions_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_actions
    ADD CONSTRAINT prospecting_actions_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE SET NULL;


--
-- Name: prospecting_actions prospecting_actions_prospect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_actions
    ADD CONSTRAINT prospecting_actions_prospect_id_fkey FOREIGN KEY (prospect_id) REFERENCES public.prospects(id) ON DELETE CASCADE;


--
-- Name: prospecting_actions prospecting_actions_strap_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_actions
    ADD CONSTRAINT prospecting_actions_strap_id_fkey FOREIGN KEY (strap_id) REFERENCES public.straps(id);


--
-- Name: prospecting_actions prospecting_actions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_actions
    ADD CONSTRAINT prospecting_actions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: prospecting_activities prospecting_activities_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_activities
    ADD CONSTRAINT prospecting_activities_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: prospecting_activities prospecting_activities_prospect_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_activities
    ADD CONSTRAINT prospecting_activities_prospect_id_fkey FOREIGN KEY (prospect_id) REFERENCES public.prospects(id) ON DELETE CASCADE;


--
-- Name: prospecting_activities prospecting_activities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_activities
    ADD CONSTRAINT prospecting_activities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: prospecting_campaigns prospecting_campaigns_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_campaigns
    ADD CONSTRAINT prospecting_campaigns_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: prospecting_campaigns prospecting_campaigns_default_sequence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_campaigns
    ADD CONSTRAINT prospecting_campaigns_default_sequence_id_fkey FOREIGN KEY (default_sequence_id) REFERENCES public.sequences(id) ON DELETE SET NULL;


--
-- Name: prospecting_campaigns prospecting_campaigns_delete_locked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_campaigns
    ADD CONSTRAINT prospecting_campaigns_delete_locked_by_fkey FOREIGN KEY (delete_locked_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: prospecting_campaigns prospecting_campaigns_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_campaigns
    ADD CONSTRAINT prospecting_campaigns_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: prospecting_campaigns prospecting_campaigns_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_campaigns
    ADD CONSTRAINT prospecting_campaigns_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: prospecting_campaigns prospecting_campaigns_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_campaigns
    ADD CONSTRAINT prospecting_campaigns_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE SET NULL;


--
-- Name: prospecting_sender_accounts prospecting_sender_accounts_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_sender_accounts
    ADD CONSTRAINT prospecting_sender_accounts_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: prospecting_sender_accounts prospecting_sender_accounts_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_sender_accounts
    ADD CONSTRAINT prospecting_sender_accounts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: prospecting_sender_accounts prospecting_sender_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospecting_sender_accounts
    ADD CONSTRAINT prospecting_sender_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: prospects prospects_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospects
    ADD CONSTRAINT prospects_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id);


--
-- Name: prospects prospects_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospects
    ADD CONSTRAINT prospects_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.prospecting_campaigns(id) ON DELETE SET NULL;


--
-- Name: prospects prospects_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospects
    ADD CONSTRAINT prospects_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;


--
-- Name: prospects prospects_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospects
    ADD CONSTRAINT prospects_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id);


--
-- Name: prospects prospects_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospects
    ADD CONSTRAINT prospects_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id);


--
-- Name: prospects prospects_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospects
    ADD CONSTRAINT prospects_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: prospects prospects_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospects
    ADD CONSTRAINT prospects_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: prospects prospects_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prospects
    ADD CONSTRAINT prospects_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id);


--
-- Name: rule_violations rule_violations_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rule_violations
    ADD CONSTRAINT rule_violations_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.workflow_executions(id) ON DELETE SET NULL;


--
-- Name: rule_violations rule_violations_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rule_violations
    ADD CONSTRAINT rule_violations_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.workflow_rules(id) ON DELETE CASCADE;


--
-- Name: sales_handover_commitments sales_handover_commitments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_commitments
    ADD CONSTRAINT sales_handover_commitments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sales_handover_commitments sales_handover_commitments_handover_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_commitments
    ADD CONSTRAINT sales_handover_commitments_handover_id_fkey FOREIGN KEY (handover_id) REFERENCES public.sales_handovers(id) ON DELETE CASCADE;


--
-- Name: sales_handover_commitments sales_handover_commitments_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_commitments
    ADD CONSTRAINT sales_handover_commitments_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: sales_handover_plays sales_handover_plays_handover_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_plays
    ADD CONSTRAINT sales_handover_plays_handover_id_fkey FOREIGN KEY (handover_id) REFERENCES public.sales_handovers(id) ON DELETE CASCADE;


--
-- Name: sales_handover_plays sales_handover_plays_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_plays
    ADD CONSTRAINT sales_handover_plays_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: sales_handover_plays sales_handover_plays_play_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_plays
    ADD CONSTRAINT sales_handover_plays_play_instance_id_fkey FOREIGN KEY (play_instance_id) REFERENCES public.deal_play_instances(id) ON DELETE CASCADE;


--
-- Name: sales_handover_stakeholders sales_handover_stakeholders_account_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_stakeholders
    ADD CONSTRAINT sales_handover_stakeholders_account_team_id_fkey FOREIGN KEY (account_team_id) REFERENCES public.account_teams(id) ON DELETE SET NULL;


--
-- Name: sales_handover_stakeholders sales_handover_stakeholders_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_stakeholders
    ADD CONSTRAINT sales_handover_stakeholders_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: sales_handover_stakeholders sales_handover_stakeholders_handover_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_stakeholders
    ADD CONSTRAINT sales_handover_stakeholders_handover_id_fkey FOREIGN KEY (handover_id) REFERENCES public.sales_handovers(id) ON DELETE CASCADE;


--
-- Name: sales_handover_stakeholders sales_handover_stakeholders_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handover_stakeholders
    ADD CONSTRAINT sales_handover_stakeholders_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: sales_handovers sales_handovers_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handovers
    ADD CONSTRAINT sales_handovers_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE RESTRICT;


--
-- Name: sales_handovers sales_handovers_assigned_service_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handovers
    ADD CONSTRAINT sales_handovers_assigned_service_owner_id_fkey FOREIGN KEY (assigned_service_owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: sales_handovers sales_handovers_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handovers
    ADD CONSTRAINT sales_handovers_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: sales_handovers sales_handovers_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handovers
    ADD CONSTRAINT sales_handovers_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE CASCADE;


--
-- Name: sales_handovers sales_handovers_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handovers
    ADD CONSTRAINT sales_handovers_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: sales_handovers sales_handovers_playbook_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_handovers
    ADD CONSTRAINT sales_handovers_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES public.playbooks(id) ON DELETE SET NULL;


--
-- Name: sequence_enrollments sequence_enrollments_sequence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_enrollments
    ADD CONSTRAINT sequence_enrollments_sequence_id_fkey FOREIGN KEY (sequence_id) REFERENCES public.sequences(id) ON DELETE RESTRICT;


--
-- Name: sequence_step_logs sequence_step_logs_enrollment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_step_logs
    ADD CONSTRAINT sequence_step_logs_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES public.sequence_enrollments(id) ON DELETE CASCADE;


--
-- Name: sequence_step_logs sequence_step_logs_sequence_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_step_logs
    ADD CONSTRAINT sequence_step_logs_sequence_step_id_fkey FOREIGN KEY (sequence_step_id) REFERENCES public.sequence_steps(id) ON DELETE RESTRICT;


--
-- Name: sequence_steps sequence_steps_sequence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequence_steps
    ADD CONSTRAINT sequence_steps_sequence_id_fkey FOREIGN KEY (sequence_id) REFERENCES public.sequences(id) ON DELETE CASCADE;


--
-- Name: sequences sequences_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sequences
    ADD CONSTRAINT sequences_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;


--
-- Name: sf_activity_log sf_activity_log_gw_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sf_activity_log
    ADD CONSTRAINT sf_activity_log_gw_action_id_fkey FOREIGN KEY (gw_action_id) REFERENCES public.actions(id) ON DELETE SET NULL;


--
-- Name: sf_activity_log sf_activity_log_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sf_activity_log
    ADD CONSTRAINT sf_activity_log_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: skill_runs skill_runs_prompt_hash_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_runs
    ADD CONSTRAINT skill_runs_prompt_hash_fkey FOREIGN KEY (prompt_hash) REFERENCES public.skill_prompt_versions(hash) ON DELETE SET NULL;


--
-- Name: sla_tiers sla_tiers_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sla_tiers
    ADD CONSTRAINT sla_tiers_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: storage_files storage_files_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_files
    ADD CONSTRAINT storage_files_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: storage_files storage_files_deal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_files
    ADD CONSTRAINT storage_files_deal_id_fkey FOREIGN KEY (deal_id) REFERENCES public.deals(id) ON DELETE SET NULL;


--
-- Name: storage_files storage_files_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storage_files
    ADD CONSTRAINT storage_files_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: strap_actions strap_actions_strap_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strap_actions
    ADD CONSTRAINT strap_actions_strap_id_fkey FOREIGN KEY (strap_id) REFERENCES public.straps(id) ON DELETE CASCADE;


--
-- Name: straps straps_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.straps
    ADD CONSTRAINT straps_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: straps straps_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.straps
    ADD CONSTRAINT straps_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: straps straps_override_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.straps
    ADD CONSTRAINT straps_override_by_fkey FOREIGN KEY (override_by) REFERENCES public.users(id);


--
-- Name: straps straps_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.straps
    ADD CONSTRAINT straps_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: super_admin_audit_log super_admin_audit_log_super_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.super_admin_audit_log
    ADD CONSTRAINT super_admin_audit_log_super_admin_id_fkey FOREIGN KEY (super_admin_id) REFERENCES public.users(id);


--
-- Name: super_admins super_admins_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.super_admins
    ADD CONSTRAINT super_admins_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: super_admins super_admins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.super_admins
    ADD CONSTRAINT super_admins_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: team_dimensions team_dimensions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_dimensions
    ADD CONSTRAINT team_dimensions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: team_memberships team_memberships_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT team_memberships_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: team_memberships team_memberships_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT team_memberships_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_memberships team_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_memberships
    ADD CONSTRAINT team_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: teams teams_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: teams teams_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: teams teams_parent_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_parent_team_id_fkey FOREIGN KEY (parent_team_id) REFERENCES public.teams(id) ON DELETE SET NULL;


--
-- Name: user_preferences user_preferences_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_prompts user_prompts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_prompts
    ADD CONSTRAINT user_prompts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workflow_branches workflow_branches_false_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_branches
    ADD CONSTRAINT workflow_branches_false_step_id_fkey FOREIGN KEY (false_step_id) REFERENCES public.workflow_steps(id);


--
-- Name: workflow_branches workflow_branches_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_branches
    ADD CONSTRAINT workflow_branches_step_id_fkey FOREIGN KEY (step_id) REFERENCES public.workflow_steps(id) ON DELETE CASCADE;


--
-- Name: workflow_branches workflow_branches_true_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_branches
    ADD CONSTRAINT workflow_branches_true_step_id_fkey FOREIGN KEY (true_step_id) REFERENCES public.workflow_steps(id);


--
-- Name: workflow_executions workflow_executions_triggered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_executions
    ADD CONSTRAINT workflow_executions_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES public.users(id);


--
-- Name: workflow_executions workflow_executions_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_executions
    ADD CONSTRAINT workflow_executions_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: workflow_rules workflow_rules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_rules
    ADD CONSTRAINT workflow_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: workflow_rules workflow_rules_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_rules
    ADD CONSTRAINT workflow_rules_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workflow_rules workflow_rules_step_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_rules
    ADD CONSTRAINT workflow_rules_step_id_fkey FOREIGN KEY (step_id) REFERENCES public.workflow_steps(id) ON DELETE CASCADE;


--
-- Name: workflow_steps workflow_steps_on_fail_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_steps
    ADD CONSTRAINT workflow_steps_on_fail_fkey FOREIGN KEY (on_fail) REFERENCES public.workflow_steps(id);


--
-- Name: workflow_steps workflow_steps_on_pass_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_steps
    ADD CONSTRAINT workflow_steps_on_pass_fkey FOREIGN KEY (on_pass) REFERENCES public.workflow_steps(id);


--
-- Name: workflow_steps workflow_steps_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_steps
    ADD CONSTRAINT workflow_steps_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: workflows workflows_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: workflows workflows_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: account_hierarchy; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_hierarchy ENABLE ROW LEVEL SECURITY;

--
-- Name: account_hierarchy account_hierarchy_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY account_hierarchy_org_isolation ON public.account_hierarchy USING (((org_id)::text = current_setting('app.current_org_id'::text, true)));


--
-- Name: accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: action_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.action_config ENABLE ROW LEVEL SECURITY;

--
-- Name: action_suggestions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.action_suggestions ENABLE ROW LEVEL SECURITY;

--
-- Name: actions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.actions ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_processing_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_processing_log ENABLE ROW LEVEL SECURITY;

--
-- Name: calendar_sync_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.calendar_sync_history ENABLE ROW LEVEL SECURITY;

--
-- Name: case_status_history case_history_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY case_history_org_isolation ON public.case_status_history USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: case_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.case_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: case_notes case_notes_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY case_notes_org_isolation ON public.case_notes USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: case_plays; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.case_plays ENABLE ROW LEVEL SECURITY;

--
-- Name: case_plays case_plays_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY case_plays_org_isolation ON public.case_plays USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: case_status_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.case_status_history ENABLE ROW LEVEL SECURITY;

--
-- Name: cases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cases ENABLE ROW LEVEL SECURITY;

--
-- Name: cases cases_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cases_org_isolation ON public.cases USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: competitors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.competitors ENABLE ROW LEVEL SECURITY;

--
-- Name: contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_plays; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contract_plays ENABLE ROW LEVEL SECURITY;

--
-- Name: contract_plays contract_plays_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY contract_plays_org_isolation ON public.contract_plays USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: deal_health_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deal_health_config ENABLE ROW LEVEL SECURITY;

--
-- Name: deals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;

--
-- Name: email_filter_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_filter_log ENABLE ROW LEVEL SECURITY;

--
-- Name: email_sync_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_sync_history ENABLE ROW LEVEL SECURITY;

--
-- Name: emails; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.emails ENABLE ROW LEVEL SECURITY;

--
-- Name: meeting_transcripts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.meeting_transcripts ENABLE ROW LEVEL SECURITY;

--
-- Name: meetings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;

--
-- Name: oauth_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.oauth_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts org_isolation_accounts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_accounts ON public.accounts USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: action_config org_isolation_action_config; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_action_config ON public.action_config USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: action_suggestions org_isolation_action_suggestions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_action_suggestions ON public.action_suggestions USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: actions org_isolation_actions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_actions ON public.actions USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: ai_processing_log org_isolation_ai_processing_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_ai_processing_log ON public.ai_processing_log USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: calendar_sync_history org_isolation_calendar_sync_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_calendar_sync_history ON public.calendar_sync_history USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: competitors org_isolation_competitors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_competitors ON public.competitors USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: contacts org_isolation_contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_contacts ON public.contacts USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: deal_health_config org_isolation_deal_health_config; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_deal_health_config ON public.deal_health_config USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: deals org_isolation_deals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_deals ON public.deals USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: email_filter_log org_isolation_email_filter_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_email_filter_log ON public.email_filter_log USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: email_sync_history org_isolation_email_sync_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_email_sync_history ON public.email_sync_history USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: emails org_isolation_emails; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_emails ON public.emails USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: meeting_transcripts org_isolation_meeting_transcripts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_meeting_transcripts ON public.meeting_transcripts USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: meetings org_isolation_meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_meetings ON public.meetings USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: oauth_tokens org_isolation_oauth_tokens; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_oauth_tokens ON public.oauth_tokens USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: prompts org_isolation_prompts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_prompts ON public.prompts USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: proposals org_isolation_proposals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_proposals ON public.proposals USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: storage_files org_isolation_storage_files; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_storage_files ON public.storage_files USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: strap_actions org_isolation_strap_actions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_strap_actions ON public.strap_actions USING ((strap_id IN ( SELECT straps.id
   FROM public.straps
  WHERE (straps.org_id = (current_setting('app.current_org_id'::text, true))::integer))));


--
-- Name: straps org_isolation_straps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_straps ON public.straps USING ((org_id = (current_setting('app.current_org_id'::text, true))::integer));


--
-- Name: user_prompts org_isolation_user_prompts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_isolation_user_prompts ON public.user_prompts USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: playbook_stages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.playbook_stages ENABLE ROW LEVEL SECURITY;

--
-- Name: playbook_stages playbook_stages_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY playbook_stages_org_isolation ON public.playbook_stages USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: prompts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.prompts ENABLE ROW LEVEL SECURITY;

--
-- Name: proposals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.proposals ENABLE ROW LEVEL SECURITY;

--
-- Name: skill_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.skill_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: skill_runs skill_runs_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY skill_runs_org_isolation ON public.skill_runs USING ((org_id = (current_setting('app.current_org_id'::text))::integer)) WITH CHECK ((org_id = (current_setting('app.current_org_id'::text))::integer));


--
-- Name: sla_tiers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sla_tiers ENABLE ROW LEVEL SECURITY;

--
-- Name: sla_tiers sla_tiers_org_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sla_tiers_org_isolation ON public.sla_tiers USING ((org_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::integer));


--
-- Name: storage_files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.storage_files ENABLE ROW LEVEL SECURITY;

--
-- Name: strap_actions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.strap_actions ENABLE ROW LEVEL SECURITY;

--
-- Name: straps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.straps ENABLE ROW LEVEL SECURITY;

--
-- Name: user_prompts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_prompts ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict o0QcpOUPZtwBv0WZzTpPHerD6y9tlICxJfL3l9ehbtwm8uoZeospvrafEVHf17h

