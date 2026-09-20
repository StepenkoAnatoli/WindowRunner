const { sum } = require("./src/math.js");
const assert = require("assert");
assert.strictEqual(sum([]), 0);
assert.strictEqual(sum([1, 2, 3]), 6);
assert.strictEqual(sum([-1, 1]), 0);
console.log("ok");
