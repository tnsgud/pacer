import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Client,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { and, asc, desc, eq } from "drizzle-orm";
import cron from "node-cron";
import { coachBlocked } from "./ai.js";
import { config } from "./config.js";
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
  saveCheckin(task, "done", null); // 현황의 "마지막 체크인"에 반영
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
 * 팀 리더용 현황. /현황과 아침 요약이 함께 쓴다.
 * 막힘 요약 문구는 담당자가 전달에 동의한 경우(shared)에만 붙인다.
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
      `, 마감 ${mmdd(task.dueDate)} (${risk.reason})` +
      (last?.status === "blocked" && last.shared && last.summary ? `\n  └ ${last.summary}` : "");

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
      set: { status, summary, shared: false }, // 답이 바뀌면 전달 동의도 다시 받는다
    })
    .run();
}

export function scheduleJobs(client: Client) {
  // 평일 18:00 KST 저녁 체크인
  // ponytail: 18:00에 봇이 꺼져 있으면 그날 체크인은 건너뛴다. 필요해지면 시작 시 보정 발송 추가.
  cron.schedule("0 18 * * 1-5", () => void sendEveningCheckins(client).catch(console.error), {
    timezone: "Asia/Seoul",
  });
  // 평일 09:00 KST 아침 요약·안내
  cron.schedule("0 9 * * 1-5", () => void sendMorning(client).catch(console.error), { timezone: "Asia/Seoul" });
}

export async function sendEveningCheckins(client: Client) {
  const today = todayKst();
  if (!isBusinessDate(today)) return;
  for (const task of db.select().from(tasks).where(eq(tasks.status, "approved")).all()) {
    const [step] = openSteps(task.id);
    if (!step) continue;
    // 낮에 /완료·/막힘을 썼어도 보낸다. 새 단계에서 막혔는지 하루 한 번은 확인하기 위해서.
    // (cron은 하루 한 번만 돌므로 같은 날 두 번 가지 않는다. --checkin-now 재시작은 개발용이라 예외.)

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

/** 막힘 입력창. 체크인의 [막힘]과 /막힘이 함께 쓴다. 제출하면 handleBlockedModal로 간다. */
export const blockedModal = (taskId: number) =>
  new ModalBuilder()
    .setCustomId(`blocked:${taskId}`)
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
    );

export async function handleCheckinButton(i: ButtonInteraction) {
  const [, id, status] = i.customId.split(":") as [string, string, CheckinStatus];
  const task = findTask(Number(id));
  if (!task || task.assigneeId !== i.user.id) {
    return i.reply({ content: "이 과제의 담당자만 답할 수 있어요." });
  }

  if (status === "blocked") {
    return i.showModal(blockedModal(task.id));
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
  // AI 호출 전에 응답 예약. 서버 채널(/막힘)에서는 남에게 보이지 않게 본인에게만.
  await i.deferReply(i.inGuild() ? { flags: MessageFlags.Ephemeral } : {});
  // 체크인 DM이면 버튼을 지운다. /막힘의 과제 선택 메시지(본인에게만 보이는 메시지)는 수정이 안 돼 무시.
  if (i.isFromMessage()) await i.message.edit({ content: `${i.message.content}\n\n→ 막힘`, components: [] }).catch(() => {});

  const [step] = openSteps(task.id);
  const coach = await coachBlocked(task.title, step?.title ?? "", detail);
  saveCheckin(task, "blocked", coach.summary);
  await i.editReply({
    content:
      `${coach.reply}\n\n` +
      `이 상황을 팀 리더님께 전달할까요? 대화 원문이 아니라 아래 한 줄 요약만 가요.\n> ${coach.summary}`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`share:${task.id}:yes`).setLabel("팀 리더님께 전달").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`share:${task.id}:no`).setLabel("조금 더 해 볼게요").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

/** 막힘 요약을 팀 리더에게 넘길지 담당자가 고른다. 동의하면 리더에게 바로 DM하고 아침 요약·/현황에도 표시. */
export async function handleShareButton(i: ButtonInteraction) {
  const [, id, answer] = i.customId.split(":");
  const task = findTask(Number(id));
  if (!task || task.assigneeId !== i.user.id) {
    return i.reply({ content: "이 과제의 담당자만 고를 수 있어요." });
  }
  const base = i.message.content.split("\n\n이 상황을")[0];
  if (answer !== "yes") {
    return i.update({ content: `${base}\n\n알겠어요. 내일 저녁에 다시 물어볼게요.`, components: [] });
  }
  const checkin = db
    .update(checkins)
    .set({ shared: true })
    .where(and(eq(checkins.taskId, task.id), eq(checkins.date, todayKst()), eq(checkins.status, "blocked")))
    .returning()
    .get();
  if (!checkin) {
    return i.update({ content: `${base}\n\n오늘 막힘 기록이 없어서 전달하지 않았어요.`, components: [] });
  }
  const leader = await i.client.users.fetch(config.LEADER_ID);
  await leader.send({
    content: `🚧 <@${task.assigneeId}> [${task.title}] 막힘\n> ${checkin.summary}\n담당자가 전달에 동의한 요약이에요.`,
    allowedMentions: { parse: [] },
  });
  await i.update({ content: `${base}\n\n팀 리더님께 요약을 전달했어요.`, components: [] });
}

// ---- 아침: 팀 리더 요약 DM + 담당자 오늘 할 단계 안내 ----

export async function sendMorning(client: Client) {
  const today = todayKst();
  if (!isBusinessDate(today)) return;

  try {
    const leader = await client.users.fetch(config.LEADER_ID);
    await leader.send({ content: statusReport(today), allowedMentions: { parse: [] } });
  } catch (err) {
    console.error("팀 리더 아침 요약 DM 실패", err);
  }

  for (const task of db.select().from(tasks).where(eq(tasks.status, "approved")).all()) {
    const [step] = openSteps(task.id);
    if (!step) continue;
    try {
      const user = await client.users.fetch(task.assigneeId);
      await user.send(
        `좋은 아침이에요! [${task.title}]\n` +
          `오늘 할 단계: ${step.position}. ${step.title} (목표 ${mmdd(step.dueDate)})\n` +
          `최종 마감 ${mmdd(task.dueDate)}까지 영업일 ${businessDaysBetween(today, task.dueDate)}일. 끝나면 /완료 로 알려 주세요.`,
      );
    } catch (err) {
      console.error(`아침 안내 DM 실패 task=${task.id}`, err);
    }
  }
}
