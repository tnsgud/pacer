import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from "discord.js";
import {
  assignCommand,
  blockedCommand,
  doneCommand,
  handleAssign,
  handleBlockedCommand,
  handleButton,
  handleDone,
  handleEditTaskCommand,
  handleHelp,
  handlePickEditButton,
  handleSelfBlockedButton,
  handleSelfDoneButton,
  handleStatus,
  handleTaskEditModal,
  editTaskCommand,
  helpCommand,
  statusCommand,
} from "./commands.js";
import { config } from "./config.js";
import { runMigrations } from "./db.js";
import {
  handleBlockedModal,
  handleCheckinButton,
  handleShareButton,
  scheduleJobs,
  sendEveningCheckins,
  sendMorning,
} from "./jobs.js";

runMigrations();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  const rest = new REST().setToken(config.DISCORD_TOKEN);
  // /과제는 팀 서버 전용, /완료·/막힘·/도움말은 봇 DM에서도 쓰도록 전역 등록
  await rest.put(Routes.applicationGuildCommands(config.DISCORD_APP_ID, config.DISCORD_GUILD_ID), {
    body: [assignCommand.toJSON(), editTaskCommand.toJSON(), statusCommand.toJSON()],
  });
  await rest.put(Routes.applicationCommands(config.DISCORD_APP_ID), { body: [doneCommand.toJSON(), blockedCommand.toJSON(), helpCommand.toJSON()] });
  scheduleJobs(c);
  console.log(`logged in as ${c.user.tag}`);
  // 테스트용: npm run dev -- --checkin-now / --morning-now 이면 해당 발송을 바로 한 번 실행한다.
  if (process.argv.includes("--checkin-now")) await sendEveningCheckins(c);
  if (process.argv.includes("--morning-now")) await sendMorning(c);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === "과제") await handleAssign(i);
    else if (i.isChatInputCommand() && i.commandName === "완료") await handleDone(i);
    else if (i.isChatInputCommand() && i.commandName === "현황") await handleStatus(i);
    else if (i.isChatInputCommand() && i.commandName === "과제수정") await handleEditTaskCommand(i);
    else if (i.isChatInputCommand() && i.commandName === "도움말") await handleHelp(i);
    else if (i.isChatInputCommand() && i.commandName === "막힘") await handleBlockedCommand(i);
    else if (i.isButton() && i.customId.startsWith("checkin:")) await handleCheckinButton(i);
    else if (i.isButton() && i.customId.startsWith("selfdone:")) await handleSelfDoneButton(i);
    else if (i.isButton() && i.customId.startsWith("selfblocked:")) await handleSelfBlockedButton(i);
    else if (i.isButton() && i.customId.startsWith("share:")) await handleShareButton(i);
    else if (i.isButton() && i.customId.startsWith("pickedit:")) await handlePickEditButton(i);
    else if (i.isButton()) await handleButton(i);
    else if (i.isModalSubmit() && i.customId.startsWith("blocked:")) await handleBlockedModal(i);
    else if (i.isModalSubmit() && i.customId.startsWith("taskedit:")) await handleTaskEditModal(i);
  } catch (err) {
    console.error(err);
    const msg = "처리 중 오류가 났어요. 잠시 뒤 다시 시도해 주세요.";
    if (i.isRepliable()) await (i.deferred || i.replied ? i.editReply(msg) : i.reply({ content: msg, flags: MessageFlags.Ephemeral }));
  }
});

await client.login(config.DISCORD_TOKEN);
