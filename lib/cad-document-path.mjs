import path from 'node:path';

// Saved Windows project paths: drive absolute or a complete UNC share.
// Root-relative paths and device namespaces are not document identities here.
export const CAD_DOCUMENT_PATH_MAX_LENGTH = 32767;
export function isSavedCadDocumentPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > CAD_DOCUMENT_PATH_MAX_LENGTH || value.includes('\0')) return false;
  const { root, base } = path.win32.parse(path.win32.normalize(value));
  if (!base) return false;
  return /^[a-z]:\\$/i.test(root) || /^\\\\(?![?.]\\)[^\\]+\\[^\\]+\\$/.test(root);
}
export function sameCadDocumentPath(a, b) {
  return isSavedCadDocumentPath(a) && isSavedCadDocumentPath(b) &&
    path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
}
