import type { SkillInvocationEvent } from "./types.js";
declare const STORE_DIR: string;
declare const EVENTS_FILE: string;
export declare function ensureStoreDir(): Promise<void>;
export declare function appendEvent(event: SkillInvocationEvent): Promise<void>;
export declare function readEvents(): Promise<SkillInvocationEvent[]>;
export declare function clearEvents(): Promise<void>;
export { STORE_DIR, EVENTS_FILE };
//# sourceMappingURL=store.d.ts.map