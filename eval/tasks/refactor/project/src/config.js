function getPort() {
  const raw = process.env.APP_PORT;
  if (raw === undefined || raw === "") return "8080";
  return raw.trim();
}
function getHost() {
  const raw = process.env.APP_HOST;
  if (raw === undefined || raw === "") return "127.0.0.1";
  return raw.trim();
}
function getLogLevel() {
  const raw = process.env.APP_LOG_LEVEL;
  if (raw === undefined || raw === "") return "info";
  return raw.trim();
}
module.exports = { getPort, getHost, getLogLevel };
