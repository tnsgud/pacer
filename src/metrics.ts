// 성공 기준 평가 (도입한 사람이 보는 평가용, Discord에는 내보내지 않음).
// 사용: npm run metrics -- --since 2026-11-16   (since를 빼면 전체 기간)
import { successReport } from "./jobs.js";
import { db } from "./db.js";
import { members } from "./schema.js";

const at = process.argv.indexOf("--since");
const since = at >= 0 ? process.argv[at + 1] : undefined;
if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("--since 는 YYYY-MM-DD 형식이에요. 예: npm run metrics -- --since 2026-11-16");
  process.exit(1);
}

// 터미널에서는 Discord 멘션 대신 이름, 굵게 표시 없이
const names = new Map(db.select().from(members).all().map((m) => [m.id, m.name]));
console.log(
  successReport(undefined, since)
    .replace(/<@([^>]+)>/g, (_, id: string) => `@${names.get(id) ?? id}`)
    .replace(/\*\*/g, ""),
);
