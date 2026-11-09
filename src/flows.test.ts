// 지금까지 만든 기능의 흐름 테스트. Discord는 가짜 객체로, AI는 고정 응답으로, DB는 임시 파일로 돌린다.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const LEADER = "leader-1";
const INTERN = "intern-1";
const OTHER = "stranger-1";
const INTERN2 = "intern-2";

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
      getUser: (name: string) => {
        if (name === "담당자") return { id: opts.assignee ?? INTERN, displayName: "실습생", bot: false };
        const id = opts[name];
        return id ? { id, displayName: id, bot: id.startsWith("bot") } : null;
      },
      getString: (name: string) => opts[name],
    },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    showModal: vi.fn(async () => {}),
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
    inGuild: () => false,
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
  db.delete(schema.dueRequests).run();
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
  it("승인된 과제마다 버튼 3개와 함께 DM한다", async () => {
    const task = await approvedTask();
    sent.clear();
    await jobs.sendEveningCheckins(client);
    const dm = dmsTo(INTERN)[0] as any;
    expect(dm.content).toContain("지금 단계: 1. props 설계");
    expect(customIds(dm)).toEqual([`checkin:${task.id}:done`, `checkin:${task.id}:doing`, `checkin:${task.id}:blocked`]);
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

  it("과제가 하나면 바로 지금 단계를 끝내고, 저녁 체크인은 다음 단계 기준으로 그대로 온다", async () => {
    const task = await approvedTask();
    await commands.handleDone(slash(INTERN));
    expect(stepsOf(task.id)[0].done).toBe(true);
    sent.clear();
    await jobs.sendEveningCheckins(client);
    expect(text(dmsTo(INTERN)[0])).toContain("지금 단계: 2. 스타일 구현");
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

describe("초안 수정과 취소", () => {
  /** 초안만 만들고(승인 전) 과제 ID와 리더가 받은 메시지를 돌려준다. */
  async function draftOnly() {
    const i = slash(LEADER, { 내용: "버튼 컴포넌트 만들기", 마감: "2026-11-13" });
    await commands.handleAssign(i);
    const draft = i.editReply.mock.calls[0][0];
    return { id: Number(customIds(draft)[0].split(":")[1]), draft };
  }
  function editModal(userId: string, id: number, fields: Record<string, string>) {
    return {
      user: { id: userId },
      client,
      customId: `taskedit:${id}`,
      fields: { getTextInputValue: (k: string) => fields[k] },
      isFromMessage: () => true,
      reply: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
    } as any;
  }

  it("초안에 [이대로 전달] [수정] [취소] 버튼이 붙는다", async () => {
    const { id, draft } = await draftOnly();
    expect(customIds(draft)).toEqual([`approve:${id}`, `edit:${id}`, `cancel:${id}`]);
  });

  it("[수정]은 지금 초안이 채워진 입력창을 띄운다", async () => {
    const { id } = await draftOnly();
    const b = button(LEADER, `edit:${id}`);
    await commands.handleButton(b);
    const fields = b.showModal.mock.calls[0][0].toJSON().components.map((r: any) => r.components[0]);
    expect(fields.map((f: any) => f.value)).toEqual([
      "버튼 컴포넌트 3종",
      "2026-11-13",
      "1. props 설계 - 2026-11-05\n2. 스타일 구현 - 2026-11-09\n3. Storybook 문서 - 2026-11-13",
    ]);
  });

  it("수정 내용을 저장하고 초안 메시지를 새로 그린다", async () => {
    const { id } = await draftOnly();
    const m = editModal(LEADER, id, {
      title: "버튼 컴포넌트",
      due: "2026-11-20",
      steps: "props·API 설계 - 2026-11-06\nPrimary-Secondary 스타일 - 2026-11-12\n\nStorybook 문서 - 2026-11-18\n리뷰 반영 - 2026-11-20",
    });
    await commands.handleTaskEditModal(m);
    const t = jobs.findTask(id)!;
    expect([t.title, t.dueDate, t.status]).toEqual(["버튼 컴포넌트", "2026-11-20", "draft"]);
    expect(stepsOf(id).map((s) => [s.position, s.title, s.dueDate])).toEqual([
      [1, "props·API 설계", "2026-11-06"],
      [2, "Primary-Secondary 스타일", "2026-11-12"],
      [3, "Storybook 문서", "2026-11-18"],
      [4, "리뷰 반영", "2026-11-20"],
    ]);
    const updated = m.update.mock.calls[0][0];
    expect(updated.content).toContain("2. Primary-Secondary 스타일 - 2026-11-12");
    expect(customIds(updated)).toEqual([`approve:${id}`, `edit:${id}`, `cancel:${id}`]);
  });

  it("형식이 틀리면 초안을 그대로 두고 틀린 줄을 알려 준다", async () => {
    const { id } = await draftOnly();
    const m = editModal(LEADER, id, {
      title: "x",
      due: "2026-11-13",
      steps: "설계 - 2026-11-05\n구현 2026-11-09\n문서 - 2026-02-30\n리뷰 - 2026-11-20",
    });
    await commands.handleTaskEditModal(m);
    const msg = m.reply.mock.calls[0][0].content;
    expect(msg).toContain("2번째 줄");
    expect(msg).toContain("2026-02-30");
    expect(msg).toContain("최종 마감 2026-11-13보다 늦어요");
    expect(stepsOf(id)).toHaveLength(3);
    expect(jobs.findTask(id)!.title).toBe("버튼 컴포넌트 3종");
  });

  it("[취소]는 초안을 지우고 담당자에게 아무것도 보내지 않는다", async () => {
    const { id } = await draftOnly();
    const b = button(LEADER, `cancel:${id}`);
    await commands.handleButton(b);
    expect(jobs.findTask(id)).toBeUndefined();
    expect(stepsOf(id)).toHaveLength(0);
    expect(dmsTo(INTERN)).toHaveLength(0);
    expect(b.update.mock.calls[0][0].content).toContain("초안을 취소했어요");
  });

  it("팀 리더가 아니면 수정·취소할 수 없다", async () => {
    const { id } = await draftOnly();
    for (const action of ["edit", "cancel"]) {
      const b = button(OTHER, `${action}:${id}`);
      await commands.handleButton(b);
      expect(b.reply).toHaveBeenCalled();
    }
    const m = editModal(OTHER, id, { title: "x", due: "2026-11-13", steps: "a - 2026-11-05" });
    await commands.handleTaskEditModal(m);
    expect(m.reply).toHaveBeenCalled();
    expect(jobs.findTask(id)!.title).toBe("버튼 컴포넌트 3종");
  });

  it("이미 전달한 초안의 버튼을 다시 누르면 아무 일도 하지 않는다", async () => {
    const { id } = await draftOnly();
    await commands.handleButton(button(LEADER, `approve:${id}`));
    for (const action of ["approve", "edit", "cancel"]) {
      const b = button(LEADER, `${action}:${id}`);
      await commands.handleButton(b);
      expect(b.update.mock.calls[0][0].content).toContain("이미 처리된 초안");
    }
    expect(dmsTo(INTERN)).toHaveLength(1); // 담당자 DM은 한 번만
    expect(jobs.findTask(id)!.status).toBe("approved");
  });
});

describe("/도움말", () => {
  it("팀 리더에게는 리더용과 담당자용 안내를, 담당자에게는 담당자용만 보여 준다", async () => {
    const leader = slash(LEADER);
    await commands.handleHelp(leader);
    const l = leader.reply.mock.calls[0][0].content;
    expect(l).toContain("/과제");
    expect(l).toContain("/현황");
    expect(l).toContain("/완료");

    const intern = slash(INTERN);
    await commands.handleHelp(intern);
    const a = intern.reply.mock.calls[0][0].content;
    expect(a).toContain("/완료");
    expect(a).not.toContain("/과제");
    expect(intern.reply.mock.calls[0][0].flags).toBeDefined(); // 본인에게만

    for (const text of [l, a]) expect(text.length).toBeLessThanOrEqual(2000); // Discord 메시지 한도
  });
});

describe("/막힘", () => {
  it("과제가 없으면 없다고 답한다", async () => {
    const i = slash(INTERN);
    await commands.handleBlockedCommand(i);
    expect(i.reply.mock.calls[0][0].content).toContain("진행 중인 과제가 없어요");
  });

  it("과제가 하나면 바로 막힘 입력창을 띄우고, 이후는 [막힘]과 같은 흐름이다", async () => {
    const task = await approvedTask();
    const i = slash(INTERN);
    await commands.handleBlockedCommand(i);
    expect(i.showModal.mock.calls[0][0].toJSON().custom_id).toBe(`blocked:${task.id}`);

    const m = modal(INTERN, `blocked:${task.id}`, "에러");
    m.isFromMessage = () => false; // 슬래시 명령에서 연 입력창
    await jobs.handleBlockedModal(m);
    expect(customIds(m.editReply.mock.calls[0][0])).toEqual([`share:${task.id}:yes`, `share:${task.id}:no`]);
    expect(checkinsOf(task.id)[0].status).toBe("blocked");
  });

  it("서버 채널에서 쓰면 힌트도 본인에게만 보인다", async () => {
    const task = await approvedTask();
    const m = modal(INTERN, `blocked:${task.id}`, "에러");
    m.inGuild = () => true;
    await jobs.handleBlockedModal(m);
    expect(m.deferReply.mock.calls[0][0].flags).toBeDefined();

    const dm = modal(INTERN, `blocked:${task.id}`, "에러");
    await jobs.handleBlockedModal(dm);
    expect(dm.deferReply.mock.calls[0][0].flags).toBeUndefined(); // DM에서는 기록이 남도록 일반 메시지
  });

  it("과제가 여러 개면 버튼으로 고르고, 고른 과제의 입력창을 띄운다", async () => {
    const a = await approvedTask();
    const b = await approvedTask();
    const i = slash(INTERN);
    await commands.handleBlockedCommand(i);
    expect(customIds(i.reply.mock.calls[0][0])).toEqual([`selfblocked:${a.id}`, `selfblocked:${b.id}`]);
    const pick = button(INTERN, `selfblocked:${b.id}`);
    await commands.handleSelfBlockedButton(pick);
    expect(pick.showModal.mock.calls[0][0].toJSON().custom_id).toBe(`blocked:${b.id}`);

    const other = button(OTHER, `selfblocked:${b.id}`);
    await commands.handleSelfBlockedButton(other);
    expect(other.showModal).not.toHaveBeenCalled();
  });

  it("선택 메시지 수정이 실패해도(본인에게만 보이는 메시지) 힌트는 정상으로 나간다", async () => {
    const task = await approvedTask();
    const m = modal(INTERN, `blocked:${task.id}`, "에러");
    m.message.edit = vi.fn(async () => { throw new Error("Unknown Message"); });
    await jobs.handleBlockedModal(m);
    expect(m.editReply).toHaveBeenCalled();
  });
});

describe("담당자 여러 명", () => {
  it("초안은 하나, 전달하면 사람마다 같은 과제가 복사되고 각자 DM을 받는다", async () => {
    const i = slash(LEADER, { 내용: "버튼 컴포넌트 만들기", 마감: "2026-11-13", 담당자2: INTERN2, 담당자3: INTERN, 담당자4: "bot-1" });
    await commands.handleAssign(i);
    const draft = i.editReply.mock.calls[0][0];
    expect(draft.content).toContain(`<@${INTERN}>, <@${INTERN2}>`); // 중복·봇 제외
    expect(draft.content).not.toContain("bot-1");
    const id = Number(customIds(draft)[0].split(":")[1]);
    expect(db.select().from(schema.tasks).all()).toHaveLength(1); // 전달 전에는 초안 하나

    const approve = button(LEADER, `approve:${id}`);
    await commands.handleButton(approve);
    expect(approve.update.mock.calls[0][0].content).toContain("2명에게 전달했어요");

    const all = db.select().from(schema.tasks).all();
    expect(all.map((t) => [t.assigneeId, t.status, t.extraAssigneeIds])).toEqual([
      [INTERN, "approved", null],
      [INTERN2, "approved", null],
    ]);
    const [a, b] = all;
    const shape = (id: number) => stepsOf(id).map((s) => [s.position, s.title, s.dueDate, s.done]);
    expect(shape(b.id)).toEqual(shape(a.id));
    expect(text(dmsTo(INTERN)[0])).toContain("새 과제가 왔어요");
    expect(text(dmsTo(INTERN2)[0])).toContain("새 과제가 왔어요");

    await commands.handleDone(slash(INTERN2)); // 각자 따로 진행
    expect(stepsOf(b.id)[0].done).toBe(true);
    expect(stepsOf(a.id)[0].done).toBe(false);
  });

  it("전달 전에 고친 초안이 모든 사람에게 그대로 복사된다", async () => {
    const i = slash(LEADER, { 내용: "x", 마감: "2026-11-13", 담당자2: INTERN2 });
    await commands.handleAssign(i);
    const id = Number(customIds(i.editReply.mock.calls[0][0])[0].split(":")[1]);
    const m = {
      user: { id: LEADER }, client, customId: `taskedit:${id}`, isFromMessage: () => true,
      fields: { getTextInputValue: (k: string) => ({ title: "고친 제목", due: "2026-11-13", steps: "하나 - 2026-11-10\n둘 - 2026-11-13" })[k] },
      reply: vi.fn(async () => {}), update: vi.fn(async () => {}),
    } as any;
    await commands.handleTaskEditModal(m);
    expect(m.update.mock.calls[0][0].content).toContain(`<@${INTERN}>, <@${INTERN2}>`);
    await commands.handleButton(button(LEADER, `approve:${id}`));
    for (const t of db.select().from(schema.tasks).all()) {
      expect(t.title).toBe("고친 제목");
      expect(stepsOf(t.id).map((s) => s.title)).toEqual(["하나", "둘"]);
    }
  });
});

describe("/과제수정 (전달한 과제 수정)", () => {
  function submit(userId: string, id: number, fields: Record<string, string>) {
    return {
      user: { id: userId }, client, customId: `taskedit:${id}`, isFromMessage: () => true,
      fields: { getTextInputValue: (k: string) => fields[k] },
      reply: vi.fn(async () => {}), update: vi.fn(async () => {}),
    } as any;
  }

  it("팀 리더만 쓸 수 있고, 진행 중인 과제를 버튼으로 보여 준다", async () => {
    const task = await approvedTask();
    const no = slash(OTHER);
    await commands.handleEditTaskCommand(no);
    expect(no.reply.mock.calls[0][0].content).toContain("팀 리더만");

    const i = slash(LEADER);
    await commands.handleEditTaskCommand(i);
    const reply = i.reply.mock.calls[0][0];
    expect(customIds(reply)).toEqual([`pickedit:${task.id}`]);
    expect(reply.components[0].toJSON().components[0].label).toBe("버튼 컴포넌트 3종 · 실습생");
  });

  it("끝난 단계는 빼고 남은 단계만 입력창에 채운다", async () => {
    const task = await approvedTask();
    await commands.handleDone(slash(INTERN)); // 1단계 끝
    const b = button(LEADER, `pickedit:${task.id}`);
    await commands.handlePickEditButton(b);
    const modal = b.showModal.mock.calls[0][0].toJSON();
    expect(modal.title).toContain("끝난 단계 1개는 그대로");
    expect(modal.components[2].components[0].value).toBe("2. 스타일 구현 - 2026-11-09\n3. Storybook 문서 - 2026-11-13");
  });

  it("남은 단계·마감을 바꾸고 끝난 단계는 그대로 두며, 담당자에게 알린다", async () => {
    const task = await approvedTask();
    await commands.handleDone(slash(INTERN));
    sent.clear();
    const m = submit(LEADER, task.id, {
      title: "버튼 컴포넌트 3종",
      due: "2026-11-20",
      steps: "2. 스타일 구현 - 2026-11-12\n3. Storybook 문서 - 2026-11-17\n리뷰 반영 - 2026-11-20",
    });
    await commands.handleTaskEditModal(m);
    expect(stepsOf(task.id).map((s) => [s.position, s.title, s.dueDate, s.done])).toEqual([
      [1, "props 설계", "2026-11-05", true],
      [2, "스타일 구현", "2026-11-12", false],
      [3, "Storybook 문서", "2026-11-17", false],
      [4, "리뷰 반영", "2026-11-20", false],
    ]);
    expect(jobs.findTask(task.id)!.dueDate).toBe("2026-11-20");
    const dm = text(dmsTo(INTERN)[0]);
    expect(dm).toBe(
      "✏️ [버튼 컴포넌트 3종] 과제가 수정됐어요\n\n" +
        "바뀐 점\n" +
        "• 최종 마감: 11/13 → 11/20\n" +
        "• 2. 스타일 구현: 목표일 11/9 → 11/12\n" +
        "• 3. Storybook 문서: 목표일 11/13 → 11/17\n" +
        "• 새 단계: 4. 리뷰 반영 (11/20)\n\n" +
        "남은 단계 (끝낸 1단계는 그대로)\n" +
        "2. 스타일 구현 - 11/12 ✏️\n" +
        "3. Storybook 문서 - 11/17 ✏️\n" +
        "4. 리뷰 반영 - 11/20 🆕",
    );
    const notice = m.update.mock.calls[0][0].content;
    expect(notice).toContain("수정했고 알렸어요");
    expect(notice).toContain("• 최종 마감: 11/13 → 11/20");
  });

  it("형식이 틀리면 아무것도 바꾸지 않고 담당자에게도 알리지 않는다", async () => {
    const task = await approvedTask();
    sent.clear();
    const m = submit(LEADER, task.id, { title: "x", due: "2026-11-13", steps: "구현 2026-11-09" });
    await commands.handleTaskEditModal(m);
    expect(m.reply.mock.calls[0][0].content).toContain("과제는 그대로예요");
    expect(stepsOf(task.id)).toHaveLength(3);
    expect(dmsTo(INTERN)).toHaveLength(0);
  });

  it("다 끝난 과제는 고칠 수 없다", async () => {
    const task = await approvedTask();
    for (let n = 0; n < 3; n++) await commands.handleDone(slash(INTERN));
    const b = button(LEADER, `pickedit:${task.id}`);
    await commands.handlePickEditButton(b);
    expect(b.showModal).not.toHaveBeenCalled();
    const m = submit(LEADER, task.id, { title: "x", due: "2026-11-13", steps: "a - 2026-11-10" });
    await commands.handleTaskEditModal(m);
    expect(m.reply.mock.calls[0][0].content).toContain("이미 끝났거나");
  });
});

describe("마감 변경 요청 (담당자 → 팀 리더 승인)", () => {
  function dueModal(userId: string, taskId: number, due: string, reason = "Storybook 설정이 오래 걸려요", c: any = client) {
    return {
      user: { id: userId }, client: c, customId: `duereq:${taskId}`,
      fields: { getTextInputValue: (k: string) => ({ due, reason })[k] },
      reply: vi.fn(async () => {}),
    } as any;
  }
  const requests = () => db.select().from(schema.dueRequests).all();
  async function requestAndGetDecision(taskId: number, due = "2026-11-20") {
    await commands.handleDueRequestModal(dueModal(INTERN, taskId, due));
    const dm = dmsTo(LEADER).at(-1) as any;
    return { dm, ids: customIds(dm) };
  }

  it("과제가 하나면 바로 요청 입력창을 띄운다", async () => {
    const task = await approvedTask();
    const i = slash(INTERN);
    await commands.handleDueChangeCommand(i);
    expect(i.showModal.mock.calls[0][0].toJSON().custom_id).toBe(`duereq:${task.id}`);
  });

  it("요청하면 저장하고 팀 리더에게 이유·남은 단계와 [승인] [거절]을 DM한다", async () => {
    const task = await approvedTask();
    sent.clear();
    const m = dueModal(INTERN, task.id, "2026-11-20");
    await commands.handleDueRequestModal(m);
    const [req] = requests();
    expect([req.oldDue, req.newDue, req.status]).toEqual(["2026-11-13", "2026-11-20", "pending"]);
    const dm = dmsTo(LEADER)[0] as any;
    expect(dm.content).toContain("2026-11-13 → **2026-11-20**");
    expect(dm.content).toContain("> Storybook 설정이 오래 걸려요");
    expect(customIds(dm)).toEqual([`duedecide:${req.id}:yes`, `duedecide:${req.id}:no`]);
    expect(m.reply.mock.calls[0][0].content).toContain("요청을 보냈어요");
    expect(jobs.findTask(task.id)!.dueDate).toBe("2026-11-13"); // 승인 전에는 그대로
    expect(jobs.statusReport()).toContain("📅 마감 변경 요청 11/20 대기");
  });

  it("날짜가 틀리거나 지났거나 같거나, 이미 대기 중이면 요청하지 않는다", async () => {
    const task = await approvedTask();
    sent.clear();
    for (const [due, msg] of [["2026-13-01", "올바르지 않아요"], ["2026-11-03", "이전 날짜"], ["2026-11-13", "같은 날짜"]]) {
      const m = dueModal(INTERN, task.id, due);
      await commands.handleDueRequestModal(m);
      expect(m.reply.mock.calls[0][0].content).toContain(msg);
    }
    expect(requests()).toHaveLength(0);
    await commands.handleDueRequestModal(dueModal(INTERN, task.id, "2026-11-20"));
    const again = dueModal(INTERN, task.id, "2026-11-25");
    await commands.handleDueRequestModal(again);
    expect(again.reply.mock.calls[0][0].content).toContain("기다리고 있어요");
    expect(requests()).toHaveLength(1);
    expect(dmsTo(LEADER)).toHaveLength(1);
  });

  it("다른 사람은 남의 과제 마감 변경을 요청할 수 없다", async () => {
    const task = await approvedTask();
    const m = dueModal(OTHER, task.id, "2026-11-20");
    await commands.handleDueRequestModal(m);
    expect(requests()).toHaveLength(0);
  });

  it("[승인]하면 마감과 예전 마감에 맞춰 있던 단계를 옮기고 담당자에게 알린다", async () => {
    const task = await approvedTask();
    sent.clear();
    const { ids } = await requestAndGetDecision(task.id, "2026-11-20");
    const b = button(LEADER, ids[0], "요청 메시지");
    await commands.handleDueDecision(b);
    expect(jobs.findTask(task.id)!.dueDate).toBe("2026-11-20");
    expect(stepsOf(task.id).map((s) => s.dueDate)).toEqual(["2026-11-05", "2026-11-09", "2026-11-20"]);
    expect(requests()[0].status).toBe("approved");
    const dm = text(dmsTo(INTERN).at(-1));
    expect(dm).toContain("✅ [버튼 컴포넌트 3종] 마감 변경이 승인됐어요");
    expect(dm).toContain("• 최종 마감: 11/13 → 11/20");
    expect(dm).toContain("• 3. Storybook 문서: 목표일 11/13 → 11/20");
    expect(dm).toContain("3. Storybook 문서 - 11/20 ✏️");
    expect(dm).toContain("1. props 설계 - 11/5\n"); // 안 바뀐 단계는 표시 없음
    expect(b.update.mock.calls[0][0].content).toContain("승인했어요");
    expect(jobs.statusReport()).not.toContain("마감 변경 요청");
  });

  it("마감을 앞당기면 새 마감보다 늦은 단계도 새 마감으로 당긴다", async () => {
    const task = await approvedTask();
    const { ids } = await requestAndGetDecision(task.id, "2026-11-06");
    await commands.handleDueDecision(button(LEADER, ids[0]));
    expect(stepsOf(task.id).map((s) => s.dueDate)).toEqual(["2026-11-05", "2026-11-06", "2026-11-06"]);
  });

  it("[거절]하면 그대로 두고 담당자에게 알린다", async () => {
    const task = await approvedTask();
    const { ids } = await requestAndGetDecision(task.id);
    await commands.handleDueDecision(button(LEADER, ids[1]));
    expect(jobs.findTask(task.id)!.dueDate).toBe("2026-11-13");
    expect(requests()[0].status).toBe("rejected");
    expect(text(dmsTo(INTERN).at(-1))).toContain("이번에는 어렵대요");
  });

  it("팀 리더만 결정하고, 이미 결정한 요청은 다시 처리하지 않는다", async () => {
    const task = await approvedTask();
    const { ids } = await requestAndGetDecision(task.id);
    const other = button(OTHER, ids[0]);
    await commands.handleDueDecision(other);
    expect(other.reply).toHaveBeenCalled();
    await commands.handleDueDecision(button(LEADER, ids[1]));
    const late = button(LEADER, ids[0]);
    await commands.handleDueDecision(late);
    expect(late.update.mock.calls[0][0].content).toContain("이미 처리됐거나");
    expect(jobs.findTask(task.id)!.dueDate).toBe("2026-11-13");
  });

  it("팀 리더에게 DM을 못 보내면 요청을 남기지 않는다", async () => {
    const task = await approvedTask();
    const broken = { users: { fetch: async () => ({ send: async () => { throw new Error("Cannot send messages to this user"); } }) } };
    const m = dueModal(INTERN, task.id, "2026-11-20", "x", broken);
    await commands.handleDueRequestModal(m);
    expect(requests()).toHaveLength(0);
    expect(m.reply.mock.calls[0][0].content).toContain("보내지 못했어요");
  });
});

describe("주간 리포트", () => {
  it("과제별 완료율, 이번 주 끝낸 단계, 자주 막힌 단계, 응답률을 보여 준다", async () => {
    const task = await approvedTask(); // 11/4(수) 생성
    await commands.handleDone(slash(INTERN)); // 11/4 1단계 완료
    setToday("2026-11-05"); // 목: 2단계에서 막힘
    await jobs.handleBlockedModal(modal(INTERN, `blocked:${task.id}`, "에러"));
    setToday("2026-11-06"); // 금 16:00 리포트 (오늘 체크인 전)

    const r = jobs.weeklyReport();
    expect(r).toContain("📊 주간 리포트 11/2~11/6");
    expect(r).toContain("버튼 컴포넌트 3종 - 1/3단계 (33%), 이번 주 1단계");
    expect(r).toContain("• 버튼 컴포넌트 3종 › 스타일 구현 - 1회");
    expect(r).toContain(`<@${INTERN}> 2/2일 (100%)`); // 수·목 답함, 금은 아직이라 제외
  });

  it("답하지 않은 날은 응답률에 반영된다", async () => {
    await approvedTask(); // 수
    await commands.handleDone(slash(INTERN)); // 수 답함
    setToday("2026-11-06"); // 목은 답 없음
    expect(jobs.weeklyReport()).toContain(`<@${INTERN}> 1/2일 (50%)`);
  });

  it("지난주에 끝난 과제는 빼고, 이번 주에 끝낸 과제는 완료로 표시한다", async () => {
    const task = await approvedTask();
    for (let n = 0; n < 3; n++) await commands.handleDone(slash(INTERN));
    expect(jobs.weeklyReport()).toContain("3/3단계 (100%), 이번 주 3단계 ✅ 완료");
    setToday("2026-11-13");
    expect(jobs.weeklyReport()).toContain("이번 주 진행한 과제가 없어요");
    expect(jobs.findTask(task.id)!.status).toBe("done");
  });

  it("금요일 발송은 팀 리더에게 DM, /주간리포트는 팀 리더만 본다", async () => {
    await approvedTask();
    sent.clear();
    await jobs.sendWeekly(client);
    expect(text(dmsTo(LEADER)[0])).toContain("주간 리포트");
    const no = slash(OTHER);
    await commands.handleWeekly(no);
    expect(no.reply.mock.calls[0][0].content).toContain("팀 리더만");
    const yes = slash(LEADER);
    await commands.handleWeekly(yes);
    expect(yes.reply.mock.calls[0][0].content).toContain("과제별 완료율");
  });
});

describe("날짜 검증", () => {
  it("없는 날짜는 오류 없이 거절한다", async () => {
    for (const due of ["2026-13-01", "2026-02-30", "2026-00-10"]) {
      const i = slash(LEADER, { 내용: "x", 마감: due });
      await commands.handleAssign(i);
      expect(i.reply.mock.calls[0][0].content).toContain("YYYY-MM-DD");
    }
    expect(commands.parseSteps("a - 2026-13-01", "2026-12-31").errors[0]).toContain("올바르지 않아요");
  });
});

describe("성공 기준 측정", () => {
  async function editDraft(id: number, times: number) {
    for (let n = 0; n < times; n++) {
      await commands.handleTaskEditModal({
        user: { id: LEADER }, client, customId: `taskedit:${id}`, isFromMessage: () => true,
        fields: { getTextInputValue: (k: string) => ({ title: "t", due: "2026-11-13", steps: `a${n} - 2026-11-10` })[k] },
        reply: vi.fn(async () => {}), update: vi.fn(async () => {}),
      } as any);
    }
  }
  async function draftId(opts: Record<string, string> = {}) {
    const i = slash(LEADER, { 내용: "x", 마감: "2026-11-13", ...opts });
    await commands.handleAssign(i);
    return Number(customIds(i.editReply.mock.calls[0][0])[0].split(":")[1]);
  }
  const report = () => jobs.successReport();

  it("초안 수정 횟수를 세고, 1회 이내 확정 비율을 보여 준다 (복사본은 빼고)", async () => {
    const a = await draftId({ 담당자2: INTERN2 });
    await editDraft(a, 2);
    await commands.handleButton(button(LEADER, `approve:${a}`));
    const b = await draftId();
    await editDraft(b, 1);
    await commands.handleButton(button(LEADER, `approve:${b}`));
    const rows = db.select().from(schema.tasks).all();
    expect(rows.map((t) => t.draftEdits)).toEqual([2, null, 1]); // 복사본은 null
    expect(report()).toContain("❌ 초안 수정 1회 이내 확정 1/2 (50%, 목표 80%)");
  });

  it("전달한 뒤 /과제수정은 초안 수정 횟수에 넣지 않는다", async () => {
    const task = await approvedTask();
    await editDraft(task.id, 1);
    expect(jobs.findTask(task.id)!.draftEdits).toBe(0);
  });

  it("막힘을 아침 요약으로 다음 날 알면 1영업일 이내, 아무도 안 보면 놓친 것으로 센다", async () => {
    const a = await approvedTask();
    await jobs.handleBlockedModal(modal(INTERN, `blocked:${a.id}`, "에러")); // 수: 막힘 (전달 안 함)
    setToday("2026-11-05");
    await jobs.sendMorning(client); // 목 아침 요약에서 리더가 봄
    expect(checkinsOf(a.id)[0].leaderSeenAt).toBe("2026-11-05");
    expect(report()).toContain("✅ 막힘 1영업일 이내 리더 인지 1/1");

    const b = await approvedTask();
    await jobs.handleBlockedModal(modal(INTERN, `blocked:${b.id}`, "에러")); // 목: 막힘, 아무도 안 봄
    setToday("2026-11-09"); // 월: 2영업일 지남
    expect(report()).toContain("❌ 막힘 1영업일 이내 리더 인지 1/2");
  });

  it("전달에 동의하면 그날 리더가 안 것으로, /현황을 보면 그날 본 것으로 기록한다", async () => {
    const a = await approvedTask();
    await jobs.handleBlockedModal(modal(INTERN, `blocked:${a.id}`, "에러"));
    await jobs.handleShareButton(button(INTERN, `share:${a.id}:yes`, "힌트\n\n이 상황을"));
    expect(checkinsOf(a.id)[0].leaderSeenAt).toBe("2026-11-04");

    const b = await approvedTask();
    await jobs.handleBlockedModal(modal(INTERN, `blocked:${b.id}`, "에러"));
    await commands.handleStatus(slash(LEADER));
    expect(checkinsOf(b.id)[0].leaderSeenAt).toBe("2026-11-04");
  });

  it("마감을 넘긴 과제를 세고, 리더가 2영업일 전에 경고를 봤는지 보여 준다", async () => {
    const late = await approvedTask("2026-11-05"); // 수 생성, 목 마감, 3단계 → 바로 주의
    await jobs.sendMorning(client); // 수 아침 요약: 주의로 봄 (마감 1영업일 전)
    expect(jobs.findTask(late.id)!.riskWarnedAt).toBe("2026-11-04");
    const onTime = await approvedTask("2026-11-13");
    for (let n = 0; n < 3; n++) await jobs.handleCheckinButton(button(INTERN, `checkin:${onTime.id}:done`));
    expect(jobs.findTask(onTime.id)!.completedAt).toBe("2026-11-04");

    setToday("2026-11-06");
    const r = report();
    expect(r).toContain("❌ 마감 놓친 과제 1건 (목표 0건), 2영업일 전 경고 0/1");
    expect(r).toContain("버튼 컴포넌트 3종 (마감 11/5)");
  });

  it("마감 뒤에 끝낸 과제도 놓친 것으로 센다", async () => {
    const t = await approvedTask("2026-11-05");
    setToday("2026-11-06");
    for (let n = 0; n < 3; n++) await commands.handleDone(slash(INTERN));
    expect(jobs.findTask(t.id)!.completedAt).toBe("2026-11-06");
    expect(report()).toContain("마감 놓친 과제 1건");
  });

  it("아무 일도 없으면 기록 없음으로 보여 준다", () => {
    const r = report();
    expect(r).toContain("➖ 초안 수정 1회 이내 확정: 아직 전달한 초안 없음");
    expect(r).toContain("✅ 마감 놓친 과제 0건");
  });

  it("담당자 아침 DM에 마감 위험을 미리 알린다", async () => {
    await approvedTask("2026-11-05");
    sent.clear();
    await jobs.sendMorning(client);
    expect(text(dmsTo(INTERN)[0])).toContain("⚠️ 마감이 빠듯해요 (남은 단계 3개, 남은 영업일 1일)");
  });

  it("성공 기준은 주간 리포트에 넣지 않는다 (도입 평가용, npm run metrics로만 봄)", () => {
    expect(jobs.weeklyReport()).not.toContain("성공 기준");
    expect(jobs.weeklyReport()).toContain("체크인 응답률");
  });

  it("since를 주면 그날부터 생긴 과제만 센다", async () => {
    await approvedTask("2026-11-05"); // 11/4 생성, 11/5 마감
    setToday("2026-11-10");
    expect(jobs.successReport()).toContain("마감 놓친 과제 1건");
    const r = jobs.successReport(undefined, "2026-11-09");
    expect(r).toContain("성공 기준 (2026-11-09부터 2026-11-10까지)");
    expect(r).toContain("✅ 마감 놓친 과제 0건");
  });
});

describe("바뀐 점 표시", () => {
  const st = (title: string, dueDate: string) => ({ title, dueDate });
  const base = { title: "버튼", dueDate: "2026-11-13", steps: [st("설계", "2026-11-05"), st("스타일 구현", "2026-11-09"), st("접근성 점검", "2026-11-11")] };

  it("이름 변경·새 단계·빠진 단계·목표일 변경을 구분한다", () => {
    const d = commands.diffTask(base, {
      title: "버튼 컴포넌트",
      dueDate: "2026-11-13",
      steps: [st("설계", "2026-11-06"), st("Primary·Ghost 스타일 구현", "2026-11-09"), st("리뷰 반영", "2026-11-13"), st("문서", "2026-11-13")],
    }, 1);
    expect(d.changes).toEqual([
      "과제 제목: 버튼 → 버튼 컴포넌트",
      "1. 설계: 목표일 11/5 → 11/6",
      "이름 변경: 2. 스타일 구현 → Primary·Ghost 스타일 구현",
      "이름 변경: 3. 접근성 점검 → 리뷰 반영, 목표일 11/11 → 11/13",
      "새 단계: 4. 문서 (11/13)",
    ]);
    expect(d.list.split("\n")).toEqual([
      "1. 설계 - 11/6 ✏️",
      "2. Primary·Ghost 스타일 구현 - 11/9 ✏️",
      "3. 리뷰 반영 - 11/13 ✏️",
      "4. 문서 - 11/13 🆕",
    ]);
  });

  it("단계를 빼면 빠진 단계로, 순서만 바뀐 것은 적지 않는다", () => {
    const d = commands.diffTask(base, { ...base, steps: [st("스타일 구현", "2026-11-09"), st("설계", "2026-11-05")] }, 1);
    expect(d.changes).toEqual(["빠진 단계: 접근성 점검"]);
    expect(d.list).not.toContain("✏️");
  });

  it("바뀐 게 없으면 저장하지 않고 담당자에게 알리지 않는다", async () => {
    const task = await approvedTask();
    sent.clear();
    const m = {
      user: { id: LEADER }, client, customId: `taskedit:${task.id}`, isFromMessage: () => true,
      fields: { getTextInputValue: (k: string) => ({
        title: "버튼 컴포넌트 3종", due: "2026-11-13",
        steps: "1. props 설계 - 2026-11-05\n2. 스타일 구현 - 2026-11-09\n3. Storybook 문서 - 2026-11-13",
      })[k] },
      reply: vi.fn(async () => {}), update: vi.fn(async () => {}),
    } as any;
    const before = stepsOf(task.id).map((x) => x.id);
    await commands.handleTaskEditModal(m);
    expect(m.reply.mock.calls[0][0].content).toContain("바뀐 내용이 없어요");
    expect(dmsTo(INTERN)).toHaveLength(0);
    expect(stepsOf(task.id).map((x) => x.id)).toEqual(before); // 다시 만들지도 않음
  });
});

describe("근무 시간 밖 알림은 소리 없이", () => {
  const SILENT = 4096; // MessageFlags.SuppressNotifications
  const at = (kst: string) => vi.setSystemTime(new Date(`${kst}+09:00`));
  const member = (id: string) => db.select().from(schema.members).where(eq(schema.members.id, id)).get()!;
  function edit(taskId: number, steps: string) {
    return commands.handleTaskEditModal({
      user: { id: LEADER }, client, customId: `taskedit:${taskId}`, isFromMessage: () => true,
      fields: { getTextInputValue: (k: string) => ({ title: "버튼 컴포넌트 3종", due: "2026-11-13", steps })[k] },
      reply: vi.fn(async () => {}), update: vi.fn(async () => {}),
    } as any);
  }

  it("근무 시간에 고치면 평소처럼 알림이 간다", async () => {
    const task = await approvedTask();
    sent.clear();
    at("2026-11-04T15:00");
    await edit(task.id, "스타일 - 2026-11-10");
    expect((dmsTo(INTERN)[0] as any).flags).toBeUndefined();
    expect(member(INTERN).quietNotice).toBe(false);
  });

  it("퇴근 뒤에 고치면 소리 없이 보내고, 다음 아침 안내 첫 DM에 한 번만 알린다", async () => {
    const a = await approvedTask();
    await approvedTask(); // 같은 담당자의 두 번째 과제
    sent.clear();
    at("2026-11-04T22:30");
    await edit(a.id, "스타일 - 2026-11-10");
    const dm = dmsTo(INTERN)[0] as any;
    expect(dm.flags).toBe(SILENT);
    expect(dm.content).toContain("과제가 수정됐어요");
    expect(member(INTERN).quietNotice).toBe(true);

    sent.clear();
    at("2026-11-05T09:00");
    await jobs.sendMorning(client);
    const [first, second] = dmsTo(INTERN).map(text);
    expect(first.startsWith("📝 어제 퇴근 뒤 바뀐 일정·알림이 있어요")).toBe(true);
    expect(second).not.toContain("📝");
    expect(member(INTERN).quietNotice).toBe(false);

    sent.clear();
    at("2026-11-06T09:00");
    await jobs.sendMorning(client);
    expect(dmsTo(INTERN).map(text).join()).not.toContain("📝");
  });

  it("주말에 생긴 알림도 소리 없이, 담당자가 밤에 보낸 요청은 팀 리더에게 소리 없이 간다", async () => {
    const task = await approvedTask();
    sent.clear();
    at("2026-11-07T11:00"); // 토요일
    await commands.handleDueRequestModal({
      user: { id: INTERN }, client, customId: `duereq:${task.id}`,
      fields: { getTextInputValue: (k: string) => ({ due: "2026-11-20", reason: "x" })[k] },
      reply: vi.fn(async () => {}),
    } as any);
    expect((dmsTo(LEADER)[0] as any).flags).toBe(SILENT);
  });
});
