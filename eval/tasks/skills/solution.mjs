// What a competent model would do, in order. Step 1 is not strictly necessary:
// deploy-runbook is excluded from the index because its frontmatter is never
// closed, but a skill that is absent from the index is still readable by name,
// and a model that saw the diagnostic would try it once before moving on.
export default [
  { toolCalls: [{ name: "read_skill", args: { name: "deploy-runbook" } }] },
  { toolCalls: [{ name: "read_skill", args: { name: "release-code" } }] },
  {
    toolCalls: [
      {
        name: "edit_file",
        args: {
          path: "src/version.js",
          oldText: "module.exports = { parseVersion };",
          newText:
            'function bumpVersion(version, part) {\n' +
            '  const base = String(version).split("-")[0];\n' +
            '  const { major, minor, patch } = parseVersion(base);\n' +
            '  if (part === "major") return `${major + 1}.0.0`;\n' +
            '  if (part === "minor") return `${major}.${minor + 1}.0`;\n' +
            '  if (part === "patch") return `${major}.${minor}.${patch + 1}`;\n' +
            '  throw new Error(`invalid version: ${version}`);\n' +
            '}\n' +
            '\n' +
            'module.exports = { parseVersion, bumpVersion };',
        },
      },
    ],
  },
  {
    text:
      "Added `bumpVersion` to src/version.js following the release-code skill: " +
      "increments the requested part, resets the lower parts to zero, and drops any " +
      "pre-release suffix. The deploy-runbook skill is unusable — its frontmatter is never closed.",
  },
];
