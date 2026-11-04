import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { activeTasksOf, completeCurrentStep, findTask, statusReport } from "./jobs.js";

export const statusCommand = new SlashCommandBuilder()
  .setName("현황")
  .setDescription("진행 중인 과제 현황을 봅니다 (팀 리더 전용)");

export async function handleStatus(i: ChatInputCommandInteraction) {
  if (i.user.id !== config.LEADER_ID) {
    return i.reply({ content: "팀 리더만 현황을 볼 수 있어요.", flags: MessageFlags.Ephemeral });
  }
  // 멘션은 표시만 되고 알림은 가지 않게 막는다.
  return i.reply({ content: statusReport(), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}
import { eq } from "drizzle-orm";
import { draftSteps } from "./ai.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { todayKst } from "./dates.js";
import { members, steps, tasks } from "./schema.js";

export const assignCommand = new SlashCommandBuilder()
  .setName("과제")
  .setDescription("담당자에게 과제를 맡깁니다 (단계 초안을 만들어 확인받습니다)")
  .addUserOption((o) => o.setName("담당자").setDescription("과제를 맡을 사람").setRequired(true))
  .addStringOption((o) => o.setName("내용").setDescription("과제 설명").setRequired(true))
  .addStringOption((o) => o.setName("마감").setDescription("YYYY-MM-DD").setRequired(true));

// 담당자가 체크인을 기다리지 않고 지금 단계 완료를 등록한다. 봇 DM에서도 쓸 수 있게 전역 명령으로 등록.
export const doneCommand = new SlashCommandBuilder()
  .setName("완료")
  .setDescription("지금 단계를 끝냈다고 코치에게 알립니다")
  .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
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

  const lines = draft.steps.map((s, idx) => `${idx + 1}. ${s.title} - ${s.dueDate}`);
  await i.editReply({
    content: `원문: ${raw}\n\n[과제] ${draft.title} - <@${assignee.id}>, 마감 ${due}\n${lines.join("\n")}`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`approve:${task.id}`).setLabel("이대로 전달").setStyle(ButtonStyle.Success),
      ),
    ],
  });
}

export async function handleButton(i: ButtonInteraction) {
  const [action, id] = i.customId.split(":");
  if (action !== "approve") return;
  if (i.user.id !== config.LEADER_ID) {
    return i.reply({ content: "팀 리더만 승인할 수 있어요.", flags: MessageFlags.Ephemeral });
  }
  const task = db.update(tasks).set({ status: "approved" }).where(eq(tasks.id, Number(id))).returning().get();
  const list = db.select().from(steps).where(eq(steps.taskId, task.id)).orderBy(steps.position).all();
  const user = await i.client.users.fetch(task.assigneeId);
  await user.send(
    `새 과제가 왔어요: ${task.title} (마감 ${task.dueDate})\n` +
      list.map((s) => `${s.position}. ${s.title} - ${s.dueDate}`).join("\n"),
  );
  await i.update({ content: `${i.message.content}\n\n✅ 담당자에게 전달했어요.`, components: [] });
}
