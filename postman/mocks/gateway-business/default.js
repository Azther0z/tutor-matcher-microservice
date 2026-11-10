const http = require('node:http');

// Routing probe: target public discovery plus historical demo paths. No business implementation.
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ status: 'OK', service: 'gateway-routing-probe' }));
  }
  if (!/^\/(discovery\/tutors|tutors|availability|bookings|wallet)(\/|\?|$)/.test(req.url)) {
    res.writeHead(501, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Outside gateway probe contract' }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({
    method: req.method,
    url: req.url,
    body: req.body,
    instance: req.headers['x-test-instance'],
    userId: req.headers['x-user-id'] || null,
    email: req.headers['x-user-email'] || null,
    hasAuthorization: Boolean(req.headers.authorization),
    hasActorContext: Boolean(req.headers['x-actor-context']),
  }));
}).listen(process.env.PORT);
