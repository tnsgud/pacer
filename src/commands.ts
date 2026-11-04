import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
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
