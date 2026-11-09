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
import { eq } from "drizzle-orm";
import { draftSteps } from "./ai.js";
import { config } from "./config.js";
import { todayKst } from "./dates.js";
import { db } from "./db.js";
import { activeTasksOf, completeCurrentStep, findTask, statusReport } from "./jobs.js";
import { members, steps, tasks } from "./schema.js";

type Task = typeof tasks.$inferSelect;

export const assignCommand = new SlashCommandBuilder()
  .setName("과제")
  .setDescription("담당자에게 과제를 맡깁니다 (단계 초안을 만들어 확인받습니다)")
  .addUserOption((o) => o.setName("담당자").setDescription("과제를 맡을 사람").setRequired(true))
  .addStringOption((o) => o.setName("내용").setDescription("과제 설명").setRequired(true))
  .addStringOption((o) => o.setName("마감").setDescription("YYYY-MM-DD").setRequired(true));

export const statusCommand = new SlashCommandBuilder()
  .setName("현황")
  .setDescription("진행 중인 과제 현황을 봅니다 (팀 리더 전용)");

// 담당자가 체크인을 기다리지 않고 지금 단계 완료를 등록한다. 봇 DM에서도 쓸 수 있게 전역 명령으로 등록.
export const doneCommand = new SlashCommandBuilder()
  .setName("완료")
  .setDescription("지금 단계를 끝냈다고 코치에게 알립니다")
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);

const isIsoDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

const stepsOf = (taskId: number) =>
  db.select().from(steps).where(eq(steps.taskId, taskId)).orderBy(steps.position).all();

const stepLines = (list: { title: string; dueDate: string }[]) =>
  list.map((s, idx) => `${idx + 1}. ${s.title} - ${s.dueDate}`).join("\n");

/** 팀 리더가 보는 초안 메시지. 처음 만들 때와 수정한 뒤에 같은 모양으로 그린다. */
function renderDraft(task: Task) {
  return {
    content:
      `원문: ${task.rawText}\n\n[과제] ${task.title} - <@${task.assigneeId}>, 마감 ${task.dueDate}\n` +
      stepLines(stepsOf(task.id)),
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
  const assignee = i.options.getUser("담당자", true);
  const raw = i.options.getString("내용", true);
  const due = i.options.getString("마감", true);
  if (!isIsoDate(due)) {
    return i.reply({ content: "마감은 YYYY-MM-DD 형식으로 적어 주세요.", flags: MessageFlags.Ephemeral });
  }

  await i.deferReply({ flags: MessageFlags.Ephemeral }); // AI 호출 전에 응답 예약
  const draft = await draftSteps(raw, todayKst(), due);

  db.insert(members)
    .values({ id: assignee.id, name: assignee.displayName, role: "member" })
    .onConflictDoNothing()
    .run();
  const task = db
    .insert(tasks)
    .values({ title: draft.title, rawText: raw, assigneeId: assignee.id, dueDate: due })
    .returning()
    .get();
  db.insert(steps)
    .values(draft.steps.map((s, idx) => ({ taskId: task.id, position: idx + 1, ...s })))
    .run();

  await i.editReply(renderDraft(task));
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

  if (action === "edit") {
    return i.showModal(
      new ModalBuilder()
        .setCustomId(`editdraft:${task.id}`)
        .setTitle("초안 수정")
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
            new TextInputBuilder().setCustomId("steps").setLabel("단계 (한 줄에 하나: 제목 - YYYY-MM-DD)")
              .setStyle(TextInputStyle.Paragraph).setValue(stepLines(stepsOf(task.id))).setMaxLength(2000).setRequired(true),
          ),
        ),
    );
  }

  const approved = db.update(tasks).set({ status: "approved" }).where(eq(tasks.id, task.id)).returning().get();
  const user = await i.client.users.fetch(approved.assigneeId);
  await user.send(`새 과제가 왔어요: ${approved.title} (마감 ${approved.dueDate})\n` + stepLines(stepsOf(approved.id)));
  await i.update({ content: `${i.message.content}\n\n✅ 담당자에게 전달했어요.`, components: [] });
}

/** [수정] 입력창 제출. 형식이 틀리면 초안은 그대로 두고 어디가 틀렸는지 알려 준다. */
export async function handleEditDraftModal(i: ModalSubmitInteraction) {
  if (i.user.id !== config.LEADER_ID) {
    return i.reply({ content: "팀 리더만 할 수 있어요.", flags: MessageFlags.Ephemeral });
  }
  const task = findTask(Number(i.customId.split(":")[1]));
  if (!task || task.status !== "draft") {
    return i.reply({ content: "이미 처리된 초안이에요.", flags: MessageFlags.Ephemeral });
  }
  const title = i.fields.getTextInputValue("title").trim();
  const due = i.fields.getTextInputValue("due").trim();
  if (!isIsoDate(due)) {
    return i.reply({ content: `마감 ${due}가 올바르지 않아요. 초안은 바뀌지 않았어요.`, flags: MessageFlags.Ephemeral });
  }
  const { steps: parsed, errors } = parseSteps(i.fields.getTextInputValue("steps"), due);
  if (errors.length) {
    return i.reply({
      content: `수정하지 못했어요. 초안은 그대로예요.\n${errors.map((e) => `• ${e}`).join("\n")}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  db.transaction((tx) => {
    tx.update(tasks).set({ title, dueDate: due }).where(eq(tasks.id, task.id)).run();
    tx.delete(steps).where(eq(steps.taskId, task.id)).run();
    tx.insert(steps).values(parsed.map((s, idx) => ({ taskId: task.id, position: idx + 1, ...s }))).run();
  });
  const updated = renderDraft(findTask(task.id)!);
  if (i.isFromMessage()) return i.update(updated);
  return i.reply({ ...updated, flags: MessageFlags.Ephemeral });
}
