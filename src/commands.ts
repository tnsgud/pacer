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
import { activeTasksOf, blockedModal, completeCurrentStep, findTask, statusReport } from "./jobs.js";
import { members, steps, tasks } from "./schema.js";

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
  "• 18:00 \"오늘 단계는 끝났나요?\" 체크인이 와요. 낮에 `/완료`를 썼어도 다음 단계 기준으로 와요.",
  "  - [완료] 지금 단계를 끝내고 다음 단계를 알려 드려요.",
  "  - [진행 중] 그대로 기록해요. 마감이 빠듯하면 미리 알려 드려요.",
  "  - [막힘] 막힌 곳을 적으면 힌트를 드리고, 팀 리더님께 전달할지 물어봐요.",
  "    동의할 때만 한 줄 요약이 가고, 대화 원문은 가지 않아요.",
  "",
  "**언제든**",
  "• `/완료` 체크인을 기다리지 않고 지금 단계를 끝냈다고 알려요.",
  "• `/막힘` 막히면 바로 알려요. [막힘] 버튼과 똑같이 힌트를 드리고 전달할지 물어봐요.",
  "  두 명령 모두 봇과의 DM에서도 쓸 수 있어요.",
  "• `/도움말` 이 안내를 다시 봐요.",
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
  "• 과제를 고르면 남은 단계·마감·제목을 고칠 수 있어요. 끝난 단계는 그대로 두고, 담당자에게 바뀐 내용을 DM으로 알려요.",
  "",
  "**현황 보기** `/현황` (서버 채널)",
  "• 막힘 · 응답 없음 · 주의 · 순조로움으로 묶어 보여 드려요.",
  "",
  "**자동으로 오는 것**",
  "• 평일 09:00 팀 과제 현황 DM",
  "• 담당자가 막힘 전달에 동의하면 한 줄 요약 DM",
  "",
  ASSIGNEE_HELP.replace("**코치 사용 방법 (담당자)**", "**담당자가 받는 안내**"),
].join("\n");

export const helpText = (userId: string) => (userId === config.LEADER_ID ? LEADER_HELP : ASSIGNEE_HELP);

export async function handleHelp(i: ChatInputCommandInteraction) {
  return i.reply({ content: helpText(i.user.id), flags: MessageFlags.Ephemeral });
}

const isIsoDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

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
  // 멘션은 표시만 되고 알림은 가지 않게 막는다.
  return i.reply({ content: statusReport(), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
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
        .values({ title: task.title, rawText: task.rawText, assigneeId, dueDate: task.dueDate, status: "approved" })
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
      const user = await i.client.users.fetch(t.assigneeId);
      await user.send(`새 과제가 왔어요: ${t.title} (마감 ${t.dueDate})\n` + stepLines(stepsOf(t.id)));
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

  const doneCount = stepsOf(task.id).filter((s) => s.done).length;
  db.transaction((tx) => {
    tx.update(tasks).set({ title, dueDate: due }).where(eq(tasks.id, task.id)).run();
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

  let notice = `✏️ [${title}] 수정했고 <@${task.assigneeId}>에게 알렸어요.`;
  try {
    const user = await i.client.users.fetch(task.assigneeId);
    await user.send(
      `과제가 수정됐어요: ${title} (마감 ${due})\n` +
        (doneCount ? `끝낸 ${doneCount}단계는 그대로예요.\n` : "") +
        `남은 단계:\n${stepLines(parsed, doneCount + 1)}`,
    );
  } catch (err) {
    console.error(`수정 알림 DM 실패 task=${task.id}`, err);
    notice = `✏️ [${title}] 수정했지만 <@${task.assigneeId}>에게 DM을 보내지 못했어요. DM 허용 설정을 확인해 주세요.`;
  }
  const reply = { content: notice, components: [], allowedMentions: { parse: [] as never[] } };
  if (i.isFromMessage()) return i.update(reply);
  return i.reply({ ...reply, flags: MessageFlags.Ephemeral });
}
