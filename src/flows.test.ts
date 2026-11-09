// 지금까지 만든 기능의 흐름 테스트. Discord는 가짜 객체로, AI는 고정 응답으로, DB는 임시 파일로 돌린다.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const LEADER = "leader-1";
const INTERN = "intern-1";
const OTHER = "stranger-1";

Object.assign(process.env, {
  DISCORD_TOKEN: "x",
  DISCORD_APP_ID: "x",
  DISCORD_GUILD_ID: "x",
  LEADER_ID: LEADER,
  CF_ACCOUNT_ID: "x",
  CF_API_TOKEN: "x",
  DATABASE_PATH: join(mkdtempSync(join(tmpdir(), "pacer-test-")), "test.db"),
});

vi.mock("./ai.js", () => ({
  draftSteps: vi.fn(async () => ({
    title: "버튼 컴포넌트 3종",
    steps: [
      { title: "props 설계", dueDate: "2026-11-05" },
      { title: "스타일 구현", dueDate: "2026-11-09" },
      { title: "Storybook 문서", dueDate: "2026-11-13" },
    ],
  })),
  coachBlocked: vi.fn(async () => ({ reply: "에러 첫 줄을 보내 주세요.", summary: "Storybook 설정 에러로 막힘" })),
}));

const { db, runMigrations } = await import("./db.js");
const schema = await import("./schema.js");
const jobs = await import("./jobs.js");
const commands = await import("./commands.js");
const { eq } = await import("drizzle-orm");
const { todayKst } = await import("./dates.js");

// ---- 가짜 Discord ----
const sent = new Map<string, unknown[]>();
const client = {
  users: {
    fetch: async (id: string) => ({
      send: async (m: unknown) => {
        sent.set(id, [...(sent.get(id) ?? []), m]);
      },
    }),
  },
} as any;
const dmsTo = (id: string) => sent.get(id) ?? [];
const text = (m: any) => (typeof m === "string" ? m : m.content);
const customIds = (payload: any) =>
  (payload.components ?? []).flatMap((row: any) => row.toJSON().components.map((c: any) => c.custom_id));

function slash(userId: string, opts: Record<string, string> = {}) {
  return {
    user: { id: userId },
    client,
    options: {
      getUser: () => ({ id: opts.assignee ?? INTERN, displayName: "실습생" }),
      getString: (name: string) => opts[name],
    },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
  } as any;
}
function button(userId: string, customId: string, content = "원래 메시지") {
  return {
    user: { id: userId },
    client,
    customId,
    message: { content },
    reply: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
  } as any;
}
function modal(userId: string, customId: string, detail: string) {
  return {
    user: { id: userId },
    client,
    customId,
    fields: { getTextInputValue: () => detail },
    isFromMessage: () => true,
    message: { content: "체크인 메시지", edit: vi.fn(async () => {}) },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
  } as any;
}
const setToday = (iso: string) => vi.setSystemTime(new Date(`${iso}T03:00:00Z`)); // KST 정오

/** 리더가 과제를 등록하고 승인까지 마친 과제를 돌려준다. */
async function approvedTask(due = "2026-11-13", assignee = INTERN) {
  const i = slash(LEADER, { 내용: "버튼 컴포넌트 만들기", 마감: due, assignee });
  await commands.handleAssign(i);
  const id = Number(customIds(i.editReply.mock.calls[0][0])[0].split(":")[1]);
  await commands.handleButton(button(LEADER, `approve:${id}`));
  // 생성 시각은 SQLite가 실제 시계로 찍으므로 고정한 오늘 날짜에 맞춘다
  db.update(schema.tasks).set({ createdAt: `${todayKst()} 03:00:00` }).where(eq(schema.tasks.id, id)).run();
  return jobs.findTask(id)!;
}
const stepsOf = (taskId: number) =>
  db.select().from(schema.steps).where(eq(schema.steps.taskId, taskId)).orderBy(schema.steps.position).all();
const checkinsOf = (taskId: number) =>
  db.select().from(schema.checkins).where(eq(schema.checkins.taskId, taskId)).all();

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  runMigrations();
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  setToday("2026-11-04"); // 수요일
  sent.clear();
  db.delete(schema.checkins).run();
  db.delete(schema.steps).run();
  db.delete(schema.tasks).run();
  db.delete(schema.members).run();
});

describe("/과제 등록과 승인", () => {
  it("팀 리더가 아니면 등록할 수 없다", async () => {
    const i = slash(OTHER, { 내용: "x", 마감: "2026-11-13" });
    await commands.handleAssign(i);
    expect(i.reply.mock.calls[0][0].content).toContain("팀 리더만");
    expect(db.select().from(schema.tasks).all()).toHaveLength(0);
  });

  it("마감 형식이 틀리면 되묻는다", async () => {
    const i = slash(LEADER, { 내용: "x", 마감: "11/13" });
    await commands.handleAssign(i);
    expect(i.reply.mock.calls[0][0].content).toContain("YYYY-MM-DD");
  });

  it("초안을 원문과 함께 리더에게 보여 주고, 승인하면 담당자에게 DM한다", async () => {
    const i = slash(LEADER, { 내용: "버튼 컴포넌트 만들기", 마감: "2026-11-13" });
    await commands.handleAssign(i);
    expect(i.deferReply).toHaveBeenCalled(); // AI 호출 전에 응답 예약
    const draft = i.editReply.mock.calls[0][0];
    expect(draft.content).toContain("원문: 버튼 컴포넌트 만들기");
    expect(draft.content).toContain("1. props 설계 - 2026-11-05");
    const [approveId] = customIds(draft);
    const id = Number(approveId.split(":")[1]);
    expect(jobs.findTask(id)!.status).toBe("draft");
    expect(dmsTo(INTERN)).toHaveLength(0); // 승인 전에는 담당자에게 안 간다

    const stranger = button(OTHER, approveId);
    await commands.handleButton(stranger);
    expect(stranger.reply.mock.calls[0][0].content).toContain("팀 리더만");

    await commands.handleButton(button(LEADER, approveId));
    expect(jobs.findTask(id)!.status).toBe("approved");
    expect(text(dmsTo(INTERN)[0])).toContain("새 과제가 왔어요: 버튼 컴포넌트 3종");
  });
});

describe("저녁 체크인", () => {
  it("승인된 과제마다 버튼 3개와 함께 DM하고, 오늘 답했으면 다시 보내지 않는다", async () => {
    const task = await approvedTask();
    sent.clear();
    await jobs.sendEveningCheckins(client);
    const dm = dmsTo(INTERN)[0] as any;
    expect(dm.content).toContain("지금 단계: 1. props 설계");
    expect(customIds(dm)).toEqual([`checkin:${task.id}:done`, `checkin:${task.id}:doing`, `checkin:${task.id}:blocked`]);

    await jobs.handleCheckinButton(button(INTERN, `checkin:${task.id}:doing`));
    sent.clear();
    await jobs.sendEveningCheckins(client);
    expect(dmsTo(INTERN)).toHaveLength(0);
  });

  it("주말에는 보내지 않는다", async () => {
    await approvedTask();
    sent.clear();
    setToday("2026-11-07"); // 토요일
    await jobs.sendEveningCheckins(client);
    expect(dmsTo(INTERN)).toHaveLength(0);
  });

  it("[완료]는 지금 단계를 끝내고 다음 단계를 안내한다", async () => {
    const task = await approvedTask();
    const i = button(INTERN, `checkin:${task.id}:done`);
    await jobs.handleCheckinButton(i);
    expect(stepsOf(task.id).map((s) => s.done)).toEqual([true, false, false]);
    const reply = i.update.mock.calls[0][0].content;
    expect(reply).toContain("계획보다 1일 빨리"); // 11/4에 11/5 목표 단계를 끝냄
    expect(reply).toContain("다음 단계: 2. 스타일 구현");
    expect(checkinsOf(task.id)[0].status).toBe("done");
  });

  it("[진행 중]은 마감이 빠듯하면 경고한다", async () => {
    const task = await approvedTask("2026-11-05"); // 남은 단계 3개, 영업일 1일
    const i = button(INTERN, `checkin:${task.id}:doing`);
    await jobs.handleCheckinButton(i);
    expect(i.update.mock.calls[0][0].content).toContain("남은 단계 3개, 남은 영업일 1일");
  });

  it("담당자가 아니면 답할 수 없다", async () => {
    const task = await approvedTask();
    const i = button(OTHER, `checkin:${task.id}:done`);
    await jobs.handleCheckinButton(i);
    expect(i.reply).toHaveBeenCalled();
    expect(stepsOf(task.id)[0].done).toBe(false);
  });
});

describe("막힘과 전달 동의", () => {
  it("[막힘] → 입력창 → 힌트와 동의 버튼. 동의 전에는 요약이 리더에게 안 보인다", async () => {
    const task = await approvedTask();
    const b = button(INTERN, `checkin:${task.id}:blocked`);
    await jobs.handleCheckinButton(b);
    expect(b.showModal).toHaveBeenCalled();

    const m = modal(INTERN, `blocked:${task.id}`, "Storybook 설정에서 2시간째 에러");
    await jobs.handleBlockedModal(m);
    const reply = m.editReply.mock.calls[0][0];
    expect(reply.content).toContain("에러 첫 줄을 보내 주세요.");
    expect(reply.content).toContain("> Storybook 설정 에러로 막힘");
    expect(customIds(reply)).toEqual([`share:${task.id}:yes`, `share:${task.id}:no`]);

    const [row] = checkinsOf(task.id);
    expect(row.status).toBe("blocked");
    expect(row.summary).toBe("Storybook 설정 에러로 막힘");
    expect(row.shared).toBe(false);
    expect(JSON.stringify(row)).not.toContain("2시간째"); // 원문은 저장하지 않는다

    const report = jobs.statusReport();
    expect(report).toContain("**막힘 1**");
    expect(report).not.toContain("Storybook 설정 에러로 막힘");
    expect(dmsTo(LEADER)).toHaveLength(0);
  });

  it("[팀 리더님께 전달]하면 리더에게 DM하고 현황에도 요약이 붙는다", async () => {
    const task = await approvedTask();
    await jobs.handleBlockedModal(modal(INTERN, `blocked:${task.id}`, "에러"));
    const yes = button(INTERN, `share:${task.id}:yes`, "힌트\n\n이 상황을 팀 리더님께 전달할까요?");
    await jobs.handleShareButton(yes);

    expect(checkinsOf(task.id)[0].shared).toBe(true);
    expect(text(dmsTo(LEADER)[0])).toContain("Storybook 설정 에러로 막힘");
    expect(jobs.statusReport()).toContain("└ Storybook 설정 에러로 막힘");
    expect(yes.update.mock.calls[0][0].content).toContain("전달했어요");
  });

  it("[조금 더 해 볼게요]면 리더에게 아무것도 안 간다", async () => {
    const task = await approvedTask();
    await jobs.handleBlockedModal(modal(INTERN, `blocked:${task.id}`, "에러"));
    await jobs.handleShareButton(button(INTERN, `share:${task.id}:no`, "힌트\n\n이 상황을 ..."));
    expect(checkinsOf(task.id)[0].shared).toBe(false);
    expect(dmsTo(LEADER)).toHaveLength(0);
  });
});

describe("/완료", () => {
  it("과제가 없으면 없다고 답한다", async () => {
    const i = slash(INTERN);
    await commands.handleDone(i);
    expect(i.reply.mock.calls[0][0].content).toContain("진행 중인 과제가 없어요");
  });

  it("과제가 하나면 바로 지금 단계를 끝내고, 그날 저녁 체크인은 건너뛴다", async () => {
    const task = await approvedTask();
    await commands.handleDone(slash(INTERN));
    expect(stepsOf(task.id)[0].done).toBe(true);
    sent.clear();
    await jobs.sendEveningCheckins(client);
    expect(dmsTo(INTERN)).toHaveLength(0);
  });

  it("과제가 여러 개면 버튼으로 고르게 한다", async () => {
    const a = await approvedTask();
    const b = await approvedTask();
    const i = slash(INTERN);
    await commands.handleDone(i);
    expect(customIds(i.reply.mock.calls[0][0])).toEqual([`selfdone:${a.id}`, `selfdone:${b.id}`]);
    await commands.handleSelfDoneButton(button(INTERN, `selfdone:${b.id}`));
    expect(stepsOf(a.id)[0].done).toBe(false);
    expect(stepsOf(b.id)[0].done).toBe(true);
  });

  it("마지막 단계까지 끝내면 과제를 완료 처리한다", async () => {
    const task = await approvedTask();
    for (let n = 0; n < 3; n++) await commands.handleDone(slash(INTERN));
    expect(jobs.findTask(task.id)!.status).toBe("done");
    const i = slash(INTERN);
    await commands.handleDone(i);
    expect(i.reply.mock.calls[0][0].content).toContain("진행 중인 과제가 없어요");
  });
});

describe("/현황과 아침 요약", () => {
  it("팀 리더만 볼 수 있다", async () => {
    const i = slash(OTHER);
    await commands.handleStatus(i);
    expect(i.reply.mock.calls[0][0].content).toContain("팀 리더만");
  });

  it("체크인이 영업일 2일 이상 없으면 응답 없음으로 분류한다", async () => {
    await approvedTask();
    expect(jobs.statusReport("2026-11-05")).toContain("**순조로움 1**");
    expect(jobs.statusReport("2026-11-06")).toContain("**응답 없음 1**");
  });

  it("아침에는 리더에게 요약, 담당자에게 오늘 할 단계를 보내고 주말에는 쉰다", async () => {
    await approvedTask();
    sent.clear();
    await jobs.sendMorning(client);
    expect(text(dmsTo(LEADER)[0])).toContain("팀 과제 현황");
    expect(text(dmsTo(INTERN)[0])).toContain("오늘 할 단계: 1. props 설계");

    sent.clear();
    setToday("2026-11-08"); // 일요일
    await jobs.sendMorning(client);
    expect(sent.size).toBe(0);
  });
});
