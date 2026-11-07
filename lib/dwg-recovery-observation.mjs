import {validateExportJournalSnapshot} from './dwg-export-journal.mjs';

// Unregistered, read-only evidence comparison. Caller-provided observations are
// not a trusted receipt, and a match never authorizes publication or replay.
export function compareOriginalExportObservation(snapshot, observation) {
  const unknown = reason => Object.freeze({outcome:'unconfirmed', reason, mayReplay:false, mayPublish:false});
  let record;
  try { record = validateExportJournalSnapshot(snapshot); }
  catch { return unknown('invalid_original_record'); }
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return unknown('missing_observation');
  if (observation.request_id !== record.plan.request_id || observation.digest !== record.digest || observation.revision !== record.revision)
    return unknown('original_request_mismatch');
  if (record.state !== 'complete') return unknown('original_request_not_complete');
  if (observation.directory_identity !== record.plan.destination_directory_identity || !Array.isArray(observation.files) || observation.files.length !== record.files.length)
    return unknown('destination_or_manifest_mismatch');
  for (let i = 0; i < record.files.length; i++) {
    const expected = record.plan.files[i], published = record.files[i], actual = observation.files[i];
    if (!actual || actual.name !== expected.name || actual.identity !== published.target_identity || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 || actual.regular_file !== true || actual.single_link !== true)
      return unknown('file_evidence_mismatch');
  }
  return Object.freeze({outcome:'observed_match', reason:'untrusted_observation_only', mayReplay:false, mayPublish:false});
}
