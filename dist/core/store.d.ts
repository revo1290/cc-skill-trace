import type { SkillInvocationEvent } from "./types.js";
export declare const STORE_DIR: string;
export declare const EVENTS_FILE: string;
export declare function ensureStoreDir(dir?: string): Promise<void>;
export declare function appendEvent(event: SkillInvocationEvent, dir?: string): Promise<void>;
export declare function readEvents(dir?: string): Promise<SkillInvocationEvent[]>;
export declare function clearEvents(dir?: string): Promise<void>;
//# sourceMappingURL=store.d.ts.map