const jwt = require('jsonwebtoken');

// ─────────────────────────────────────────────────────────────
// authenticateToken
//
// Unchanged behaviour for all existing routes:
//   - Reads Bearer token from Authorization header
//   - Verifies JWT signature
//   - Puts decoded payload on req.user
//
// New in multi-org:
//   - Also exposes req.userId and req.orgId as top-level
//     shorthand so route handlers don't need req.user.id
//
// JWT key note:
//   auth.routes.js signs tokens with key 'userId' (not 'id' or
//   'sub'). We check all three variants so this middleware works
//   regardless of which key was used when the token was signed.
// ─────────────────────────────────────────────────────────────
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: { message: 'Access token required' } });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user   = decoded;                                        // full payload — backwards compat
    req.userId = decoded.userId || decoded.id || decoded.sub;   // JWT uses 'userId' key
    req.orgId  = decoded.org_id || null;                        // populated once JWT is updated
    next();
  } catch (error) {
    return res.status(403).json({ error: { message: 'Invalid or expired token' } });
  }
};

module.exports = authenticateToken;
