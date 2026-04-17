import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const STORE_DIR = join(homedir(), ".cc-skill-trace");
const EVENTS_FILE = join(STORE_DIR, "events.jsonl");
export async function ensureStoreDir() {
    await mkdir(STORE_DIR, { recursive: true });
}
export async function appendEvent(event) {
    await ensureStoreDir();
    await appendFile(EVENTS_FILE, JSON.stringify(event) + "\n", "utf-8");
}
export async function readEvents() {
    try {
        const raw = await readFile(EVENTS_FILE, "utf-8");
        return raw
            .split("\n")
            .filter((l) => l.trim())
            .flatMap((l) => {
            try {
                return [JSON.parse(l)];
            }
            catch {
                return [];
            }
        });
    }
    catch {
        return [];
    }
}
export async function clearEvents() {
    await ensureStoreDir();
    await writeFile(EVENTS_FILE, "", "utf-8");
}
export { STORE_DIR, EVENTS_FILE };
//# sourceMappingURL=store.js.map