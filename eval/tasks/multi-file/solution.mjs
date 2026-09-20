export default [
  { toolCalls: [{ name: "list_dir", args: { path: "src" } }] },
  { toolCalls: [
      { name: "read_file", args: { path: "src/api.js" } },
      { name: "read_file", args: { path: "src/app.js" } },
      { name: "read_file", args: { path: "src/report.js" } },
  ] },
  { toolCalls: [
      { name: "edit_file", args: { path: "src/api.js", oldText: "fetchUser", newText: "loadUser", replaceAll: true } },
      { name: "edit_file", args: { path: "src/app.js", oldText: "fetchUser", newText: "loadUser", replaceAll: true } },
      { name: "edit_file", args: { path: "src/report.js", oldText: "fetchUser", newText: "loadUser", replaceAll: true } },
  ] },
  { text: "Renamed `fetchUser` to `loadUser` in src/api.js (definition + export), src/app.js and src/report.js." },
];
