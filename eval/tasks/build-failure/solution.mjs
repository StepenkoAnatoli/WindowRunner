export default [
  { toolCalls: [{ name: "run_terminal", args: { command: "npm run build" } }] },
  { toolCalls: [{ name: "read_file", args: { path: "src/app.js" } }] },
  { toolCalls: [{ name: "edit_file", args: { path: "src/app.js", oldText: '  console.log(greeting + " world"\n}', newText: '  console.log(greeting + " world");\n}' } }] },
  { toolCalls: [{ name: "run_terminal", args: { command: "npm run build" } }] },
  { text: "The build failed on a missing closing parenthesis in src/app.js; fixed it and the build now passes." },
];
