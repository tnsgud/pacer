import { z } from "zod";

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  LEADER_ID: z.string().min(1),
  GROQ_API_KEY: z.string().min(1),
  GROQ_MODEL: z.string().default("qwen/qwen3.8-27b"),
  GROQ_FALLBACK_MODEL: z.string().default("openai/gpt-oss-120b"),
  DATABASE_PATH: z.string().default("data/pacer.db"),
});

export const config = schema.parse(process.env);
