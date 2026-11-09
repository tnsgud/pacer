import { describe, expect, it } from "vitest";
import { businessDaysBetween, deadlineRisk, isBusinessDate, isWorkingHours } from "./dates.js";

describe("isWorkingHours", () => {
  const kst = (iso: string) => new Date(`${iso}+09:00`);
  it("평일 09:00~18:00(18:00 제외)만 근무 시간", () => {
    expect(isWorkingHours(kst("2026-11-04T08:59"), "09:00", "18:00")).toBe(false);
    expect(isWorkingHours(kst("2026-11-04T09:00"), "09:00", "18:00")).toBe(true);
    expect(isWorkingHours(kst("2026-11-04T17:59"), "09:00", "18:00")).toBe(true);
    expect(isWorkingHours(kst("2026-11-04T18:00"), "09:00", "18:00")).toBe(false);
    expect(isWorkingHours(kst("2026-11-05T00:30"), "09:00", "18:00")).toBe(false); // 자정 넘어
  });
  it("주말은 시간과 상관없이 근무 시간이 아니다", () => {
    expect(isWorkingHours(kst("2026-11-07T10:00"), "09:00", "18:00")).toBe(false);
  });
});

describe("isBusinessDate", () => {
  it("평일은 true, 주말은 false", () => {
    expect(isBusinessDate("2026-11-06")).toBe(true); // 금
    expect(isBusinessDate("2026-11-07")).toBe(false); // 토
  });
});

describe("businessDaysBetween", () => {
  it("주말을 건너뛴다 (2026-11-06 금 → 11-10 화 = 월, 화)", () => {
    expect(businessDaysBetween("2026-11-06", "2026-11-10")).toBe(2);
  });
  it("마감이 이미 지났으면 0", () => {
    expect(businessDaysBetween("2026-11-10", "2026-11-06")).toBe(0);
  });
});

describe("deadlineRisk", () => {
  it("남은 단계가 영업일보다 많으면 위험", () => {
    const r = deadlineRisk(3, "2026-11-11", "2026-11-13");
    expect(r.atRisk).toBe(true);
    expect(r.reason).toBe("남은 단계 3개, 남은 영업일 2일");
  });
  it("여유 있으면 위험 아님", () => {
    expect(deadlineRisk(1, "2026-11-11", "2026-11-13").atRisk).toBe(false);
  });
});
