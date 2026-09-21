/**
 * Fails immediately after printing the token it was given — used to assert
 * that (a) early exits reject startup clearly and (b) the captured diagnostic
 * output is token-redacted (test/server-process.test.ts).
 */
"use strict";

console.log(`boot banner would echo token=${process.env.WINDOWS_RUNNER_AUTH_TOKEN}`);
console.error(`stderr also echoes token=${process.env.WINDOWS_RUNNER_AUTH_TOKEN}`);
process.exit(3);
