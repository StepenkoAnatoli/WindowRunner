function parseVersion(text) {
  const parts = String(text).split(".");
  if (parts.length !== 3 || !parts.every((part) => /^\d+$/.test(part))) {
    throw new Error(`invalid version: ${text}`);
  }
  return { major: Number(parts[0]), minor: Number(parts[1]), patch: Number(parts[2]) };
}

module.exports = { parseVersion };
