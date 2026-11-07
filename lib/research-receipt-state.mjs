// Research-only transition model. No IPC, persistence, or authorization.
// Recovery never invokes an operation; only a matching terminal receipt resolves it.
export function begin(requestId, digest) {
  if (!/^[a-f0-9]{32}$/.test(requestId) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid identity');
  return Object.freeze({requestId, digest, state:'reserved'});
}
export function published(record) {
  if (record.state !== 'reserved') throw new Error('invalid transition');
  return Object.freeze({...record, state:'unknown'});
}
export function recover(record, receipt) {
  if (record.state !== 'unknown') throw new Error('invalid transition');
  if (!receipt || receipt.requestId !== record.requestId || receipt.digest !== record.digest || receipt.authenticated !== true || !['committed','rolled_back'].includes(receipt.outcome)) return record;
  return Object.freeze({...record,state:receipt.outcome});
}
