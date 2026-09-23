// Hidden check for the `skills` eval task. Never inside the project root, so
// the model cannot read or edit it.
//
// The behaviour asserted here is only written down in
// .windowrunner/skills/release-code/SKILL.md, and the function name itself
// appears nowhere else in the fixture — not in the prompt, not in src/, not in
// this file. A run that never calls read_skill has nothing to implement.
const assert = require("assert");
const v = require("./src/version.js");

assert.strictEqual(typeof v.bumpVersion, "function", "bumpVersion must be exported");

// The increment + reset rule.
assert.strictEqual(v.bumpVersion("1.2.3", "patch"), "1.2.4");
assert.strictEqual(v.bumpVersion("1.2.3", "minor"), "1.3.0", "lower parts reset to zero");
assert.strictEqual(v.bumpVersion("1.2.3", "major"), "2.0.0", "lower parts reset to zero");

// The pre-release suffix rule, which is the part a guess would miss.
assert.strictEqual(v.bumpVersion("1.2.3-rc.1", "patch"), "1.2.4", "suffix is dropped");
assert.strictEqual(v.bumpVersion("2.0.0-rc.7", "major"), "3.0.0", "suffix is dropped");

// The error contract.
assert.throws(() => v.bumpVersion("nope", "patch"), /^Error: invalid version: nope$/);

// The existing export survives, and bumpVersion is genuinely in the source.
assert.strictEqual(typeof v.parseVersion, "function", "existing export must survive");
const src = require("fs").readFileSync("src/version.js", "utf8");
assert.match(src, /bumpVersion/, "bumpVersion must be defined in src/version.js");

console.log("ok");
