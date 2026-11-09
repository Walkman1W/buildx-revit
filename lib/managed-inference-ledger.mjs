import {DatabaseSync} from 'node:sqlite';
import {decideManagedInference} from './managed-membership-policy.mjs';

const states = new Set(['settled', 'pending_reconciliation', 'not_dispatched']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const units = value => Number.isSafeInteger(value) && value >= 0;
const denied = () => Object.assign(new Error('Managed inference is not authorized'), {code:'MANAGED_INFERENCE_DENIED'});

// Single-provider pilot ledger. Only the cloud service may call grantTrial or
// inject credit rates. A missing terminal result leaves its reservation held.
export function openManagedInferenceLedger({filename, reserveCredits, creditsForUsage, now = Date.now} = {}) {
  if (typeof filename !== 'string' || !filename || typeof reserveCredits !== 'function' ||
      typeof creditsForUsage !== 'function' || typeof now !== 'function') throw new TypeError('Invalid inference ledger configuration');
  const db = new DatabaseSync(filename);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS managed_trial (
        account_id TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        credits INTEGER NOT NULL CHECK (credits >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS managed_inference_request (
        request_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES managed_trial(account_id),
        turn_id TEXT,
        model TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved','pending_reconciliation','settled','not_dispatched','duplicate_response')),
        reserved INTEGER NOT NULL CHECK (reserved >= 0),
        response_id TEXT UNIQUE,
        input_tokens INTEGER,
        output_tokens INTEGER,
        charged INTEGER NOT NULL DEFAULT 0 CHECK (charged >= 0)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS managed_request_account ON managed_inference_request(account_id, turn_id);
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  const grant = db.prepare('INSERT INTO managed_trial VALUES (?, ?, ?)');
  const totals = db.prepare(`
    SELECT t.expires_at, t.credits, COALESCE(SUM(r.reserved),0) AS held, COALESCE(SUM(r.charged),0) AS charged
    FROM managed_trial t LEFT JOIN managed_inference_request r ON r.account_id = t.account_id
    WHERE t.account_id = ? GROUP BY t.account_id
  `);
  const insert = db.prepare("INSERT INTO managed_inference_request (request_id, account_id, turn_id, model, state, reserved) VALUES (?, ?, ?, ?, 'reserved', ?)");
  const lookup = db.prepare('SELECT * FROM managed_inference_request WHERE request_id = ?');
  const response = db.prepare('SELECT account_id, model, input_tokens, output_tokens FROM managed_inference_request WHERE response_id = ?');
  const update = db.prepare('UPDATE managed_inference_request SET state = ?, reserved = ?, response_id = ?, input_tokens = ?, output_tokens = ?, charged = ? WHERE request_id = ?');
  const byTurn = db.prepare('SELECT request_id, state, reserved, input_tokens, output_tokens, charged FROM managed_inference_request WHERE account_id = ? AND turn_id = ? ORDER BY rowid');

  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function balance(accountId) {
    const row = totals.get(accountId);
    if (!row) return null;
    const {expires_at:expiresAt, credits, held, charged} = row;
    return {expiresAt, held, charged, available:credits-held-charged};
  }
  function grantTrial({accountId, expiresAt, credits}) {
    if (!identifier(accountId) || !units(credits) || !units(expiresAt) || expiresAt <= now()) throw new TypeError('Invalid trial grant');
    grant.run(accountId, expiresAt, credits);
  }
  function begin({requestId, model, inputBytes, maxOutputTokens, authorizationDecision}) {
    const {accountId, turnId = null} = authorizationDecision ?? {};
    if (!identifier(requestId) || !identifier(accountId) || (turnId !== null && !identifier(turnId)) ||
        typeof model !== 'string' || !model || model.length > 200 || !units(inputBytes) || !inputBytes ||
        !units(maxOutputTokens) || !maxOutputTokens) throw denied();
    const reserved = reserveCredits({model, inputBytes, maxOutputTokens});
    if (!units(reserved) || !reserved) throw denied();
    return transaction(() => {
      const wallet = balance(accountId);
      const entitlement = decideManagedInference({
        account:wallet && {status:'active'},
        membership:wallet && {status:'active', expiresAt:wallet.expiresAt},
        credits:wallet,
        now:now()
      });
      if (!entitlement.allowed || reserved > wallet.available || lookup.get(requestId)) throw denied();
      insert.run(requestId, accountId, turnId, model, reserved);
      return accountId;
    });
  }
  function finish({requestId, context, state, responseId, usage}) {
    if (!identifier(requestId) || !states.has(state)) throw new TypeError('Invalid inference result');
    transaction(() => {
      const entry = lookup.get(requestId);
      if (!entry || context !== entry.account_id) throw denied();
      if (!['reserved','pending_reconciliation'].includes(entry.state)) return;
      if (state === 'not_dispatched' && entry.state === 'reserved') {
        update.run(state, 0, null, null, null, 0, requestId);
        return;
      }
      if (state === 'settled' && identifier(responseId) && units(usage?.inputTokens) && units(usage?.outputTokens) &&
          units(usage?.totalTokens) && usage.inputTokens + usage.outputTokens === usage.totalTokens) {
        const seen = response.get(responseId);
        if (seen?.account_id === entry.account_id && seen.model === entry.model &&
            seen.input_tokens === usage.inputTokens && seen.output_tokens === usage.outputTokens) {
          update.run('duplicate_response', 0, null, null, null, 0, requestId);
          return;
        }
        if (!seen) {
          const charged = creditsForUsage({model:entry.model, ...usage});
          if (units(charged) && charged <= entry.reserved) {
            update.run('settled', 0, responseId, usage.inputTokens, usage.outputTokens, charged, requestId);
            return;
          }
        }
      }
      update.run('pending_reconciliation', entry.reserved, null, null, null, 0, requestId);
    });
  }
  return Object.freeze({
    accountingOwner:Object.freeze({begin, finish}),
    grantTrial,
    balance,
    requestsForTurn:(accountId, turnId) => byTurn.all(accountId, turnId),
    close:() => db.close()
  });
}
