// ─────────────────────────────────────────────────────────────────────────────
// emailThreads.service.js
//
// PROJECT semantics for email: tag a conversation to a project, untag it, hide
// a message, and resolve inheritance.
//
// Mirrors projectFiles.service.js on purpose. The mapping is the analogue of a
// mapped folder:
//
//     project_folders : storage_files   ::   email_threads : emails
//
// PRECEDENCE is the same single guard: thread inheritance never overwrites a
// row whose tag_source = 'manual'.
//
// UNTAG vs HIDE, same as files:
//   untag — drops the mapping and every inherited link. A message someone
//           tagged by hand stays, because the thread is not why it is there.
//   hide  — keeps link and provenance, removes one message from the project
//           view.
//
// DEDUPLICATION is a first-class concern here in a way it is not for files.
// emails_external_id_unique is on external_id alone and Graph issues a distinct
// message id per mailbox, so ONE message sitting in three colleagues' mailboxes
// is three rows. Tagging publishes all three — which is the point — but the
// project view must show one line, not three. See DEDUPE_KEY.
// ─────────────────────────────────────────────────────────────────────────────

const { pool }       = require('../config/database');
const projectMembers = require('./projectMembers.service');

/**
 * The stable identity of a message ACROSS mailboxes.
 *
 * internetMessageId is the RFC 5322 Message-ID: globally unique, and identical
 * in every mailbox that received the copy. It is the correct key, and
 * syncScheduler now captures it into external_data.
 *
 * Rows that predate that capture fall back to a heuristic, because the obvious
 * alternatives do not hold:
 *   • external_id  — per-mailbox by design, so it never collapses anything
 *   • sent_at      — receivedDateTime, i.e. when it landed in THAT mailbox, so
 *                    two copies can differ by a second or two
 * Hence conversation + sender + minute. It can theoretically merge two messages
 * from the same person on the same thread inside one minute; that is a far
 * smaller wrong than showing every message three times, and it self-heals as
 * new mail arrives with a real Message-ID.
 */
const DEDUPE_KEY = `
  COALESCE(
    NULLIF(e.external_data->>'internetMessageId', ''),
    e.conversation_id || '|' || COALESCE(e.from_address, '') || '|' ||
      to_char(COALESCE(e.sent_at, e.created_at), 'YYYY-MM-DD HH24:MI')
  )`;

// ── Authority ────────────────────────────────────────────────────────────────

/** Anyone approved on the project may file a conversation to it. */
async function canFile(handoverId, orgId, userId) {
  if (!userId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM project_members
      WHERE context_type = 'handover' AND context_id = $1
        AND org_id = $2 AND user_id = $3 AND status = 'approved' LIMIT 1`,
    [handoverId, orgId, userId]
  );
  if (rows.length) return true;
  return projectMembers.canManageProject(handoverId, orgId, userId);
}

async function assertCanFile(handoverId, orgId, userId) {
  if (!(await canFile(handoverId, orgId, userId))) {
    throw Object.assign(new Error('You are not on this project'), { status: 403 });
  }
}

/** Reversing a hide changes what the whole team sees. */
async function assertCanManage(handoverId, orgId, userId) {
  if (!(await projectMembers.canManageProject(handoverId, orgId, userId))) {
    throw Object.assign(
      new Error('Only the project owner or an org admin can do that'), { status: 403 });
  }
}

// ── Inheritance ──────────────────────────────────────────────────────────────

/**
 * Apply thread mappings to messages we already hold.
 *
 * Scope is an option, and choosing wrong is a real bug rather than a
 * performance detail — the same trap as projectFiles.resolveFolderMembership,
 * where scoping an untag to the project it was untagged FROM missed the mapping
 * that should reclaim it.
 *
 *   { handoverId }     — after tagging a thread: back-fill that project
 *   { conversationId } — after untagging one message: the mapping that should
 *                        reclaim it may belong to a different project
 */
async function resolveThreadMembership(orgId, { handoverId = null, conversationId = null } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE emails e
        SET handover_id = t.handover_id,
            tag_source  = 'thread',
            tagged_by   = COALESCE(e.tagged_by, t.tagged_by),
            tagged_at   = COALESCE(e.tagged_at, now())
       FROM email_threads t
      WHERE t.org_id = e.org_id
        AND t.conversation_id = e.conversation_id
        AND e.org_id = $1
        AND ($2::int  IS NULL OR t.handover_id = $2)
        AND ($3::text IS NULL OR e.conversation_id = $3)
        AND e.tag_source IS DISTINCT FROM 'manual'
        AND e.handover_id IS DISTINCT FROM t.handover_id`,
    [orgId, handoverId, conversationId]
  );
  return { linked: rowCount };
}

/**
 * The project a conversation belongs to, if any. Called by the mail sync at
 * ingest so a message arriving on a tagged conversation is filed on arrival
 * rather than waiting for someone to notice.
 */
async function projectForConversation(orgId, conversationId) {
  if (!conversationId) return null;
  const { rows } = await pool.query(
    `SELECT handover_id, tagged_by FROM email_threads
      WHERE org_id = $1 AND conversation_id = $2`,
    [orgId, conversationId]
  );
  return rows[0] || null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Conversations filed to this project.
 *
 * Org-scoped, not user-scoped: a thread Alice filed has to be visible to the
 * team, which is the whole point of tagging at thread level.
 */
async function listThreads(handoverId, orgId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.conversation_id, t.subject, t.tagged_at,
            (u.first_name || ' ' || u.last_name) AS tagged_by_name,
            COUNT(DISTINCT ${DEDUPE_KEY}) FILTER (WHERE e.hidden_at IS NULL) AS message_count,
            MAX(COALESCE(e.sent_at, e.created_at))                           AS last_message_at
       FROM email_threads t
       LEFT JOIN users u ON u.id = t.tagged_by
       LEFT JOIN emails e ON e.org_id = t.org_id AND e.conversation_id = t.conversation_id
      WHERE t.handover_id = $1 AND t.org_id = $2
      GROUP BY t.id, u.first_name, u.last_name
      ORDER BY last_message_at DESC NULLS LAST`,
    [handoverId, orgId]
  );
  return { threads: rows };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * File a conversation under a project.
 *
 * Takes the conversation, not a message id — though callers usually have a
 * message, so emailId is accepted and resolved. Every mailbox copy of every
 * message on the conversation is linked, so the project team sees the thread
 * rather than whichever copy the tagger happened to be looking at.
 */
async function tagThread(handoverId, orgId, userId, { conversationId, emailId }) {
  await assertCanFile(handoverId, orgId, userId);

  let convId = conversationId || null;
  let subject = null;

  if (!convId && emailId) {
    const { rows } = await pool.query(
      `SELECT conversation_id, subject FROM emails WHERE id = $1 AND org_id = $2`,
      [emailId, orgId]
    );
    if (!rows.length) throw Object.assign(new Error('Email not found'), { status: 404 });
    convId  = rows[0].conversation_id;
    subject = rows[0].subject;
    if (!convId) {
      // No conversation id means the provider gave us nothing to group on —
      // tag the single message rather than failing outright.
      const { rows: one } = await pool.query(
        `UPDATE emails SET handover_id = $2, tag_source = 'manual',
                tagged_by = $3, tagged_at = now(), hidden_at = NULL, hidden_by = NULL
          WHERE id = $1 AND org_id = $4
          RETURNING id`,
        [emailId, handoverId, userId, orgId]
      );
      return { taggedMessagesOnly: true, messages: one.length, threadless: true };
    }
  }
  if (!convId) throw Object.assign(new Error('conversationId or emailId is required'), { status: 400 });

  if (!subject) {
    const { rows } = await pool.query(
      `SELECT subject FROM emails WHERE org_id = $1 AND conversation_id = $2
        ORDER BY sent_at NULLS LAST LIMIT 1`, [orgId, convId]);
    subject = rows[0]?.subject || null;
  }

  const { rows: clash } = await pool.query(
    `SELECT t.handover_id, h.name AS project_name
       FROM email_threads t LEFT JOIN sales_handovers h ON h.id = t.handover_id
      WHERE t.org_id = $1 AND t.conversation_id = $2`,
    [orgId, convId]
  );
  if (clash.length && clash[0].handover_id !== handoverId) {
    // Moving is legitimate; doing it silently is not.
    await pool.query(
      `UPDATE email_threads SET handover_id = $3, tagged_by = $4, tagged_at = now()
        WHERE org_id = $1 AND conversation_id = $2`,
      [orgId, convId, handoverId, userId]
    );
    // Release inherited links from the previous project before re-resolving,
    // or rows still pointing at it would be skipped by the guard below.
    await pool.query(
      `UPDATE emails SET handover_id = NULL, tag_source = NULL
        WHERE org_id = $1 AND conversation_id = $2 AND tag_source = 'thread'`,
      [orgId, convId]
    );
  } else {
    await pool.query(
      `INSERT INTO email_threads (org_id, conversation_id, handover_id, subject, tagged_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (org_id, conversation_id)
         DO UPDATE SET handover_id = EXCLUDED.handover_id,
                       subject     = COALESCE(EXCLUDED.subject, email_threads.subject),
                       tagged_by   = EXCLUDED.tagged_by,
                       tagged_at   = now()`,
      [orgId, convId, handoverId, subject, userId]
    );
  }

  const out = await resolveThreadMembership(orgId, { conversationId: convId });
  return {
    conversationId: convId,
    messagesLinked: out.linked,
    movedFrom: clash.length && clash[0].handover_id !== handoverId ? clash[0].project_name : null,
  };
}

/**
 * Remove the conversation from the project.
 *
 * Drops the mapping and every inherited link. A message somebody tagged by hand
 * is left alone — the thread mapping is not why it is on the project.
 */
async function untagThread(handoverId, orgId, userId, conversationId) {
  await assertCanFile(handoverId, orgId, userId);

  const { rowCount: mapped } = await pool.query(
    `DELETE FROM email_threads WHERE org_id = $1 AND conversation_id = $2 AND handover_id = $3`,
    [orgId, conversationId, handoverId]
  );
  if (!mapped) throw Object.assign(new Error('That conversation is not on this project'), { status: 404 });

  const { rowCount } = await pool.query(
    `UPDATE emails
        SET handover_id = NULL, tag_source = NULL, tagged_by = NULL, tagged_at = NULL,
            hidden_at = NULL, hidden_by = NULL
      WHERE org_id = $1 AND conversation_id = $2
        AND handover_id = $3 AND tag_source = 'thread'`,
    [orgId, conversationId, handoverId]
  );
  return { untagged: true, messagesReleased: rowCount };
}

/**
 * Hide ONE message from the project view — every mailbox copy of it, or the
 * others would still show.
 */
async function hideMessage(handoverId, orgId, userId, emailId) {
  await assertCanFile(handoverId, orgId, userId);
  const { rows } = await pool.query(
    `WITH target AS (
       SELECT ${DEDUPE_KEY} AS k, e.conversation_id
         FROM emails e WHERE e.id = $1 AND e.org_id = $2
     )
     UPDATE emails e
        SET hidden_at = now(), hidden_by = $4
       FROM target
      WHERE e.org_id = $2 AND e.handover_id = $3 AND e.hidden_at IS NULL
        AND ${DEDUPE_KEY} = target.k
      RETURNING e.id`,
    [emailId, orgId, handoverId, userId]
  );
  if (!rows.length) throw Object.assign(new Error('Message is not on this project, or is already hidden'), { status: 404 });
  return { hidden: true, copies: rows.length };
}

async function unhideMessage(handoverId, orgId, userId, emailId) {
  await assertCanManage(handoverId, orgId, userId);
  const { rows } = await pool.query(
    `WITH target AS (
       SELECT ${DEDUPE_KEY} AS k FROM emails e WHERE e.id = $1 AND e.org_id = $2
     )
     UPDATE emails e
        SET hidden_at = NULL, hidden_by = NULL
       FROM target
      WHERE e.org_id = $2 AND e.handover_id = $3 AND ${DEDUPE_KEY} = target.k
      RETURNING e.id`,
    [emailId, orgId, handoverId]
  );
  if (!rows.length) throw Object.assign(new Error('Message is not on this project'), { status: 404 });
  return { hidden: false, copies: rows.length };
}

module.exports = {
  DEDUPE_KEY,
  canFile,
  resolveThreadMembership, projectForConversation,
  listThreads, tagThread, untagThread, hideMessage, unhideMessage,
};
