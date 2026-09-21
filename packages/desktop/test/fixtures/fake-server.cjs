/**
 * Stand-in for the bundled server, used to test desktop process-tree cleanup
 * (test/server-process.test.ts). Prints the same ready line the real bundle
 * prints, serves /healthz, and spawns a `sleep` grandchild in its own process
 * group. On SIGTERM it exits WITHOUT killing the grandchild — so the grandchild
 * only dies if stopServer's killTree actually reached the whole process tree.
 */
"use strict";

const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const port = Number(process.env.PORT || "0");

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const grandchild = spawn("sleep", ["300"], { stdio: "ignore" });
  if (process.env.FAKE_CHILD_PID_FILE) {
    fs.writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(grandchild.pid));
  }
  console.log(`windows-runner listening on http://127.0.0.1:${address.port}`);
});

process.on("SIGTERM", () => {
  // Deliberately does not kill the `sleep` grandchild.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
