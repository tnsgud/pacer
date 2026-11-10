import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Client,
  type MessageCreateOptions,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import cron from "node-cron";
import { coachBlocked } from "./ai.js";
import { config } from "./config.js";
import { businessDaysBetween, deadlineRisk, isBusinessDate, isWorkingHours, todayKst } from "./dates.js";
import { db } from "./db.js";
import { checkins, dueRequests, members, steps, tasks } from "./schema.js";

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

/**
 * 누가 무엇을 해서 생긴 알림 DM(새 과제, 과제 수정, 마감 변경, 막힘 전달 등)을 보낸다.
 * 근무 시간(평일 WORK_START~WORK_END) 밖이면 알림 없이(@silent) 보내고, 받은 사람이 담당자면
 * 다음 아침 안내에 "어제 퇴근 뒤 바뀐 게 있어요"를 한 줄 붙이도록 표시해 둔다.
 * 정해진 시각의 아침 안내·체크인·리포트는 원래 근무 시간에 나가므로 이 함수를 쓰지 않는다.
 */
export async function sendDm(client: Client, userId: string, msg: string | MessageCreateOptions) {
  const opts: MessageCreateOptions = typeof msg === "string" ? { content: msg } : msg;
  const quiet = !isWorkingHours(new Date(), config.WORK_START, config.WORK_END);
  const user = await client.users.fetch(userId);
  await user.send(quiet ? { ...opts, flags: MessageFlags.SuppressNotifications } : opts);
  if (quiet) db.update(members).set({ quietNotice: true }).where(eq(members.id, userId)).run();
}

/** 지금 단계를 끝냄으로 표시하고 담당자에게 보낼 답장을 돌려준다. 체크인 버튼과 /완료가 함께 쓴다. */
export function completeCurrentStep(task: Task): string {
  const [step, next] = openSteps(task.id);
  if (!step) return `[${task.title}]은 이미 모든 단계를 끝냈어요.`;
  db.update(steps).set({ done: true, doneAt: todayKst() }).where(eq(steps.id, step.id)).run();
  saveCheckin(task, "done", null, step.title); // 현황의 "마지막 체크인"에 반영
  if (!next) {
    db.update(tasks).set({ status: "done", completedAt: todayKst() }).where(eq(tasks.id, task.id)).run();
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

/** 팀 리더가 현황에서 처음 본 막힘 체크인·주의 과제. 보낸 뒤에 markLeaderSeen으로 기록한다(성공 기준 측정용). */
export type Seen = { blockedCheckinIds: number[]; riskTaskIds: number[] };

export function markLeaderSeen(seen: Seen, today = todayKst()) {
  for (const id of seen.blockedCheckinIds) {
    db.update(checkins).set({ leaderSeenAt: today }).where(and(eq(checkins.id, id), isNull(checkins.leaderSeenAt))).run();
  }
  for (const id of seen.riskTaskIds) {
    db.update(tasks).set({ riskWarnedAt: today }).where(and(eq(tasks.id, id), isNull(tasks.riskWarnedAt))).run();
  }
}

/**
 * 팀 리더용 현황. /현황과 아침 요약이 함께 쓴다.
 * 막힘 요약 문구는 담당자가 전달에 동의한 경우(shared)에만 붙인다.
 * seen을 넘기면 이 현황에 들어간 막힘 체크인과 주의 과제를 모아 준다.
 */
export function statusReport(today = todayKst(), seen?: Seen): string {
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
    const pending = db
      .select()
      .from(dueRequests)
      .where(and(eq(dueRequests.taskId, task.id), eq(dueRequests.status, "pending")))
      .get();

    const line =
      `<@${task.assigneeId}> ${task.title} - ${all.length - open.length}/${all.length}단계` +
      (step ? `, 지금 ${step.position}. ${step.title}(목표 ${mmdd(step.dueDate)})` : "") +
      `, 마지막 체크인 ${last ? `${mmdd(last.date)} ${STATUS_LABEL[last.status]}` : "없음"}` +
      `, 마감 ${mmdd(task.dueDate)} (${risk.reason})` +
      (pending ? `, 📅 마감 변경 요청 ${mmdd(pending.newDue)} 대기` : "") +
      (last?.status === "blocked" && last.shared && last.summary ? `\n  └ ${last.summary}` : "");

    if (last?.status === "blocked") {
      groups.막힘.push(line);
      seen?.blockedCheckinIds.push(last.id);
    } else if (businessDaysBetween(since, today) >= 2) groups["응답 없음"].push(line);
    else if (risk.atRisk || (step && step.dueDate < today)) {
      groups.주의.push(line);
      seen?.riskTaskIds.push(task.id);
    } else groups.순조로움.push(line);
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

/** 오늘 체크인을 기록한다(과제·사람·날짜당 하나, 다시 답하면 덮어씀). 단계 제목은 주간 리포트용으로 복사해 둔다. */
function saveCheckin(task: Task, status: CheckinStatus, summary: string | null, stepTitle = openSteps(task.id)[0]?.title ?? null) {
  db.insert(checkins)
    .values({ taskId: task.id, memberId: task.assigneeId, date: todayKst(), status, summary, stepTitle })
    .onConflictDoUpdate({
      target: [checkins.taskId, checkins.memberId, checkins.date],
      set: { status, summary, stepTitle, shared: false }, // 답이 바뀌면 전달 동의도 다시 받는다
    })
    .run();
}

export function scheduleJobs(client: Client) {
  // 평일 17:00 KST 저녁 체크인
  // ponytail: 17:00에 봇이 꺼져 있으면 그날 체크인은 건너뛴다. 필요해지면 시작 시 보정 발송 추가.
  cron.schedule("0 17 * * 1-5", () => void sendEveningCheckins(client).catch(console.error), {
    timezone: "Asia/Seoul",
  });
  // 평일 09:00 KST 아침 요약·안내
  cron.schedule("0 9 * * 1-5", () => void sendMorning(client).catch(console.error), { timezone: "Asia/Seoul" });
  // 금요일 16:00 KST 주간 리포트 (저녁 체크인 전)
  cron.schedule("0 16 * * 5", () => void sendWeekly(client).catch(console.error), { timezone: "Asia/Seoul" });
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
    .set({ shared: true, leaderSeenAt: todayKst() })
    .where(and(eq(checkins.taskId, task.id), eq(checkins.date, todayKst()), eq(checkins.status, "blocked")))
    .returning()
    .get();
  if (!checkin) {
    return i.update({ content: `${base}\n\n오늘 막힘 기록이 없어서 전달하지 않았어요.`, components: [] });
  }
  await sendDm(i.client, config.LEADER_ID, {
    content: `🚧 <@${task.assigneeId}> [${task.title}] 막힘\n> ${checkin.summary}\n담당자가 전달에 동의한 요약이에요.`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`reply:${checkin.id}`).setLabel("답장 보내기").setStyle(ButtonStyle.Primary),
      ),
    ],
    allowedMentions: { parse: [] },
  });
  await i.update({ content: `${base}\n\n팀 리더님께 요약을 전달했어요.`, components: [] });
}

// ---- 아침: 팀 리더 요약 DM + 담당자 오늘 할 단계 안내 ----

/** 담당자 아침 DM에 붙이는 마감 경고. 늦어진 단계가 있거나 남은 단계가 남은 영업일보다 많을 때. */
function morningRiskNote(task: Task, today: string): string {
  const open = openSteps(task.id);
  const risk = deadlineRisk(open.length, today, task.dueDate);
  if (risk.atRisk) return `\n⚠️ 마감이 빠듯해요 (${risk.reason}). 어려우면 /마감변경 으로 팀 리더님께 요청하세요.`;
  if (open[0] && open[0].dueDate < today) return `\n⚠️ 지금 단계 목표일(${mmdd(open[0].dueDate)})이 지났어요. 막혔다면 /막힘 으로 알려 주세요.`;
  return "";
}

export async function sendMorning(client: Client) {
  const today = todayKst();
  if (!isBusinessDate(today)) return;

  try {
    const seen: Seen = { blockedCheckinIds: [], riskTaskIds: [] };
    const leader = await client.users.fetch(config.LEADER_ID);
    await leader.send({ content: statusReport(today, seen), allowedMentions: { parse: [] } });
    markLeaderSeen(seen, today);
  } catch (err) {
    console.error("팀 리더 아침 요약 DM 실패", err);
  }

  const noticed = new Set<string>();
  for (const task of db.select().from(tasks).where(eq(tasks.status, "approved")).all()) {
    const [step] = openSteps(task.id);
    if (!step) continue;
    try {
      // 퇴근 뒤 소리 없이 보낸 DM이 있으면 그 사람의 첫 아침 안내에만 한 줄 알린다.
      const member = db.select().from(members).where(eq(members.id, task.assigneeId)).get();
      const quietNote = member?.quietNotice && !noticed.has(task.assigneeId)
        ? "📝 어제 퇴근 뒤 바뀐 일정·알림이 있어요. 위쪽 DM을 확인해 주세요.\n\n"
        : "";
      const user = await client.users.fetch(task.assigneeId);
      await user.send(
        quietNote +
        `좋은 아침이에요! [${task.title}]\n` +
          `오늘 할 단계: ${step.position}. ${step.title} (목표 ${mmdd(step.dueDate)})\n` +
          `최종 마감 ${mmdd(task.dueDate)}까지 영업일 ${businessDaysBetween(today, task.dueDate)}일. 끝나면 /완료 로 알려 주세요.` +
          morningRiskNote(task, today),
      );
      if (quietNote) {
        noticed.add(task.assigneeId);
        db.update(members).set({ quietNotice: false }).where(eq(members.id, task.assigneeId)).run();
      }
    } catch (err) {
      console.error(`아침 안내 DM 실패 task=${task.id}`, err);
    }
  }
}

// ---- 주간 리포트 (금요일 16:00 팀 리더 DM, /주간리포트) ----

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (iso: string) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
const DISCORD_LIMIT = 1990;

/**
 * 이번 주(월요일~오늘) 리포트: 과제별 완료율, 자주 막힌 단계, 사람별 체크인 응답률.
 * 응답률의 분모는 과제를 받은 뒤의 영업일. 오늘은 이미 답했을 때만 센다(16:00 발송이 17:00 체크인보다 먼저라서).
 */
export function weeklyReport(today = todayKst()): string {
  const monday = mondayOf(today);
  const inWeek = (d: string | null) => !!d && d >= monday && d <= today;
  const lines: string[] = [`📊 주간 리포트 ${mmdd(monday)}~${mmdd(today)}`];

  // 1) 과제별 완료율: 진행 중인 과제 + 이번 주에 끝난 과제
  const taskLines: string[] = [];
  for (const task of db.select().from(tasks).where(eq(tasks.status, "approved")).all()
    .concat(db.select().from(tasks).where(eq(tasks.status, "done")).all())) {
    const all = db.select().from(steps).where(eq(steps.taskId, task.id)).all();
    const done = all.filter((s) => s.done);
    const thisWeek = done.filter((s) => inWeek(s.doneAt)).length;
    if (task.status === "done" && thisWeek === 0) continue; // 지난주 이전에 끝난 과제는 뺀다
    const pct = all.length ? Math.round((done.length / all.length) * 100) : 0;
    const risk = task.status === "approved" ? deadlineRisk(all.length - done.length, today, task.dueDate) : null;
    taskLines.push(
      `• <@${task.assigneeId}> ${task.title} - ${done.length}/${all.length}단계 (${pct}%), 이번 주 ${thisWeek}단계` +
        (task.status === "done" ? " ✅ 완료" : "") +
        (risk?.atRisk ? ` ⚠️ 마감 ${mmdd(task.dueDate)} (${risk.reason})` : ""),
    );
  }
  lines.push(taskLines.length ? `**과제별 완료율**\n${taskLines.join("\n")}` : "**과제별 완료율**: 이번 주 진행한 과제가 없어요.");

  // 2) 자주 막힌 단계: 이번 주 막힘 체크인을 (과제 제목, 단계 제목)으로 묶는다. 사람이 달라도 같은 과제면 합친다.
  const weekCheckins = db.select({ c: checkins, title: tasks.title }).from(checkins)
    .innerJoin(tasks, eq(tasks.id, checkins.taskId)).all()
    .filter(({ c }) => inWeek(c.date));
  const blockedCount = new Map<string, number>();
  for (const { c, title } of weekCheckins) {
    if (c.status !== "blocked") continue;
    const key = `${title} › ${c.stepTitle ?? "(단계 정보 없음)"}`;
    blockedCount.set(key, (blockedCount.get(key) ?? 0) + 1);
  }
  const top = [...blockedCount].sort((a, b) => b[1] - a[1]).slice(0, 5);
  lines.push(top.length
    ? `**자주 막힌 단계**\n${top.map(([k, n]) => `• ${k} - ${n}회`).join("\n")}`
    : "**자주 막힌 단계**: 이번 주 막힘 없음");

  // 3) 체크인 응답률 (운영 지표, 목표 80%)
  const rateLines = responseRates(monday, today).map(
    (r) => `• <@${r.memberId}> ${r.replied}/${r.asked}일 (${pct(r.replied, r.asked)}%)`,
  );
  lines.push(rateLines.length ? `**체크인 응답률** (목표 80%)\n${rateLines.join("\n")}` : "**체크인 응답률**: 해당 없음");

  const text = lines.join("\n\n");
  return text.length > DISCORD_LIMIT ? `${text.slice(0, DISCORD_LIMIT - 10)}\n…(생략)` : text;
}

export async function sendWeekly(client: Client) {
  const leader = await client.users.fetch(config.LEADER_ID);
  await leader.send({ content: weeklyReport(), allowedMentions: { parse: [] } });
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

/**
 * 사람별 체크인 응답률. 분모는 [from, today] 중 과제를 받은 뒤의 영업일.
 * 오늘은 이미 답했을 때만 센다(리포트가 17:00 체크인보다 먼저 나갈 수 있어서).
 */
function responseRates(from: string, today: string) {
  const result: { memberId: string; asked: number; replied: number }[] = [];
  for (const m of db.select().from(members).all()) {
    const mine = db.select().from(tasks).where(eq(tasks.assigneeId, m.id)).all().filter((t) => t.status !== "draft");
    if (mine.length === 0) continue;
    const answered = new Set(
      db.select({ date: checkins.date }).from(checkins).where(eq(checkins.memberId, m.id)).all().map((c) => c.date),
    );
    const firstDay = mine.map((t) => t.createdAt.slice(0, 10)).sort()[0];
    let asked = 0;
    let replied = 0;
    for (let d = from > firstDay ? from : firstDay; d <= today; d = addDays(d, 1)) {
      if (!isBusinessDate(d)) continue;
      if (!mine.some((t) => t.createdAt.slice(0, 10) <= d)) continue;
      if (d === today && !answered.has(d)) continue;
      asked++;
      if (answered.has(d)) replied++;
    }
    if (asked) result.push({ memberId: m.id, asked, replied });
  }
  return result;
}

/**
 * 기획안 섹션 5-2 성공 기준을 since(없으면 전체 기간)부터 누적으로 계산한다.
 * 봇 사용자에게 보여 주는 기능이 아니라 도입 평가용이라 Discord에는 내보내지 않고 `npm run metrics`로만 본다.
 * 봇 밖에서 재야 하는 것("어디까지 했어?" 횟수, 설문)은 넣지 않는다.
 */
export function successReport(today = todayKst(), sinceDate?: string): string {
  const since = sinceDate ?? "0000-01-01";
  const created = (t: Task) => t.createdAt.slice(0, 10) >= since;
  const mark = (ok: boolean) => (ok ? "✅" : "❌");
  const all = db.select().from(tasks).all().filter((t) => t.status !== "draft" && created(t));
  const out: string[] = [`성공 기준 (${sinceDate ? `${sinceDate}부터 ${today}까지` : `전체 기간, ${today}까지`})`];

  // 1) 초안의 80% 이상이 수정 1회 이내로 확정 (복사본은 빼고 원본만)
  const drafts = all.filter((t) => t.draftEdits !== null);
  const fewEdits = drafts.filter((t) => (t.draftEdits ?? 0) <= 1).length;
  out.push(drafts.length
    ? `${mark(pct(fewEdits, drafts.length) >= 80)} 초안 수정 1회 이내 확정 ${fewEdits}/${drafts.length} (${pct(fewEdits, drafts.length)}%, 목표 80%)`
    : "➖ 초안 수정 1회 이내 확정: 아직 전달한 초안 없음");

  // 2) 체크인 응답률 80% 이상 (사람별)
  const rates = responseRates(since, today);
  out.push(rates.length
    ? `${mark(rates.every((r) => pct(r.replied, r.asked) >= 80))} 체크인 응답률 ` +
        rates.map((r) => `<@${r.memberId}> ${pct(r.replied, r.asked)}%`).join(", ") + " (목표 80%)"
    : "➖ 체크인 응답률: 아직 기록 없음");

  // 3) 막힘이 생긴 뒤 팀 리더가 알기까지 1영업일 이내
  const blocked = db.select().from(checkins).all().filter((c) => c.status === "blocked" && c.date >= since);
  const decided = blocked.filter((c) => c.leaderSeenAt || businessDaysBetween(c.date, today) > 1);
  const inTime = decided.filter((c) => c.leaderSeenAt && businessDaysBetween(c.date, c.leaderSeenAt) <= 1).length;
  out.push(decided.length
    ? `${mark(inTime === decided.length)} 막힘 1영업일 이내 리더 인지 ${inTime}/${decided.length} (목표 전부)`
    : "➖ 막힘 1영업일 이내 리더 인지: 아직 막힘 없음");
  // 참고 (기획안 기준 밖): 리더가 답장까지 한 비율. 1영업일이 안 지난 막힘은 빼고 센다.
  const replyDecided = blocked.filter((c) => c.leaderRepliedAt || businessDaysBetween(c.date, today) > 1);
  const replied = replyDecided.filter((c) => c.leaderRepliedAt && businessDaysBetween(c.date, c.leaderRepliedAt) <= 1).length;
  if (replyDecided.length) out.push(`📎 참고: 막힘에 1영업일 이내 리더 답장 ${replied}/${replyDecided.length}`);

  // 4) 마감 놓친 과제 0건, 놓칠 것 같으면 최소 2영업일 전에 경고
  const missed = all.filter((t) =>
    (t.status === "done" && (t.completedAt ?? "") > t.dueDate) || (t.status === "approved" && t.dueDate < today));
  const warnedEarly = missed.filter((t) => t.riskWarnedAt && businessDaysBetween(t.riskWarnedAt, t.dueDate) >= 2).length;
  out.push(
    `${mark(missed.length === 0)} 마감 놓친 과제 ${missed.length}건 (목표 0건)` +
      (missed.length
        ? `, 2영업일 전 경고 ${warnedEarly}/${missed.length}\n` + missed.slice(0, 3).map((t) => `  └ <@${t.assigneeId}> ${t.title} (마감 ${mmdd(t.dueDate)})`).join("\n")
        : ""),
  );
  return out.join("\n");
}
