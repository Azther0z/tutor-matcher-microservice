const jwt = require('jsonwebtoken');

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Traefik calls this private endpoint before admitting a protected request.
// The database owns the identity; caller-supplied identity headers are ignored.
function createGatewayAuthorization({ pool, jwtSecret }) {
  if (!jwtSecret) throw new Error('JWT_SECRET is required');

  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const [scheme, token, extra] = (req.get('authorization') || '').split(' ');
    if (scheme !== 'Bearer' || !token || extra) {
      return res.status(401).json({ error: 'Sign in first: missing Bearer token' });
    }

    let claims;
    try {
      claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
      if (typeof claims.sub !== 'string' || !USER_ID.test(claims.sub)) throw new Error('Invalid subject');
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    try {
      const { rows } = await pool.query('SELECT id, email FROM users WHERE id = $1', [claims.sub]);
      if (!rows[0]) return res.status(401).json({ error: 'Account is unavailable' });
      res.set('X-User-Id', rows[0].id);
      res.set('X-User-Email', rows[0].email);
      return res.status(204).end();
    } catch {
      return res.status(503).json({ error: 'Authorization is unavailable' });
    }
  };
}

module.exports = { createGatewayAuthorization };
