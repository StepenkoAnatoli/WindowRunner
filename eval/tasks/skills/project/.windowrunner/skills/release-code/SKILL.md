---
name: release-code
description: How version strings are bumped in this repository, including the release-candidate suffix rule.
---

# Bumping versions in this repository

Version strings are three dot-separated integers. Add a new exported function
`bumpVersion` to `src/version.js`, next to the existing `parseVersion`, with
this exact behaviour:

- `bumpVersion(version, part)` returns the version with `part` (`"major"`,
  `"minor"` or `"patch"`) incremented by one and every lower part reset to
  zero. `"1.2.3"` bumped on `"minor"` is `"1.3.0"`.
- Any pre-release suffix after the first `-` is dropped.
  `"1.2.3-rc.1"` bumped on `"patch"` is `"1.2.4"`.
- Anything that is not a three-part version throws an
  `Error("invalid version: <input>")`.

`parseVersion` already rejects junk, so reuse it rather than validating again.
Keep the existing `module.exports` shape and add `bumpVersion` to it.
