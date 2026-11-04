import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from "discord.js";
import { assignCommand, handleAssign, handleButton } from "./commands.js";
import { config } from "./config.js";
import { runMigrations } from "./db.js";

runMigrations();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  await new REST().setToken(config.DISCORD_TOKEN).put(
    Routes.applicationGuildCommands(config.DISCORD_APP_ID, config.DISCORD_GUILD_ID),
    { body: [assignCommand.toJSON()] },
  );
  console.log(`logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === "과제") await handleAssign(i);
    else if (i.isButton()) await handleButton(i);
  } catch (err) {
    console.error(err);
    const msg = "처리 중 오류가 났어요. 잠시 뒤 다시 시도해 주세요.";
    if (i.isRepliable()) await (i.deferred || i.replied ? i.editReply(msg) : i.reply({ content: msg, flags: MessageFlags.Ephemeral }));
  }
});

// jobs(아침 안내·저녁 체크인·팀 리더 요약)는 다음 단계에서 node-cron으로 추가한다.

await client.login(config.DISCORD_TOKEN);
