/**
 * Types for scripts/check-release.mjs so the TypeScript contract tests can
 * import its helpers (the script itself is plain ESM JavaScript — no build
 * step for repo scripts).
 */

export declare const repoRoot: string;
export declare const SEMVER_RE: RegExp;
export declare const CHANGELOG_SECTIONS: string[];
export declare function readVersion(pkgPath: string): string;
export declare function collectVersionProblems(root?: string): string[];
export declare function checkChangelog(text: string, rootVersion: string): string[];
export declare function main(argv?: string[]): number;
