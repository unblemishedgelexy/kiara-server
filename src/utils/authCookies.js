function extractBearerToken(value) {
  if (!value || !value.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length).trim();
  return token || null;
}

module.exports = { extractBearerToken };
