const { execSync } = require("child_process");
const assert = require("assert");
const out = execSync("npm run build --silent", { encoding: "utf8" });
assert.ok(/hello world/.test(out), "build must run app.js and print hello world");
const pkg = require("./package.json");
assert.strictEqual(pkg.scripts.build, "node --check src/app.js && node src/app.js", "package.json must not change");
console.log("ok");
