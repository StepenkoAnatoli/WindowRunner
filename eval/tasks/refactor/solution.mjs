export default [
  { toolCalls: [{ name: "read_file", args: { path: "src/config.js" } }] },
  { toolCalls: [{ name: "write_file", args: { path: "src/config.js", content: 'function readEnv(name, fallback) {\n  const raw = process.env[name];\n  if (raw === undefined || raw === "") return fallback;\n  return raw.trim();\n}\nfunction getPort() {\n  return readEnv("APP_PORT", "8080");\n}\nfunction getHost() {\n  return readEnv("APP_HOST", "127.0.0.1");\n}\nfunction getLogLevel() {\n  return readEnv("APP_LOG_LEVEL", "info");\n}\nmodule.exports = { getPort, getHost, getLogLevel };\n' } }] },
  { text: "Extracted `readEnv(name, fallback)`; the three getters now delegate to it. Behaviour unchanged." },
];
