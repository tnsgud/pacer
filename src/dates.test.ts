import { describe, expect, it } from "vitest";
import { businessDaysBetween, deadlineRisk, isBusinessDate } from "./dates.js";

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
