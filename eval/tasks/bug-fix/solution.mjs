export default [
  { toolCalls: [{ name: "read_file", args: { path: "src/math.js" } }] },
  { toolCalls: [{ name: "edit_file", args: { path: "src/math.js", oldText: "  let total;\n  for (const v of values) total = (total ?? 0) + v;\n  return total;", newText: "  let total = 0;\n  for (const v of values) total += v;\n  return total;" } }] },
  { text: "Fixed: `sum` now starts from 0, so an empty array returns 0." },
];
