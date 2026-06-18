const MAX_TOKENS = 1800;

function compressSummary(summary, label) {
  if (!summary) return '';
  const lines = String(summary).split(/\r?\n/).filter(Boolean);
  if (lines.length <= 10) return `${label}:\n${lines.join('\n')}`;
  return `${label}:\n${lines.slice(0, 8).join('\n')}\n...`;
}

function countTokens(text) {
  if (!text) return 0;
  const words = String(text).split(/\s+/).filter(Boolean);
  return words.length;
}

function compressProfile(profile) {
  if (!profile) return { compressedProfile: '', tokenCount: 0 };

  const sections = [];
  sections.push(compressSummary(profile.identitySummary, 'Identity Summary'));
  sections.push(compressSummary(profile.preferenceSummary, 'Preference Summary'));
  sections.push(compressSummary(profile.relationshipSummary, 'Relationship Summary'));
  sections.push(compressSummary(profile.projectSummary, 'Project Summary'));
  sections.push(compressSummary(profile.goalSummary, 'Goal Summary'));

  const compact = sections.filter(Boolean).join('\n\n');
  const tokenCount = countTokens(compact);

  if (tokenCount <= MAX_TOKENS) {
    return { compressedProfile: compact, tokenCount };
  }

  const trimmed = sections
    .filter(Boolean)
    .map((section) => section.split(/\r?\n/).slice(0, 4).join('\n'))
    .join('\n\n');

  return { compressedProfile: trimmed, tokenCount: countTokens(trimmed) };
}

module.exports = { compressProfile, MAX_TOKENS };