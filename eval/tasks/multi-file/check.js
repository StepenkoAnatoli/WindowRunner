const assert = require("assert");
const fs = require("fs");
for (const f of ["src/api.js", "src/app.js", "src/report.js"]) {
  assert.ok(!fs.readFileSync(f, "utf8").includes("fetchUser"), f + " still mentions fetchUser");
}
const api = require("./src/api.js");
assert.strictEqual(typeof api.loadUser, "function");
assert.strictEqual(require("./src/app.js").describe(7), "app sees user-7");
assert.strictEqual(require("./src/report.js").report(3), "report: user-3");
console.log("ok");
