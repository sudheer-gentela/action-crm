// contractNotificationService.js
// All CLM notification triggers. Non-fatal — workflow always continues on failure.
// v2: legalIds() now uses department field; new notifyPendingBooking added.

const { pool } = require('../config/database');

async function insert(userId, orgId, type, title, body, refId) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id,org_id,type,title,body,reference_id,reference_type,is_read,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'contract',FALSE,NOW()) ON CONFLICT DO NOTHING`,
      [userId, orgId, type, title, body, refId]
    );
  } catch (err) { console.error('CLM notify:', err.message); }
}

async function name(userId) {
  try {
    const r = await pool.query(`SELECT first_name, last_name FROM users WHERE id=$1`, [userId]);
    return r.rows[0] ? `${r.rows[0].first_name} ${r.rows[0].last_name}` : 'Someone';
  } catch { return 'Someone'; }
}

// v2: legal team members identified by department = 'legal'
async function legalIds(orgId) {
  try {
    const r = await pool.query(
      `SELECT u.id AS user_id
       FROM org_users ou
       JOIN users u ON u.id = ou.user_id
       WHERE ou.org_id = $1
         AND u.department = 'legal'
         AND ou.is_active = TRUE`,
      [orgId]
    );
    return r.rows.map(x => x.user_id);
  } catch { return []; }
}

// Submitted to queue
async function notifyLegalQueueSubmission(orgId, contractId, title, submitterId) {
  const [ids, n] = await Promise.all([legalIds(orgId), name(submitterId)]);
  await Promise.all(ids.map(uid =>
    insert(uid, orgId, 'clm_queue', 'Contract needs legal review',
      `${n} submitted "${title}" to the legal queue`, contractId)
  ));
}

// Submitted to named assignee
async function notifyLegalAssigneeSubmission(orgId, contractId, title, submitterId, assigneeId) {
  const n = await name(submitterId);
  await insert(assigneeId, orgId, 'clm_assigned', 'Contract assigned to you for review',
    `${n} assigned "${title}" to you for legal review`, contractId);
}

// Picked up
async function notifyLegalPickedUp(orgId, contractId, title, ownerId, legalUserId) {
  const n = await name(legalUserId);
  await insert(ownerId, orgId, 'clm_picked_up', 'Legal reviewer assigned',
    `${n} picked up "${title}" for legal review`, contractId);
}

// Reassigned
async function notifyLegalReassigned(orgId, contractId, title, newAssigneeId, byId) {
  const n = await name(byId);
  await insert(newAssigneeId, orgId, 'clm_reassigned', 'Contract assigned to you',
    `${n} assigned "${title}" to you for legal review`, contractId);
}

// Returned to sales
async function notifyReturnedToSales(orgId, contractId, title, ownerId, legalUserId) {
  const n = await name(legalUserId);
  await insert(ownerId, orgId, 'clm_returned', 'Contract returned after legal review',
    `${n} completed review of "${title}" — it's back with you`, contractId);
}

// Resubmitted
async function notifyResubmittedToLegal(orgId, contractId, title, assigneeId, teamIds, submitterId) {
  const n = await name(submitterId);
  if (assigneeId) {
    await insert(assigneeId, orgId, 'clm_resubmitted', 'New redlines for review',
      `${n} uploaded new redlines for "${title}"`, contractId);
  } else {
    await Promise.all(teamIds.map(uid =>
      insert(uid, orgId, 'clm_resubmitted', 'New redlines in queue',
        `${n} resubmitted "${title}" with new redlines`, contractId)
    ));
  }
}

// Approval needed
async function notifyApprovalNeeded(orgId, contractId, title, approverIds) {
  await Promise.all(approverIds.map(uid =>
    insert(uid, orgId, 'clm_approval_needed', 'Contract approval required',
      `You have a contract approval request for "${title}"`, contractId)
  ));
}

// Approval rejected
async function notifyApprovalRejected(orgId, contractId, title, ownerId, rejectorId) {
  const n = await name(rejectorId);
  await insert(ownerId, orgId, 'clm_approval_rejected', 'Contract approval rejected',
    `${n} rejected the approval for "${title}"`, contractId);
}

// All approved
async function notifyApprovalCompleted(orgId, contractId, title, ownerId) {
  await insert(ownerId, orgId, 'clm_approved', 'Contract fully approved',
    `All approvals complete — "${title}" is ready to send for signature`, contractId);
}

// Next approval step
async function notifyNextApprovers(orgId, contractId, title, approverIds) {
  await Promise.all(approverIds.map(uid =>
    insert(uid, orgId, 'clm_approval_needed', 'Contract approval required',
      `Your approval is needed for "${title}"`, contractId)
  ));
}

// All signed
async function notifyAllSigned(orgId, contractId, title, ownerId) {
  await insert(ownerId, orgId, 'clm_signed', 'Contract fully signed',
    `"${title}" has been signed`, contractId);
}

// v2: NEW — notify owner that signed contract needs deal desk submission
async function notifyPendingBooking(orgId, contractId, title, ownerId) {
  await insert(ownerId, orgId, 'clm_pending_booking',
    'Action required: Submit signed contract to deal desk',
    `"${title}" has been signed. Please submit to deal desk to complete booking.`,
    contractId);
}

// ── Cron: unsigned contracts follow-up (3/7/14 days) ─────────────────
async function notifyUnsignedContracts() {
  let count = 0;
  for (const days of [3, 7, 14]) {
    try {
      const r = await pool.query(
        `SELECT id, title, owner_id, org_id FROM contracts
         WHERE status='in_signatures'
           AND DATE_PART('day', NOW()-updated_at) = $1
           AND deleted_at IS NULL`, [days]
      );
      for (const row of r.rows) {
        await insert(row.owner_id, row.org_id, 'clm_unsigned_followup',
          `Contract unsigned for ${days} days`,
          `"${row.title}" has been awaiting signatures for ${days} days`, row.id);
        count++;
      }
    } catch (err) { console.error(`notifyUnsigned(${days}d):`, err.message); }
  }
  return count;
}

// ── Cron: expiring contracts (30/7/1 days before expiry_date) ─────────
async function notifyExpiringContracts() {
  let count = 0;
  for (const days of [30, 7, 1]) {
    try {
      const r = await pool.query(
        `SELECT id, title, owner_id, org_id FROM contracts
         WHERE status='active' AND expiry_date IS NOT NULL
           AND DATE_PART('day', expiry_date - CURRENT_DATE) = $1
           AND deleted_at IS NULL`, [days]
      );
      for (const row of r.rows) {
        await insert(row.owner_id, row.org_id, 'clm_expiring_soon',
          `Contract expiring in ${days} day${days > 1 ? 's' : ''}`,
          `"${row.title}" expires in ${days} day${days > 1 ? 's' : ''}`, row.id);
        count++;
      }
    } catch (err) { console.error(`notifyExpiring(${days}d):`, err.message); }
  }
  return count;
}

module.exports = {
  notifyLegalQueueSubmission, notifyLegalAssigneeSubmission,
  notifyLegalPickedUp, notifyLegalReassigned, notifyReturnedToSales,
  notifyResubmittedToLegal, notifyApprovalNeeded, notifyApprovalRejected,
  notifyApprovalCompleted, notifyNextApprovers, notifyAllSigned,
  notifyPendingBooking,
  notifyUnsignedContracts, notifyExpiringContracts,
};
