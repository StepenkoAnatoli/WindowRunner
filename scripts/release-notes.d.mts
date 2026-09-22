/**
 * Types for scripts/release-notes.mjs (see check-release.d.mts for the pattern).
 */

export declare const repoRoot: string;
export declare function extractReleaseNotes(changelog: string, version: string): string | null;
export declare function main(argv?: string[]): number;
