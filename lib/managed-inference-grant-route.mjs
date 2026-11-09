const route = '/v1/managed/grants';
const openRoute = '/v1/managed/turns/open';
const finishRoute = '/v1/managed/turns/finish';
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const maxBodyBytes = 1024;

function reply(res, status, body = {error:'grant_unavailable'}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type':'application/json', 'cache-control':'no-store', 'x-content-type-options':'nosniff',
    ...(status !== 200 ? {connection:'close'} : {})
  });
  res.end(JSON.stringify(body));
}

function trustedMethod(owner, name) {
  const method = owner && Object.isFrozen(owner) && Object.getOwnPropertyDescriptor(owner, name)?.value;
  if (typeof method !== 'function') throw new TypeError('Invalid managed grant route owner');
  return method.bind(owner);
}

// Compose behind BuildX HTTPS. Authentication independently verifies the
// bearer and supplies the cloud principal; issue rechecks current turn access.
export function createManagedInferenceGrantRoute({identityOwner, grantOwner, turnOwner = null, timeoutMs = 8000, maxInflight = 16} = {}) {
  const authenticate = trustedMethod(identityOwner, 'authenticate');
  const issue = trustedMethod(grantOwner, 'issue');
  const openTurn = turnOwner === null ? null : trustedMethod(turnOwner, 'open');
  const finishTurn = turnOwner === null ? null : trustedMethod(turnOwner, 'finish');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000 ||
      !Number.isSafeInteger(maxInflight) || maxInflight < 1 || maxInflight > 64) throw new TypeError('Invalid grant route limits');
  const pending = new Set();
  let closed = false;

  async function handle(req, res) {
    if (closed) { reply(res,503); return; }
    if (req.method !== 'POST' || ![route,openRoute,finishRoute].includes(req.url) || (req.url !== route && !openTurn)) { reply(res,404); return; }
    const authorization = req.headers.authorization;
    const accessToken = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_.~+\/=-]{1,16384})$/.exec(authorization)?.[1];
    if (!accessToken || req.headersDistinct.authorization?.length !== 1) { reply(res,401); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') ||
        req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') { reply(res,415); return; }
    const declared = req.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBodyBytes)) { reply(res,413); return; }
    if (pending.size >= maxInflight) { reply(res,503); return; }

    const controller = new AbortController();
    const signal = controller.signal;
    const stop = status => {
      controller.abort();
      if (status) reply(res,status);
    };
    pending.add(stop);
    const onClose = () => { if (!res.writableFinished) stop(); };
    res.once('close', onClose);
    const timer = setTimeout(() => stop(408), timeoutMs);
    timer.unref?.();
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req.iterator({destroyOnReturn:false})) {
        if (signal.aborted) return;
        size += chunk.length;
        if (size > maxBodyBytes) { reply(res,413); return; }
        chunks.push(chunk);
      }
      if (signal.aborted) return;
      const body = new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks,size));
      // A single literal property prevents ambiguous duplicate keys and
      // keeps identity, model and expiry outside the client-supplied schema.
      const turnId = /^[ \t\r\n]*\{[ \t\r\n]*"turnId"[ \t\r\n]*:[ \t\r\n]*"([A-Za-z0-9_.:-]{1,200})"[ \t\r\n]*\}[ \t\r\n]*$/.exec(body)?.[1];
      if (req.url === openRoute) {
        if (!/^[ \t\r\n]*\{[ \t\r\n]*\}[ \t\r\n]*$/.test(body)) { reply(res,400); return; }
        let result;
        try { result = await openTurn({accessToken,signal}); }
        catch { if (!signal.aborted) reply(res,503); return; }
        if (signal.aborted) return;
        if (result === null) { reply(res,403); return; }
        if (!id(result?.turnId) || !Number.isSafeInteger(result.expiresAt)) { reply(res,503); return; }
        reply(res,200,{turnId:result.turnId,expiresAt:result.expiresAt});
        return;
      }
      if (!turnId) { reply(res,400); return; }
      if (req.url === finishRoute) {
        let result;
        try { result = await finishTurn({accessToken,turnId,signal}); }
        catch { if (!signal.aborted) reply(res,503); return; }
        if (signal.aborted) return;
        if (result === false) { reply(res,403); return; }
        if (result !== true) { reply(res,503); return; }
        reply(res,200,{closed:true});
        return;
      }
      let identity;
      try { identity = await authenticate({accessToken,signal}); }
      catch { if (!signal.aborted) reply(res,503); return; }
      if (signal.aborted) return;
      if (identity?.verified !== true || !id(identity.sessionId) || !id(identity.accountId) ||
          !Number.isSafeInteger(identity.expiresAt)) { reply(res,401); return; }
      let grant;
      try {
        grant = await issue({sessionId:identity.sessionId,accountId:identity.accountId,
          authorizationExpiresAt:identity.expiresAt,turnId,signal});
      } catch { if (!signal.aborted) reply(res,503); return; }
      if (signal.aborted) return;
      if (!grant || grant.turnId !== turnId || typeof grant.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grant.token) ||
          grant.token === accessToken || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt > identity.expiresAt) {
        reply(res,403);
        return;
      }
      reply(res,200,{token:grant.token,turnId,expiresAt:grant.expiresAt});
    } catch {
      if (!signal.aborted) reply(res,400);
    } finally {
      clearTimeout(timer);
      res.removeListener('close',onClose);
      pending.delete(stop);
    }
  }

  function close() {
    closed = true;
    for (const stop of pending) stop(503);
    return {closed:pending.size === 0,pending:pending.size};
  }
  return Object.freeze({handle,close});
}
