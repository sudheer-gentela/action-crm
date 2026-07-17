// ─────────────────────────────────────────────────────────────────────────────
// impersonation.middleware.js
//
// blockImpersonatedWrites — global read-only guard for impersonation sessions.
//
// A super admin can mint a short-lived "impersonation" JWT that carries a
// target user's identity (see POST /api/super/users/:userId/impersonate).
// Such a token is marked with `imp: true`. While that token is in use we run
// the app in READ-ONLY mode: any state-changing HTTP method is rejected before
// it reaches a route handler.
//
// WHY A SINGLE GLOBAL GUARD (not per-route):
//   Actor attribution in this codebase is decentralised — req.userId is stamped
//   into created_by / changed_by / actor_id / … across ~600 write sites, and in
//   an impersonation session req.userId IS the impersonated user. There is no
//   central write chokepoint to override. Blocking by HTTP method at the edge is
//   the one place that reliably catches every mutation with zero route edits.
//
// MOUNT (server.js) — AFTER body parsing, BEFORE the /api route mounts:
//   app.use(require('./middleware/impersonation.middleware').blockImpersonatedWrites);
//
// DESIGN NOTES:
//   • This guard does NOT authenticate. It only inspects the token to decide
//     whether to hard-stop a write. A missing/invalid/forged token is ignored
//     here and left for the per-route authenticateToken to reject normally.
//   • Signature IS verified (jwt.verify). A token whose signature doesn't check
//     out is treated as "not an impersonation session" and passed through — the
//     downstream auth will reject it. We never trust an unverified `imp` claim.
//   • Read methods (GET/HEAD/OPTIONS) always pass. A handful of legitimately
//     read-only endpoints use POST (search/filter/reporting). If you later need
//     one reachable during impersonation, add it to READ_POST_ALLOWLIST rather
//     than loosening the method rule.
//   • /api/auth/* is exempt so token refresh/logout still function; the refresh
//     route has its own impersonation handling (it refuses to extend an imp
//     session). This exemption is auth plumbing, not org-data mutation.
//
// FUTURE (if you enable a narrow write path):
//   Don't remove this guard wholesale. Instead give specific whitelisted write
//   actions their own routes that opt out, and stamp the real actor via
//   req.impersonator_id (present on the token) into an audit overlay. Keep the
//   per-row owner as the impersonated user; record the true actor in
//   super_admin_audit_log. See the write-up accompanying this change.
// ─────────────────────────────────────────────────────────────────────────────

const jwt = require('jsonwebtoken');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Path prefixes that are always allowed even during an impersonation session.
// Auth plumbing only — never org-scoped data mutation.
const PATH_EXEMPT_PREFIXES = ['/api/auth/'];

// Exact paths that are POST-but-read-only and safe to allow during
// impersonation. Extend deliberately, one endpoint at a time.
const READ_POST_ALLOWLIST = new Set([
  // e.g. '/api/prospects/search',
]);

const blockImpersonatedWrites = (req, res, next) => {
  // Fast path: reads are never blocked.
  if (!WRITE_METHODS.has(req.method)) return next();

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next(); // no token — not our concern; per-route auth handles it

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    // Invalid/expired/forged — not a trusted impersonation session. Let the
    // per-route authenticateToken produce the correct 401/403.
    return next();
  }

  // Not an impersonation token → normal user, no restriction here.
  if (!decoded || decoded.imp !== true) return next();

  // ── We are in an impersonation session and this is a write ──────────────────

  // Auth plumbing (refresh/logout) stays available.
  const path = req.path || req.originalUrl || '';
  if (PATH_EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return next();

  // Deliberately-allowlisted read-via-POST endpoints.
  if (READ_POST_ALLOWLIST.has(path)) return next();

  // Everything else that mutates is blocked.
  console.warn(
    `[IMPERSONATION] Blocked ${req.method} ${path} — read-only support session ` +
    `(impersonator ${decoded.impersonator_id} acting as user ${decoded.userId})`
  );
  return res.status(403).json({
    error: {
      message: 'This is a read-only support (impersonation) session. Writes are disabled.',
      code: 'IMPERSONATION_READ_ONLY',
    },
  });
};

module.exports = { blockImpersonatedWrites };
