/**
 * utils/aiGateErrors.js
 *
 * AIClientResolver.resolve() refuses a call for three policy reasons, each a
 * thrown Error carrying statusCode + code:
 *
 *   402 ENTITLEMENT_REQUIRED     the org's plan doesn't include AI
 *   403 AI_DISABLED_BY_ORG       an admin turned AI off for the org
 *   429 AI_DAILY_BUDGET_REACHED  this person has used today's AI budget
 *
 * Routes that call AI directly used to answer every failure with a 500 and
 * "AI generation failed: <message>", which reads as a crash. Put this at the
 * top of the route's catch block so these come back with their real status
 * and a message written for the person:
 *
 *     } catch (err) {
 *       if (sendAiGateError(res, err)) return;
 *       ...existing 500 handling...
 *     }
 *
 * Returns true when it sent the response.
 */

const AI_GATE_CODES = new Set([
  'ENTITLEMENT_REQUIRED',
  'AI_DISABLED_BY_ORG',
  'AI_DAILY_BUDGET_REACHED',
]);

function isAiGateError(err) {
  return !!(err && AI_GATE_CODES.has(err.code) && err.statusCode);
}

function sendAiGateError(res, err) {
  if (!isAiGateError(err) || res.headersSent) return false;
  const body = { error: { message: err.message, code: err.code } };
  if (err.code === 'AI_DAILY_BUDGET_REACHED') {
    body.error.spent_usd = err.spentUsd;
    body.error.limit_usd = err.limitUsd;
    body.error.resets_at = err.resetsAt;
  }
  res.status(err.statusCode).json(body);
  return true;
}

module.exports = { AI_GATE_CODES, isAiGateError, sendAiGateError };
