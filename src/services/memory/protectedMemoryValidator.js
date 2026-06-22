const PROTECTED_CATEGORIES = ['identity', 'family', 'relationship', 'goal', 'project'];

function isProtectedCategory(category) {
  return PROTECTED_CATEGORIES.includes(category);
}

function canDelete(category) {
  return !isProtectedCategory(category);
}

function canCompress(category) {
  return !isProtectedCategory(category);
}

function canArchive(category) {
  return !isProtectedCategory(category);
}

function canExpire(category) {
  return !isProtectedCategory(category);
}

function getProtectionLevel(category) {
  if (isProtectedCategory(category)) {
    return 'sacred';
  }
  return 'normal';
}

module.exports = {
  PROTECTED_CATEGORIES,
  isProtectedCategory,
  canDelete,
  canCompress,
  canArchive,
  canExpire,
  getProtectionLevel,
};
