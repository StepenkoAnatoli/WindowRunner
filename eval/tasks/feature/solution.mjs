export default [
  { toolCalls: [{ name: "read_file", args: { path: "src/text.js" } }] },
  { toolCalls: [{ name: "edit_file", args: { path: "src/text.js", oldText: "module.exports = { capitalize };", newText: "function slugify(text) {\n  return text\n    .toLowerCase()\n    .trim()\n    .replace(/[^a-z0-9]+/g, \"-\")\n    .replace(/^-+|-+$/g, \"\");\n}\nmodule.exports = { capitalize, slugify };" } }] },
  { text: "Added `slugify` to src/text.js and exported it alongside `capitalize`." },
];
