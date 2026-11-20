// ─────────────────────────────────────────────────────────────────────────────
// SequenceAvailability.js
// ─────────────────────────────────────────────────────────────────────────────
// One wording for "you can't enroll into this sequence", shared by every
// enrollment path:
//   • routes/sequences.routes.js            POST /enroll
//   • routes/prospects.routes.js            prospect create with sequenceId
//   • routes/prospecting-campaigns.routes.js  enroll-all, bulk-activate,
//                                             enroll-one, enroll-batch
//
// Every path only enrolls into status='active'. Before this module four of them
// answered a draft or archived sequence with "Sequence not found" — wrong for a
// sequence the rep can see in the list (agent-created drafts are shared), and
// it hid the fix (Publish). Routes keep their own active-only query for the
// happy path and call describeUnavailable() only when that query found nothing,
// so the common case costs no extra query.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Human message for a sequence that exists but can't be enrolled into.
 *
 * @param {object} seq            - { status, name } (name optional)
 * @param {'campaign'|'direct'} context
 *        'campaign' when the sequence is a campaign's default (the fix for an
 *        archived one is changing the campaign); 'direct' when the rep picked
 *        the sequence itself.
 * @returns {null | { message: string, code: string }} null when status is 'active'.
 */
function unavailableReason(seq, context = 'direct') {
  const st = seq?.status;
  if (st === 'active') return null;
  const label = seq?.name ? `"${seq.name}"` : (context === 'campaign' ? "This campaign's sequence" : 'This sequence');
  if (st === 'draft') {
    return {
      message: `${label} is still a draft. Review it and click Publish in Sequences before enrolling prospects.`,
      code: 'SEQUENCE_DRAFT',
    };
  }
  if (st === 'archived') {
    return {
      message: context === 'campaign'
        ? `${label} is archived. Set a different default sequence on the campaign before enrolling prospects.`
        : `${label} is archived. Choose an active sequence to enroll prospects into.`,
      code: 'SEQUENCE_ARCHIVED',
    };
  }
  // NULL means the campaign points at a sequence row that no longer exists;
  // anything else is a state we don't enroll into.
  return {
    message: `${label} can't be enrolled into (status: ${st || 'missing'}). ` +
      (context === 'campaign' ? 'Set an active default sequence on the campaign first.' : 'Choose an active sequence.'),
    code: 'SEQUENCE_NOT_ACTIVE',
  };
}

/**
 * Called after a route's active-only lookup returned no row: explains why.
 * Looks the sequence up again WITHOUT the status filter (still org-scoped).
 *
 * @param {{query: Function}} db - pool or client
 * @returns {Promise<null | { message: string, code: string }>}
 *          null when the sequence genuinely doesn't exist in this org — the
 *          caller then keeps its own "not found" response unchanged.
 */
async function describeUnavailable(db, orgId, sequenceId, context = 'direct') {
  const id = parseInt(sequenceId, 10);
  if (!Number.isInteger(id)) return null;
  const { rows } = await db.query(
    `SELECT name, status FROM sequences WHERE id = $1 AND org_id = $2`,
    [id, orgId]
  );
  if (!rows.length) return null;
  return unavailableReason(rows[0], context);
}

module.exports = { unavailableReason, describeUnavailable };
