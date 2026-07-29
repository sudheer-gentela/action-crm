/**
 * invitations.routes.js  (PUBLIC — no auth; token is the credential)
 *
 * DROP-IN LOCATION: backend/routes/invitations.routes.js
 * Mount in server.js BEFORE the auth-required routers:
 *   app.use('/api/invitations', require('./routes/invitations.routes'));
 *
 *   GET  /:token          preview (org name, email) for the accept page
 *   POST /:token/accept    { firstName, lastName, password } → provision + accept
 */
'use strict';

const express = require('express');
const router  = express.Router();
const svc     = require('../services/inviteProvisioning.service');

const send = (res, p) => p
  .then(out => res.json(out))
  .catch(e => res.status(e.status || 500).json({ error: { message: e.message, code: e.code } }));

router.get('/:token', (req, res) => send(res, svc.getByToken(req.params.token)));

router.post('/:token/accept', (req, res) =>
  send(res, svc.acceptInvite(req.params.token, req.body || {})));

module.exports = router;
