import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Client,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { and, asc, desc, eq } from "drizzle-orm";
import cron from "node-cron";
import { coachBlocked } from "./ai.js";
import { businessDaysBetween, deadlineRisk, isBusinessDate, todayKst } from "./dates.js";
import { db } from "./db.js";
import { checkins, steps, tasks } from "./schema.js";

type Task = typeof tasks.$inferSelect;
type CheckinStatus = (typeof checkins.$inferInsert)["status"];

const openSteps = (taskId: number) =>
  db
    .select()
    .from(steps)
    .where(and(eq(steps.taskId, taskId), eq(steps.done, false)))
    .orderBy(asc(steps.position))
    .all();

const findTask = (id: number) => db.select().from(tasks).where(eq(tasks.id, id)).get();

/** 지금 단계를 끝냄으로 표시하고 담당자에게 보낼 답장을 돌려준다. 체크인 버튼과 /완료가 함께 쓴다. */
export function completeCurrentStep(task: Task): string {
  const [step, next] = openSteps(task.id);
  if (!step) return `[${task.title}]은 이미 모든 단계를 끝냈어요.`;
  db.update(steps).set({ done: true }).where(eq(steps.id, step.id)).run();
  saveCheckin(task, "done", null); // 오늘 답한 것으로 기록 → 저녁 체크인을 다시 보내지 않는다
  if (!next) {
    db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id)).run();
    return `🎉 마지막 단계까지 끝냈어요! [${task.title}] 완료입니다. 정말 수고했어요.`;
  }
  const ahead = businessDaysBetween(todayKst(), step.dueDate);
  return (
    `✅ ${step.position}. ${step.title} 완료! ` +
    (ahead > 0 ? `계획보다 ${ahead}일 빨리 끝냈네요. ` : "") +
    `잘하고 있어요.\n다음 단계: ${next.position}. ${next.title} (목표 ${next.dueDate})`
  );
}

export const activeTasksOf = (memberId: string) =>
  db
    .select()
    .from(tasks)
    .where(and(eq(tasks.assigneeId, memberId), eq(tasks.status, "approved")))
    .all();

export { findTask };

const mmdd = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const STATUS_LABEL = { done: "완료", doing: "진행 중", blocked: "막힘" } as const;

/**
 * 팀 리더용 현황. /현황과 (다음 단계) 아침 요약이 함께 쓴다.
 * 막힘 요약 문구는 담당자 동의 흐름이 생기기 전까지 넣지 않고 상태만 보여 준다.
 */
export function statusReport(today = todayKst()): string {
  const groups = { 막힘: [] as string[], "응답 없음": [] as string[], 주의: [] as string[], 순조로움: [] as string[] };
  for (const task of db.select().from(tasks).where(eq(tasks.status, "approved")).all()) {
    const all = db.select().from(steps).where(eq(steps.taskId, task.id)).orderBy(asc(steps.position)).all();
    const open = all.filter((s) => !s.done);
    const step = open[0];
    const last = db
      .select()
      .from(checkins)
      .where(eq(checkins.taskId, task.id))
      .orderBy(desc(checkins.date))
      .get();
    const risk = deadlineRisk(open.length, today, task.dueDate);
    const since = last?.date ?? task.createdAt.slice(0, 10);

    const line =
      `<@${task.assigneeId}> ${task.title} - ${all.length - open.length}/${all.length}단계` +
      (step ? `, 지금 ${step.position}. ${step.title}(목표 ${mmdd(step.dueDate)})` : "") +
      `, 마지막 체크인 ${last ? `${mmdd(last.date)} ${STATUS_LABEL[last.status]}` : "없음"}` +
      `, 마감 ${mmdd(task.dueDate)} (${risk.reason})`;

    if (last?.status === "blocked") groups.막힘.push(line);
    else if (businessDaysBetween(since, today) >= 2) groups["응답 없음"].push(line);
    else if (risk.atRisk || (step && step.dueDate < today)) groups.주의.push(line);
    else groups.순조로움.push(line);
  }

  const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
  if (total === 0) return `${mmdd(today)} 진행 중인 과제가 없어요.`;
  return [
    `${mmdd(today)} 팀 과제 현황`,
    ...Object.entries(groups).map(([name, lines]) =>
      lines.length ? `**${name} ${lines.length}**\n${lines.map((l) => `• ${l}`).join("\n")}` : `${name}: 없음`,
    ),
  ].join("\n\n");
}

function saveCheckin(task: Task, status: CheckinStatus, summary: string | null) {
  db.insert(checkins)
    .values({ taskId: task.id, memberId: task.assigneeId, date: todayKst(), status, summary })
    .onConflictDoUpdate({
      target: [checkins.taskId, checkins.memberId, checkins.date],
      set: { status, summary },
    })
    .run();
}

export function scheduleJobs(client: Client) {
  // 평일 18:00 KST 저녁 체크인
  // ponytail: 18:00에 봇이 꺼져 있으면 그날 체크인은 건너뛴다. 필요해지면 시작 시 보정 발송 추가.
  cron.schedule("0 18 * * 1-5", () => void sendEveningCheckins(client).catch(console.error), {
    timezone: "Asia/Seoul",
  });
}

export async function sendEveningCheckins(client: Client) {
  const today = todayKst();
  if (!isBusinessDate(today)) return;
  for (const task of db.select().from(tasks).where(eq(tasks.status, "approved")).all()) {
    const [step] = openSteps(task.id);
    if (!step) continue;
    const answered = db
      .select()
      .from(checkins)
      .where(and(eq(checkins.taskId, task.id), eq(checkins.date, today)))
      .get();
    if (answered) continue;

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`checkin:${task.id}:done`).setLabel("완료").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`checkin:${task.id}:doing`).setLabel("진행 중").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`checkin:${task.id}:blocked`).setLabel("막힘").setStyle(ButtonStyle.Danger),
    );
    try {
      const user = await client.users.fetch(task.assigneeId);
      await user.send({
        content:
          `[${task.title}] 오늘 단계는 끝났나요?\n` +
          `지금 단계: ${step.position}. ${step.title} (목표 ${step.dueDate})\n` +
          `최종 마감 ${task.dueDate}까지 영업일 ${businessDaysBetween(today, task.dueDate)}일`,
        components: [buttons],
      });
    } catch (err) {
      console.error(`체크인 DM 실패 task=${task.id}`, err); // DM 차단 등. 다른 담당자는 계속 보낸다.
    }
  }
}

export async function handleCheckinButton(i: ButtonInteraction) {
  const [, id, status] = i.customId.split(":") as [string, string, CheckinStatus];
  const task = findTask(Number(id));
  if (!task || task.assigneeId !== i.user.id) {
    return i.reply({ content: "이 과제의 담당자만 답할 수 있어요." });
  }

  if (status === "blocked") {
    return i.showModal(
      new ModalBuilder()
        .setCustomId(`blocked:${task.id}`)
        .setTitle("어디서 막혔나요?")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("detail")
              .setLabel("막힌 곳과 에러 메시지를 짧게 적어 주세요")
              .setStyle(TextInputStyle.Paragraph)
              .setMaxLength(500)
              .setRequired(true),
          ),
        ),
    );
  }

  let reply: string;
  if (status === "done") {
    reply = completeCurrentStep(task);
  } else {
    const risk = deadlineRisk(openSteps(task.id).length, todayKst(), task.dueDate);
    reply =
      "좋아요, 내일 또 물어볼게요." +
      (risk.atRisk
        ? `\n⚠️ 마감이 빠듯해요 (${risk.reason}). 일정이나 범위 조정이 필요하면 팀 리더님께 미리 말해 보세요.`
        : "");
    saveCheckin(task, status, null);
  }
  await i.update({ content: `${i.message.content}\n\n→ ${status === "done" ? "완료" : "진행 중"}\n${reply}`, components: [] });
}

export async function handleBlockedModal(i: ModalSubmitInteraction) {
  const task = findTask(Number(i.customId.split(":")[1]));
  if (!task || task.assigneeId !== i.user.id) {
    return i.reply({ content: "이 과제의 담당자만 답할 수 있어요." });
  }
  const detail = i.fields.getTextInputValue("detail");
  await i.deferReply(); // AI 호출 전에 응답 예약
  if (i.isFromMessage()) await i.message.edit({ content: `${i.message.content}\n\n→ 막힘`, components: [] });

  const [step] = openSteps(task.id);
  const coach = await coachBlocked(task.title, step?.title ?? "", detail);
  saveCheckin(task, "blocked", coach.summary);
  await i.editReply(coach.reply);
}
