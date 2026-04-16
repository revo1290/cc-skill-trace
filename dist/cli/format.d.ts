import type { SkillInvocationEvent } from "../core/types.js";
export interface SkillStat {
    name: string;
    total: number;
    auto: number;
    byUser: number;
}
export declare function buildStats(events: SkillInvocationEvent[]): SkillStat[];
export declare function renderDashboard(events: SkillInvocationEvent[]): string;
export declare function renderCompact(events: SkillInvocationEvent[]): string;
//# sourceMappingURL=format.d.ts.map