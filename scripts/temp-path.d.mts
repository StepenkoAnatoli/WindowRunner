/**
 * Types for scripts/temp-path.mjs (its only consumers are the server tests).
 */

export type TempPathRmOptions = {
  recursive: true;
  force: true;
  maxRetries: number;
  retryDelay: number;
};

/** The `fs.rm` shape the helper uses; injectable so a test can pin options. */
export type TempPathRm = (target: string, options: TempPathRmOptions) => Promise<void>;

export declare const TEMP_PATH_RM_OPTIONS: TempPathRmOptions;
export declare function removeTempPath(target: string, rm?: TempPathRm): Promise<void>;
export declare function removeTempPathSync(target: string): void;
