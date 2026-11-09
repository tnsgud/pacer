// 날짜는 모두 KST 기준 'YYYY-MM-DD' 문자열로 다룬다.
// ponytail: 공휴일은 하드코딩 목록, 해마다 갱신하거나 공휴일 API로 교체.
const HOLIDAYS = new Set<string>([]);

export function todayKst(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
}

function isBusinessDay(d: Date): boolean {
  const day = d.getUTCDay();
  const iso = d.toISOString().slice(0, 10);
  return day !== 0 && day !== 6 && !HOLIDAYS.has(iso);
}

export const isBusinessDate = (iso: string) => isBusinessDay(new Date(`${iso}T00:00:00Z`));

/** now가 근무 시간(영업일의 start~end, KST, "HH:MM")인지. end는 포함하지 않는다. */
export function isWorkingHours(now: Date, start: string, end: string): boolean {
  if (!isBusinessDate(todayKst(now))) return false;
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(now);
  return hm >= start && hm < end;
}

/** from 다음날부터 to(포함)까지의 영업일 수. to가 from 이전이면 0. */
export function businessDaysBetween(from: string, to: string): number {
  const end = new Date(`${to}T00:00:00Z`);
  const cur = new Date(`${from}T00:00:00Z`);
  let count = 0;
  for (cur.setUTCDate(cur.getUTCDate() + 1); cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
    if (isBusinessDay(cur)) count++;
  }
  return count;
}

/** 남은 단계 수가 남은 영업일 수보다 많으면 위험. 근거 문구를 함께 돌려준다. */
export function deadlineRisk(remainingSteps: number, today: string, due: string) {
  const days = businessDaysBetween(today, due);
  return {
    atRisk: remainingSteps > days,
    reason: `남은 단계 ${remainingSteps}개, 남은 영업일 ${days}일`,
  };
}
