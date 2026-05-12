/**
 * CallOutcomeMirrorService
 *
 * Cross-table writes that happen alongside every prospect_calls insert:
 *
 *   1. Mirror row in prospecting_activities  — activity_type='call_logged'
 *      with a formatted description. This keeps the unified activity
 *      timeline working (SkillContextService, ProspectContextBuilder etc.
 *      all read prospecting_activities) without each consumer having to
 *      know about prospect_calls.
 *
 *   2. Update prospects.channel_data.call    — JSONB merge holding the
 *      latest call status. Drives the CALL line in the prospect drawer's
 *      timeline header. Same pattern as channel_data.linkedin today.
 *
 *   3. Bump prospects.outreach_count / response_count when appropriate —
 *      every call is an outreach; connected calls also count as a response.
 *
 * The functions take a db client (transaction-aware) so the caller can wrap
 * the prospect_calls insert AND the mirror writes in a single transaction.
 */

const db = require('../config/database');

class CallOutcomeMirrorService {

  // ── Public: write all mirror state for a freshly-inserted call ───────────
  // Takes the call row (as returned by the INSERT ... RETURNING *) and the
  // outcome object (resolved from CallSettingsService.resolveOutcome so we
  // have the label for the description string).
  //
  // client: a db client in a transaction. The caller is responsible for
  //         BEGIN/COMMIT — this function only issues queries against the
  //         passed client.
  static async mirrorNewCall(client, call, outcome) {
    const description = this._formatDescription(call, outcome);
    const metadata = {
      call_id:           call.id,
      outcome:           call.outcome,
      duration_seconds:  call.duration_seconds,
      direction:         call.direction,
    };

    // 1. Mirror activity row.
    await client.query(
      `INSERT INTO prospecting_activities
         (prospect_id, user_id, activity_type, description, metadata)
       VALUES ($1, $2, 'call_logged', $3, $4)`,
      [call.prospect_id, call.user_id, description, JSON.stringify(metadata)]
    );

    // 2. Update prospects.channel_data.call (JSONB merge).
    //    Read current channel_data, mutate, write back. We hold the row
    //    lock for the duration (FOR UPDATE) since we're in a transaction.
    const pRes = await client.query(
      `SELECT channel_data, outreach_count, response_count
         FROM prospects
        WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [call.prospect_id, call.org_id]
    );
    if (pRes.rows.length === 0) {
      // Prospect was deleted mid-transaction. Caller should handle the
      // rollback; we just bail out.
      throw new Error(`Prospect ${call.prospect_id} not found while mirroring call`);
    }

    const p              = pRes.rows[0];
    const channelData    = p.channel_data || {};
    const callBucket     = channelData.call || {};
    const isConnected    = this._isConnected(call.outcome);
    const isVoicemail    = call.outcome === 'voicemail_left';
    const isDnc          = call.outcome === 'do_not_call';

    callBucket.last_outcome      = call.outcome;
    callBucket.last_call_at      = call.occurred_at;
    callBucket.last_call_user_id = call.user_id;
    callBucket.total_calls       = (callBucket.total_calls || 0) + 1;
    if (isConnected) callBucket.connected_count = (callBucket.connected_count || 0) + 1;
    if (isVoicemail) callBucket.voicemail_count = (callBucket.voicemail_count || 0) + 1;
    if (isDnc)       callBucket.dnc_at          = call.occurred_at;

    channelData.call = callBucket;

    // 3. Bump counts. Every call is an outreach. Connected calls are also
    //    a response (the prospect engaged back, even if briefly).
    const newOutreachCount = (p.outreach_count || 0) + 1;
    const newResponseCount = isConnected
      ? (p.response_count || 0) + 1
      : (p.response_count || 0);

    await client.query(
      `UPDATE prospects
         SET channel_data    = $1::jsonb,
             outreach_count  = $2,
             response_count  = $3,
             updated_at      = CURRENT_TIMESTAMP
       WHERE id = $4 AND org_id = $5`,
      [
        JSON.stringify(channelData),
        newOutreachCount,
        newResponseCount,
        call.prospect_id,
        call.org_id,
      ]
    );
  }

  // ── Public: update the mirror when a call is edited ──────────────────────
  // For PATCH /prospect-calls/:id. We don't try to roll back/replay the
  // channel_data counters — they're approximate signals anyway and an edit
  // to a single field (notes, outcome typo) shouldn't reshuffle them. We
  // do update the mirror activity row's description and metadata to reflect
  // the edit, so the activity feed shows the latest state.
  //
  // Returns true if we updated the activity row, false if we couldn't find
  // one (caller can decide how to handle — probably ignore).
  static async mirrorEditedCall(client, call, outcome) {
    const description = this._formatDescription(call, outcome);
    const metadata = {
      call_id:           call.id,
      outcome:           call.outcome,
      duration_seconds:  call.duration_seconds,
      direction:         call.direction,
      edited:            true,
    };

    const result = await client.query(
      `UPDATE prospecting_activities
          SET description = $1,
              metadata    = $2,
              updated_at  = CURRENT_TIMESTAMP
        WHERE activity_type = 'call_logged'
          AND prospect_id   = $3
          AND (metadata ->> 'call_id')::int = $4
        RETURNING id`,
      [description, JSON.stringify(metadata), call.prospect_id, call.id]
    );
    return result.rows.length > 0;
  }

  // ── Public: clean up the mirror when a call is deleted ───────────────────
  // For DELETE /prospect-calls/:id (eventually). Soft-deletes the mirror
  // activity row by updating its description; we don't actually remove
  // from prospecting_activities since the timeline should reflect that
  // a call WAS logged then retracted.
  //
  // Not used in Phase 1 (no DELETE endpoint yet), but here for completeness.
  static async mirrorDeletedCall(client, callId, prospectId) {
    await client.query(
      `UPDATE prospecting_activities
          SET description = '[Call log deleted]',
              metadata    = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('deleted', true),
              updated_at  = CURRENT_TIMESTAMP
        WHERE activity_type = 'call_logged'
          AND prospect_id   = $1
          AND (metadata ->> 'call_id')::int = $2`,
      [prospectId, callId]
    );
  }

  // ── Internal: build the human-readable description string ───────────────
  // Used for prospecting_activities.description. Short, scannable, sentence-
  // shaped so the unified timeline can render it without a custom renderer.
  // Examples:
  //   "Connected — meaningful conversation (12 min)"
  //   "Voicemail — left message"
  //   "No answer"
  //   "Do not call — explicit request"
  static _formatDescription(call, outcome) {
    const label = (outcome && outcome.label) || call.outcome;
    if (call.duration_seconds && call.duration_seconds > 0) {
      const min = Math.round(call.duration_seconds / 60);
      // Keep it tight; full notes show in the call card detail view.
      return `${label} (${min} min)`;
    }
    return label;
  }

  // ── Internal: connected = the prospect actually engaged ──────────────────
  // Connected outcomes count as a "response" for prospect.response_count.
  // Used for analytics signals (e.g. contact rate). Keep this list in sync
  // with the system-default outcomes in CallSettingsService — the keys are
  // stable identifiers, not org-customizable.
  static _isConnected(outcomeKey) {
    return outcomeKey === 'connected_meaningful' ||
           outcomeKey === 'connected_brief' ||
           outcomeKey === 'callback_requested';
  }
}

module.exports = CallOutcomeMirrorService;
