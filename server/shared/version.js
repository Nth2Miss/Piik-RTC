const pattern = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i;

export function parseVersion(value) {
  const match = pattern.exec(String(value || '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

export function normalizeVersion(value) {
  const parsed = parseVersion(value);
  return parsed ? parsed.join('.') : null;
}

// The page and the desktop shell can be built from different releases; the
// lower one is the version actually constraining compatibility.
export function effectiveClientVersion(...values) {
  const versions = values.map(normalizeVersion).filter(Boolean);
  return versions.reduce((lowest, version) => compareVersions(version, lowest) < 0 ? version : lowest, versions[0] || null);
}
