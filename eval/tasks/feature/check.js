const t = require("./src/text.js");
const assert = require("assert");
assert.strictEqual(typeof t.slugify, "function");
assert.strictEqual(t.slugify("  Hello, World! "), "hello-world");
assert.strictEqual(t.slugify("A  B---C"), "a-b-c");
assert.strictEqual(t.capitalize("abc"), "Abc", "existing export must survive");
console.log("ok");
