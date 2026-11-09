import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import { draftSteps } from "./ai.js";
import { config } from "./config.js";
import { todayKst } from "./dates.js";
import { db } from "./db.js";
import {
  activeTasksOf,
  blockedModal,
  completeCurrentStep,
  findTask,
  markLeaderSeen,
  sendDm,
  type Seen,
  statusReport,
  weeklyReport,
} from "./jobs.js";
import { dueRequests, members, steps, tasks } from "./schema.js";

type Task = typeof tasks.$inferSelect;

export const assignCommand = new SlashCommandBuilder()
  .setName("과제")
  .setDescription("담당자에게 과제를 맡깁니다 (단계 초안을 만들어 확인받습니다)")
  .addUserOption((o) => o.setName("담당자").setDescription("과제를 맡을 사람").setRequired(true))
  .addStringOption((o) => o.setName("내용").setDescription("과제 설명").setRequired(true))
  .addStringOption((o) => o.setName("마감").setDescription("YYYY-MM-DD").setRequired(true))
  .addUserOption((o) => o.setName("담당자2").setDescription("같은 과제를 함께 받을 사람 (선택)"))
  .addUserOption((o) => o.setName("담당자3").setDescription("같은 과제를 함께 받을 사람 (선택)"))
  .addUserOption((o) => o.setName("담당자4").setDescription("같은 과제를 함께 받을 사람 (선택)"));

// 이미 전달한 과제를 고친다. 끝난 단계는 그대로 두고 남은 단계·제목·마감만 바꾼 뒤 담당자에게 알린다.
export const editTaskCommand = new SlashCommandBuilder()
  .setName("과제수정")
  .setDescription("이미 전달한 과제의 남은 단계·마감을 고칩니다 (팀 리더 전용)");

// 담당자가 마감 연장·단축을 요청한다. 팀 리더가 승인해야 바뀐다 (기획안: "담당자가 요청하면 팀 리더가 승인").
export const dueChangeCommand = new SlashCommandBuilder()
  .setName("마감변경")
  .setDescription("과제 최종 마감 변경을 팀 리더님께 요청합니다")
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);

export const weeklyCommand = new SlashCommandBuilder()
  .setName("주간리포트")
  .setDescription("이번 주 완료율·자주 막힌 단계·체크인 응답률을 봅니다 (팀 리더 전용)");

export const statusCommand = new SlashCommandBuilder()
  .setName("현황")
  .setDescription("진행 중인 과제 현황을 봅니다 (팀 리더 전용)");

// 담당자가 체크인을 기다리지 않고 지금 단계 완료를 등록한다. 봇 DM에서도 쓸 수 있게 전역 명령으로 등록.
export const doneCommand = new SlashCommandBuilder()
  .setName("완료")
  .setDescription("지금 단계를 끝냈다고 코치에게 알립니다")
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);

// 담당자가 체크인을 기다리지 않고 막힘을 먼저 알린다. 체크인의 [막힘]과 같은 입력창·힌트·전달 동의 흐름.
export const blockedCommand = new SlashCommandBuilder()
  .setName("막힘")
  .setDescription("막힌 곳을 코치에게 알리고 힌트를 받습니다")
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);

export async function handleBlockedCommand(i: ChatInputCommandInteraction) {
  const active = activeTasksOf(i.user.id);
  if (active.length === 0) {
    return i.reply({ content: "지금 진행 중인 과제가 없어요.", flags: MessageFlags.Ephemeral });
  }
  if (active.length === 1) return i.showModal(blockedModal(active[0].id));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    active.slice(0, 5).map((t) =>
      new ButtonBuilder().setCustomId(`selfblocked:${t.id}`).setLabel(t.title.slice(0, 80)).setStyle(ButtonStyle.Danger),
    ),
  );
  return i.reply({ content: "어느 과제에서 막혔나요?", components: [row], flags: MessageFlags.Ephemeral });
}

export async function handleSelfBlockedButton(i: ButtonInteraction) {
  const task = findTask(Number(i.customId.split(":")[1]));
  if (!task || task.assigneeId !== i.user.id || task.status !== "approved") {
    return i.update({ content: "이 과제는 막힘을 알릴 수 없어요.", components: [] });
  }
  return i.showModal(blockedModal(task.id));
}

export const helpCommand = new SlashCommandBuilder()
  .setName("도움말")
  .setDescription("코치 봇 사용 방법을 봅니다")
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);

const ASSIGNEE_HELP = [
  "**코치 사용 방법 (담당자)**",
  "",
  "**매일 (평일)**",
  "• 09:00 오늘 할 단계를 DM으로 보내 드려요.",
  "• 17:00 \"오늘 단계는 끝났나요?\" 체크인이 와요. 낮에 `/완료`를 썼어도 다음 단계 기준으로 와요.",
  "  - [완료] 지금 단계를 끝내고 다음 단계를 알려 드려요.",
  "  - [진행 중] 그대로 기록해요. 마감이 빠듯하면 미리 알려 드려요.",
  "  - [막힘] 막힌 곳을 적으면 힌트를 드리고, 팀 리더님께 전달할지 물어봐요.",
  "    동의할 때만 한 줄 요약이 가고, 대화 원문은 가지 않아요.",
  "",
  "**언제든**",
  "• `/완료` 체크인을 기다리지 않고 지금 단계를 끝냈다고 알려요.",
  "• `/막힘` 막히면 바로 알려요. [막힘] 버튼과 똑같이 힌트를 드리고 전달할지 물어봐요.",
  "• `/마감변경` 최종 마감을 바꾸고 싶으면 날짜와 이유를 적어 팀 리더님께 요청해요. 승인되면 DM으로 알려 드려요.",
  "  세 명령 모두 봇과의 DM에서도 쓸 수 있어요.",
  "• `/도움말` 이 안내를 다시 봐요.",
  "",
  "평일 09:00~18:00 밖에 생긴 알림(과제 수정 등)은 소리 없이 와요. 다음 날 아침 안내에서 한 번 더 알려 드려요.",
  "",
  "DM이 안 오면 서버 개인정보 설정에서 \"서버 멤버가 보내는 다이렉트 메시지 허용\"을 켜 주세요.",
].join("\n");

const LEADER_HELP = [
  "**코치 사용 방법 (팀 리더)**",
  "",
  "**과제 맡기기** `/과제` (서버 채널)",
  "• 담당자, 내용, 마감(`2026-11-13`)을 넣으면 AI 단계 초안이 본인에게만 보여요.",
  "• 같은 과제를 여러 명에게: `담당자2`~`담당자4`를 채우면 전달할 때 사람마다 따로 만들어져요.",
  "• [이대로 전달] 담당자에게 DM으로 보내요.",
  "• [수정] 제목·마감·단계를 직접 고쳐요. 단계는 한 줄에 하나씩 `제목 - 2026-11-05`.",
  "• [취소] 초안을 지워요. 담당자에게는 아무것도 가지 않아요.",
  "",
  "**전달한 과제 고치기** `/과제수정` (서버 채널)",
  "• 과제를 고르면 남은 단계·마감·제목을 고칠 수 있어요. 끝난 단계는 그대로 두고, 담당자에게 바뀐 점을 DM으로 알려요.",
  "",
  "**현황 보기** `/현황` (서버 채널)",
  "• 막힘 · 응답 없음 · 주의 · 순조로움으로 묶어 보여 드려요.",
  "",
  "**주간 리포트** `/주간리포트` (서버 채널)",
  "• 이번 주 과제별 완료율, 자주 막힌 단계, 체크인 응답률, 성공 기준 달성 현황. 금요일 16:00에는 DM으로도 와요.",
  "",
  "**자동으로 오는 것**",
  "• 평일 09:00 팀 과제 현황 DM",
  "• 담당자가 막힘 전달에 동의하면 한 줄 요약 DM",
  "• 담당자의 마감 변경 요청 DM ([승인] [거절])",
  "",
  ASSIGNEE_HELP.replace("**코치 사용 방법 (담당자)**", "**담당자가 받는 안내**"),
].join("\n");

export const helpText = (userId: string) => (userId === config.LEADER_ID ? LEADER_HELP : ASSIGNEE_HELP);

export async function handleHelp(i: ChatInputCommandInteraction) {
  return i.reply({ content: helpText(i.user.id), flags: MessageFlags.Ephemeral });
}

/** 실제로 있는 날짜인지 (2026-02-30, 2026-13-01 같은 값은 false). */
const isIsoDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};

const stepsOf = (taskId: number) =>
  db.select().from(steps).where(eq(steps.taskId, taskId)).orderBy(steps.position).all();

const stepLines = (list: { title: string; dueDate: string }[], start = 1) =>
  list.map((s, idx) => `${idx + start}. ${s.title} - ${s.dueDate}`).join("\n");

/** 초안의 담당자 전원 (주 담당자 + 추가 담당자). */
const assigneesOf = (task: Task) => [
  task.assigneeId,
  ...(task.extraAssigneeIds ?? "").split(",").filter(Boolean),
];

/** 팀 리더가 보는 초안 메시지. 처음 만들 때와 수정한 뒤에 같은 모양으로 그린다. */
function renderDraft(task: Task) {
  const who = assigneesOf(task).map((id) => `<@${id}>`).join(", ");
  return {
    content: `원문: ${task.rawText}\n\n[과제] ${task.title} - ${who}, 마감 ${task.dueDate}\n` + stepLines(stepsOf(task.id)),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`approve:${task.id}`).setLabel("이대로 전달").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`edit:${task.id}`).setLabel("수정").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`cancel:${task.id}`).setLabel("취소").setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] as never[] },
  };
}

/**
 * 수정 입력창. 초안이면 모든 단계를, 전달한 과제면 남은 단계만 채운다(끝난 단계는 건드리지 않음).
 */
function editModal(task: Task) {
  const all = stepsOf(task.id);
  const open = all.filter((s) => !s.done);
  const doneCount = all.length - open.length;
  const sent = task.status !== "draft";
  return new ModalBuilder()
    .setCustomId(`taskedit:${task.id}`)
    .setTitle(sent ? `과제 수정 (끝난 단계 ${doneCount}개는 그대로)` : "초안 수정")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("title").setLabel("과제 제목").setStyle(TextInputStyle.Short)
          .setValue(task.title).setMaxLength(100).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("due").setLabel("최종 마감 (YYYY-MM-DD)").setStyle(TextInputStyle.Short)
          .setValue(task.dueDate).setMinLength(10).setMaxLength(10).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("steps")
          .setLabel(`${sent ? "남은 단계" : "단계"} (한 줄에 하나: 제목 - YYYY-MM-DD)`)
          .setStyle(TextInputStyle.Paragraph)
          .setValue(stepLines(open, doneCount + 1))
          .setMaxLength(2000)
          .setRequired(true),
      ),
    );
}

type StepLike = { title: string; dueDate: string };
const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

/**
 * 과제 수정 전후를 비교해 "바뀐 점" 줄과, 바뀐 줄에 ✏️·🆕를 붙인 남은 단계 목록을 만든다.
 * 단계는 이름으로 짝짓는다. 짝이 없는 이전·새 단계가 같은 번호 자리에 있으면 "이름 변경"으로 묶는다.
 * 순서만 바뀐 것은 적지 않는다(넣고 빼면 번호가 밀려 너무 길어져서). start는 남은 단계의 첫 번호.
 */
export function diffTask(
  before: { title: string; dueDate: string; steps: StepLike[] },
  after: { title: string; dueDate: string; steps: StepLike[] },
  start: number,
) {
  const changes: string[] = [];
  const mark: string[] = after.steps.map(() => "");
  if (before.title !== after.title) changes.push(`과제 제목: ${before.title} → ${after.title}`);
  if (before.dueDate !== after.dueDate) changes.push(`최종 마감: ${md(before.dueDate)} → ${md(after.dueDate)}`);

  const usedOld = new Set<number>();
  const pairOf = after.steps.map((n) => {
    const o = before.steps.findIndex((b, idx) => !usedOld.has(idx) && b.title === n.title);
    if (o >= 0) usedOld.add(o);
    return o;
  });
  // 같은 자리에 남은 짝 없는 이전·새 단계 → 이름 변경
  after.steps.forEach((_, j) => {
    if (pairOf[j] < 0 && j < before.steps.length && !usedOld.has(j)) {
      pairOf[j] = j;
      usedOld.add(j);
      mark[j] = "rename";
    }
  });
  after.steps.forEach((n, j) => {
    const num = start + j;
    const o = pairOf[j];
    if (o < 0) {
      changes.push(`새 단계: ${num}. ${n.title} (${md(n.dueDate)})`);
      mark[j] = " 🆕";
      return;
    }
    const old = before.steps[o];
    const dateNote = old.dueDate !== n.dueDate ? `목표일 ${md(old.dueDate)} → ${md(n.dueDate)}` : "";
    if (mark[j] === "rename") {
      changes.push(`이름 변경: ${num}. ${old.title} → ${n.title}` + (dateNote ? `, ${dateNote}` : ""));
      mark[j] = " ✏️";
    } else if (dateNote) {
      changes.push(`${num}. ${n.title}: ${dateNote}`);
      mark[j] = " ✏️";
    }
  });
  before.steps.forEach((o, idx) => {
    if (!usedOld.has(idx)) changes.push(`빠진 단계: ${o.title}`);
  });

  const list = after.steps.map((n, j) => `${start + j}. ${n.title} - ${md(n.dueDate)}${mark[j]}`).join("\n");
  return { changes, list };
}

/** 바뀐 점과 남은 단계를 담당자 DM 본문으로 만든다. */
const changeMessage = (headline: string, diff: { changes: string[]; list: string }, doneCount: number) =>
  `${headline}\n\n바뀐 점\n${diff.changes.map((c) => `• ${c}`).join("\n")}\n\n` +
  `남은 단계${doneCount ? ` (끝낸 ${doneCount}단계는 그대로)` : ""}\n${diff.list}`;

/**
 * 수정 입력창의 단계 텍스트를 읽는다. 한 줄에 한 단계, "제목 - YYYY-MM-DD" (앞 번호는 있어도 없어도 됨).
 * 날짜가 틀리거나 최종 마감보다 늦으면 errors에 줄 번호와 이유를 담는다.
 */
export function parseSteps(text: string, due: string) {
  const parsed: { title: string; dueDate: string }[] = [];
  const errors: string[] = [];
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line, idx) => {
      const m = line.match(/^(?:\d+[.)]\s*)?(.+?)\s*-\s*(\S+)$/);
      if (!m) return errors.push(`${idx + 1}번째 줄: "제목 - YYYY-MM-DD" 형식이 아니에요`);
      const [, title, date] = m;
      if (!isIsoDate(date)) return errors.push(`${idx + 1}번째 줄: 날짜 ${date}가 올바르지 않아요`);
      if (date > due) return errors.push(`${idx + 1}번째 줄: ${date}가 최종 마감 ${due}보다 늦어요`);
      parsed.push({ title, dueDate: date });
    });
  if (parsed.length === 0 && errors.length === 0) errors.push("단계가 하나 이상 있어야 해요");
  if (parsed.length > 8) errors.push("단계는 8개까지만 둘 수 있어요");
  return { steps: parsed, errors };
}

export async function handleStatus(i: ChatInputCommandInteraction) {
  if (i.user.id !== config.LEADER_ID) {
    return i.reply({ content: "팀 리더만 현황을 볼 수 있어요.", flags: MessageFlags.Ephemeral });
  }
  // 멘션은 표시만 되고 알림은 가지 않게 막는다. 리더가 본 막힘·주의는 성공 기준 측정용으로 기록.
  const seen: Seen = { blockedCheckinIds: [], riskTaskIds: [] };
  await i.reply({ content: statusReport(undefined, seen), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  markLeaderSeen(seen);
}

export async function handleDone(i: ChatInputCommandInteraction) {
  const active = activeTasksOf(i.user.id);
  if (active.length === 0) {
    return i.reply({ content: "지금 진행 중인 과제가 없어요.", flags: MessageFlags.Ephemeral });
  }
  if (active.length === 1) {
    return i.reply({ content: completeCurrentStep(active[0]), flags: MessageFlags.Ephemeral });
  }
  // 과제가 여러 개면 어느 과제인지 고르게 한다 (버튼 최대 5개).
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    active.slice(0, 5).map((t) =>
      new ButtonBuilder().setCustomId(`selfdone:${t.id}`).setLabel(t.title.slice(0, 80)).setStyle(ButtonStyle.Success),
    ),
  );
  return i.reply({ content: "어느 과제의 단계를 끝냈나요?", components: [row], flags: MessageFlags.Ephemeral });
}

export async function handleSelfDoneButton(i: ButtonInteraction) {
  const task = findTask(Number(i.customId.split(":")[1]));
  if (!task || task.assigneeId !== i.user.id || task.status !== "approved") {
    return i.update({ content: "이 과제는 완료를 등록할 수 없어요.", components: [] });
  }
  await i.update({ content: completeCurrentStep(task), components: [] });
}

export async function handleAssign(i: ChatInputCommandInteraction) {
  if (i.user.id !== config.LEADER_ID) {
    return i.reply({ content: "팀 리더만 과제를 등록할 수 있어요.", flags: MessageFlags.Ephemeral });
  }
  const raw = i.options.getString("내용", true);
  const due = i.options.getString("마감", true);
  if (!isIsoDate(due)) {
    return i.reply({ content: "마감은 YYYY-MM-DD 형식으로 적어 주세요.", flags: MessageFlags.Ephemeral });
  }
  // 담당자 1~4명. 같은 사람을 여러 번 고르면 한 번으로, 봇 계정은 뺀다.
  const people = [...new Map(
    ["담당자", "담당자2", "담당자3", "담당자4"]
      .map((name) => i.options.getUser(name, name === "담당자"))
      .filter((u): u is NonNullable<typeof u> => !!u && !u.bot)
      .map((u) => [u.id, u]),
  ).values()];
  if (people.length === 0) {
    return i.reply({ content: "봇 계정에는 과제를 맡길 수 없어요.", flags: MessageFlags.Ephemeral });
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral }); // AI 호출 전에 응답 예약
  const draft = await draftSteps(raw, todayKst(), due);

  for (const u of people) {
    db.insert(members).values({ id: u.id, name: u.displayName, role: "member" }).onConflictDoNothing().run();
  }
  const [first, ...rest] = people;
  const task = db
    .insert(tasks)
    .values({
      title: draft.title,
      rawText: raw,
      assigneeId: first.id,
      extraAssigneeIds: rest.length ? rest.map((u) => u.id).join(",") : null,
      dueDate: due,
    })
    .returning()
    .get();
  db.insert(steps)
    .values(draft.steps.map((s, idx) => ({ taskId: task.id, position: idx + 1, ...s })))
    .run();

  await i.editReply(renderDraft(task));
}

/** [이대로 전달]: 추가 담당자마다 과제·단계를 똑같이 복사하고, 모두 승인 상태로 만든다. */
function approveDraft(task: Task): Task[] {
  return db.transaction((tx) => {
    const list = tx.select().from(steps).where(eq(steps.taskId, task.id)).orderBy(steps.position).all();
    const main = tx.update(tasks).set({ status: "approved", extraAssigneeIds: null }).where(eq(tasks.id, task.id)).returning().get();
    const copies = assigneesOf(task).slice(1).map((assigneeId) => {
      const copy = tx
        .insert(tasks)
        .values({ title: task.title, rawText: task.rawText, assigneeId, dueDate: task.dueDate, status: "approved", draftEdits: null })
        .returning()
        .get();
      tx.insert(steps)
        .values(list.map((s) => ({ taskId: copy.id, position: s.position, title: s.title, dueDate: s.dueDate })))
        .run();
      return copy;
    });
    return [main, ...copies];
  });
}

/** 초안 메시지의 [이대로 전달] [수정] [취소] 버튼. 팀 리더만, 초안 상태일 때만 동작한다. */
export async function handleButton(i: ButtonInteraction) {
  const [action, id] = i.customId.split(":");
  if (!["approve", "edit", "cancel"].includes(action)) return;
  if (i.user.id !== config.LEADER_ID) {
    return i.reply({ content: "팀 리더만 할 수 있어요.", flags: MessageFlags.Ephemeral });
  }
  const task = findTask(Number(id));
  if (!task || task.status !== "draft") {
    // 이미 전달했거나 취소한 초안의 버튼을 다시 누른 경우
    return i.update({ content: `${i.message.content}\n\n이미 처리된 초안이에요.`, components: [] });
  }

  if (action === "cancel") {
    db.delete(steps).where(eq(steps.taskId, task.id)).run();
    db.delete(tasks).where(eq(tasks.id, task.id)).run();
    return i.update({ content: `~~[과제] ${task.title}~~\n\n🗑️ 초안을 취소했어요. 담당자에게는 아무것도 가지 않았어요.`, components: [] });
  }

  if (action === "edit") return i.showModal(editModal(task));

  const created = approveDraft(task);
  const failed: string[] = [];
  for (const t of created) {
    try {
      await sendDm(i.client, t.assigneeId, `새 과제가 왔어요: ${t.title} (마감 ${t.dueDate})\n` + stepLines(stepsOf(t.id)));
    } catch (err) {
      console.error(`과제 DM 실패 task=${t.id}`, err);
      failed.push(`<@${t.assigneeId}>`);
    }
  }
  await i.update({
    content:
      `${i.message.content}\n\n✅ ${created.length}명에게 전달했어요.` +
      (failed.length ? `\n⚠️ ${failed.join(", ")}에게는 DM을 보내지 못했어요. DM 허용 설정을 확인해 주세요.` : ""),
    components: [],
    allowedMentions: { parse: [] },
  });
}

/** /과제수정: 진행 중인 과제를 버튼으로 고르게 한다 (최대 25개). */
export async function handleEditTaskCommand(i: ChatInputCommandInteraction) {
  if (i.user.id !== config.LEADER_ID) {
    return i.reply({ content: "팀 리더만 과제를 수정할 수 있어요.", flags: MessageFlags.Ephemeral });
  }
  const active = db
    .select({ task: tasks, name: members.name })
    .from(tasks)
    .innerJoin(members, eq(members.id, tasks.assigneeId))
    .where(eq(tasks.status, "approved"))
    .orderBy(tasks.id)
    .all();
  if (active.length === 0) {
    return i.reply({ content: "진행 중인 과제가 없어요.", flags: MessageFlags.Ephemeral });
  }
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  active.slice(0, 25).forEach(({ task, name }, idx) => {
    if (idx % 5 === 0) rows.push(new ActionRowBuilder<ButtonBuilder>());
    rows[rows.length - 1].addComponents(
      new ButtonBuilder()
        .setCustomId(`pickedit:${task.id}`)
        .setLabel(`${task.title} · ${name}`.slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    );
  });
  return i.reply({
    content: "어느 과제를 고칠까요?" + (active.length > 25 ? ` (앞의 25개만 보여요, 전체 ${active.length}개)` : ""),
    components: rows,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handlePickEditButton(i: ButtonInteraction) {
  if (i.user.id !== config.LEADER_ID) {
    return i.reply({ content: "팀 리더만 과제를 수정할 수 있어요.", flags: MessageFlags.Ephemeral });
  }
  const task = findTask(Number(i.customId.split(":")[1]));
  if (!task || task.status !== "approved") {
    return i.update({ content: "이미 끝났거나 없는 과제예요.", components: [] });
  }
  return i.showModal(editModal(task));
}

/**
 * 수정 입력창 제출 (초안·전달한 과제 공통). 형식이 틀리면 아무것도 바꾸지 않고 어디가 틀렸는지 알려 준다.
 * 끝난 단계는 그대로 두고 남은 단계만 바꾼다. 전달한 과제면 담당자에게 바뀐 내용을 DM한다.
 */
export async function handleTaskEditModal(i: ModalSubmitInteraction) {
  if (i.user.id !== config.LEADER_ID) {
    return i.reply({ content: "팀 리더만 할 수 있어요.", flags: MessageFlags.Ephemeral });
  }
  const task = findTask(Number(i.customId.split(":")[1]));
  if (!task || task.status === "done") {
    return i.reply({ content: "이미 끝났거나 없는 과제예요.", flags: MessageFlags.Ephemeral });
  }
  const sent = task.status === "approved";
  const what = sent ? "과제" : "초안";
  const title = i.fields.getTextInputValue("title").trim();
  const due = i.fields.getTextInputValue("due").trim();
  if (!isIsoDate(due)) {
    return i.reply({ content: `마감 ${due}가 올바르지 않아요. ${what}는 바뀌지 않았어요.`, flags: MessageFlags.Ephemeral });
  }
  const { steps: parsed, errors } = parseSteps(i.fields.getTextInputValue("steps"), due);
  if (errors.length) {
    return i.reply({
      content: `수정하지 못했어요. ${what}는 그대로예요.\n${errors.map((e) => `• ${e}`).join("\n")}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const current = stepsOf(task.id);
  const doneCount = current.filter((s) => s.done).length;
  const diff = diffTask(
    { title: task.title, dueDate: task.dueDate, steps: current.filter((s) => !s.done) },
    { title, dueDate: due, steps: parsed },
    doneCount + 1,
  );
  if (diff.changes.length === 0) {
    return i.reply({ content: `바뀐 내용이 없어요. ${what}는 그대로 뒀어요.`, flags: MessageFlags.Ephemeral });
  }

  db.transaction((tx) => {
    tx.update(tasks)
      .set({ title, dueDate: due, ...(sent ? {} : { draftEdits: (task.draftEdits ?? 0) + 1 }) })
      .where(eq(tasks.id, task.id))
      .run();
    tx.delete(steps).where(and(eq(steps.taskId, task.id), eq(steps.done, false))).run();
    tx.insert(steps)
      .values(parsed.map((s, idx) => ({ taskId: task.id, position: doneCount + idx + 1, ...s })))
      .run();
  });

  if (!sent) {
    const updated = renderDraft(findTask(task.id)!);
    if (i.isFromMessage()) return i.update(updated);
    return i.reply({ ...updated, flags: MessageFlags.Ephemeral });
  }

  const summary = diff.changes.map((c) => `• ${c}`).join("\n");
  let notice = `✏️ <@${task.assigneeId}> [${title}] 수정했고 알렸어요\n${summary}`;
  try {
    await sendDm(i.client, task.assigneeId, changeMessage(`✏️ [${title}] 과제가 수정됐어요`, diff, doneCount));
  } catch (err) {
    console.error(`수정 알림 DM 실패 task=${task.id}`, err);
    notice = `✏️ <@${task.assigneeId}> [${title}] 수정했지만 DM을 보내지 못했어요. DM 허용 설정을 확인해 주세요.\n${summary}`;
  }
  const reply = { content: notice, components: [], allowedMentions: { parse: [] as never[] } };
  if (i.isFromMessage()) return i.update(reply);
  return i.reply({ ...reply, flags: MessageFlags.Ephemeral });
}

// ---- 마감 변경 요청 (담당자 → 팀 리더 승인) ----

function dueRequestModal(task: Task) {
  return new ModalBuilder()
    .setCustomId(`duereq:${task.id}`)
    .setTitle(`마감 변경 요청 (지금 ${task.dueDate})`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("due").setLabel("바꾸고 싶은 최종 마감 (YYYY-MM-DD)").setStyle(TextInputStyle.Short)
          .setValue(task.dueDate).setMinLength(10).setMaxLength(10).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("reason").setLabel("이유 (팀 리더님께 그대로 전달돼요)").setStyle(TextInputStyle.Paragraph)
          .setMaxLength(300).setRequired(true),
      ),
    );
}

export async function handleDueChangeCommand(i: ChatInputCommandInteraction) {
  const active = activeTasksOf(i.user.id);
  if (active.length === 0) {
    return i.reply({ content: "지금 진행 중인 과제가 없어요.", flags: MessageFlags.Ephemeral });
  }
  if (active.length === 1) return i.showModal(dueRequestModal(active[0]));
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    active.slice(0, 5).map((t) =>
      new ButtonBuilder().setCustomId(`dueask:${t.id}`).setLabel(t.title.slice(0, 80)).setStyle(ButtonStyle.Primary),
    ),
  );
  return i.reply({ content: "어느 과제의 마감을 바꾸고 싶나요?", components: [row], flags: MessageFlags.Ephemeral });
}

export async function handleDueAskButton(i: ButtonInteraction) {
  const task = findTask(Number(i.customId.split(":")[1]));
  if (!task || task.assigneeId !== i.user.id || task.status !== "approved") {
    return i.update({ content: "이 과제는 마감 변경을 요청할 수 없어요.", components: [] });
  }
  return i.showModal(dueRequestModal(task));
}

/** 요청 입력창 제출: 검증 후 요청을 저장하고 팀 리더에게 [승인] [거절] 버튼과 함께 DM한다. */
export async function handleDueRequestModal(i: ModalSubmitInteraction) {
  const own = (content: string) => i.reply({ content, flags: MessageFlags.Ephemeral });
  const task = findTask(Number(i.customId.split(":")[1]));
  if (!task || task.assigneeId !== i.user.id || task.status !== "approved") {
    return own("이 과제는 마감 변경을 요청할 수 없어요.");
  }
  const newDue = i.fields.getTextInputValue("due").trim();
  const reason = i.fields.getTextInputValue("reason").trim();
  if (!isIsoDate(newDue)) return own(`날짜 ${newDue}가 올바르지 않아요. YYYY-MM-DD로 적어 주세요.`);
  if (newDue < todayKst()) return own("오늘보다 이전 날짜로는 바꿀 수 없어요.");
  if (newDue === task.dueDate) return own("지금 마감과 같은 날짜예요.");
  const pending = db.select().from(dueRequests)
    .where(and(eq(dueRequests.taskId, task.id), eq(dueRequests.status, "pending"))).get();
  if (pending) return own(`이미 ${pending.newDue}로 바꾸는 요청이 팀 리더님 확인을 기다리고 있어요.`);

  const req = db.insert(dueRequests)
    .values({ taskId: task.id, oldDue: task.dueDate, newDue, reason }).returning().get();
  try {
    await sendDm(i.client, config.LEADER_ID, {
      content:
        `📅 <@${task.assigneeId}> 마감 변경 요청\n[${task.title}] ${task.dueDate} → **${newDue}**\n> ${reason.replace(/\n/g, "\n> ")}\n\n남은 단계:\n` +
        stepLines(stepsOf(task.id).filter((s) => !s.done)),
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`duedecide:${req.id}:yes`).setLabel("승인").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`duedecide:${req.id}:no`).setLabel("거절").setStyle(ButtonStyle.Secondary),
        ),
      ],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error(`마감 변경 요청 DM 실패 req=${req.id}`, err);
    db.delete(dueRequests).where(eq(dueRequests.id, req.id)).run();
    return own("팀 리더님께 요청을 보내지 못했어요. 잠시 뒤 다시 시도하거나 직접 말씀해 주세요.");
  }
  return own(`팀 리더님께 [${task.title}] 마감을 ${newDue}로 바꾸는 요청을 보냈어요. 결과는 DM으로 알려 드릴게요.`);
}

/**
 * 팀 리더의 [승인] [거절]. 승인하면 마감을 바꾸고, 남은 단계 중 새 마감보다 늦거나
 * 예전 마감에 맞춰 있던 단계는 새 마감으로 옮긴다. 결과는 담당자에게 DM한다.
 */
export async function handleDueDecision(i: ButtonInteraction) {
  if (i.user.id !== config.LEADER_ID) {
    return i.reply({ content: "팀 리더만 할 수 있어요.", flags: MessageFlags.Ephemeral });
  }
  const [, id, answer] = i.customId.split(":");
  const req = db.select().from(dueRequests).where(eq(dueRequests.id, Number(id))).get();
  const task = req && findTask(req.taskId);
  if (!req || req.status !== "pending" || !task || task.status !== "approved") {
    return i.update({ content: `${i.message.content}\n\n이미 처리됐거나 끝난 과제의 요청이에요.`, components: [] });
  }

  let toAssignee: string;
  let note: string;
  if (answer === "yes") {
    const beforeSteps = stepsOf(task.id);
    db.transaction((tx) => {
      tx.update(tasks).set({ dueDate: req.newDue }).where(eq(tasks.id, task.id)).run();
      for (const s of tx.select().from(steps).where(and(eq(steps.taskId, task.id), eq(steps.done, false))).all()) {
        if (s.dueDate > req.newDue || s.dueDate === req.oldDue) {
          tx.update(steps).set({ dueDate: req.newDue }).where(eq(steps.id, s.id)).run();
        }
      }
      tx.update(dueRequests).set({ status: "approved" }).where(eq(dueRequests.id, req.id)).run();
    });
    const doneCount = beforeSteps.filter((s) => s.done).length;
    const diff = diffTask(
      { title: task.title, dueDate: req.oldDue, steps: beforeSteps.filter((s) => !s.done) },
      { title: task.title, dueDate: req.newDue, steps: stepsOf(task.id).filter((s) => !s.done) },
      doneCount + 1,
    );
    toAssignee = changeMessage(`✅ [${task.title}] 마감 변경이 승인됐어요`, diff, doneCount);
    note = "✅ 승인했어요. 단계 일정을 더 고치려면 `/과제수정`을 쓰세요.";
  } else {
    db.update(dueRequests).set({ status: "rejected" }).where(eq(dueRequests.id, req.id)).run();
    toAssignee = `[${task.title}] 마감 변경(${req.newDue})은 이번에는 어렵대요. 마감은 ${task.dueDate} 그대로예요. 팀 리더님과 직접 이야기해 보세요.`;
    note = "거절했어요. 담당자에게 알렸어요.";
  }
  try {
    await sendDm(i.client, task.assigneeId, toAssignee);
  } catch (err) {
    console.error(`마감 변경 결과 DM 실패 req=${req.id}`, err);
    note += " (담당자에게 DM을 보내지 못했어요.)";
  }
  return i.update({ content: `${i.message.content}\n\n${note}`, components: [], allowedMentions: { parse: [] } });
}

export async function handleWeekly(i: ChatInputCommandInteraction) {
  if (i.user.id !== config.LEADER_ID) {
    return i.reply({ content: "팀 리더만 볼 수 있어요.", flags: MessageFlags.Ephemeral });
  }
  return i.reply({ content: weeklyReport(), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}
