// backend/middleware/auth.js
// requireAuth  — verifies JWT from Authorization: Bearer <token>
//                attaches decoded payload to req.user; 401 if missing/invalid
// requireRole  — factory that checks req.user.role; 403 if not matching
const jwt = require('jsonwebtoken');

/**
 * Middleware: verifies the Bearer token and populates req.user = { id, role }.
 */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authorization token required' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Middleware factory: requires req.user.role === role, else 403.
 * Must be used after requireAuth.
 * Usage: router.post('/approve', requireAuth, requireRole('approver'), handler)
 */
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `Forbidden — requires role: ${role}` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
