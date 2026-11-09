import { z } from "zod";

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  LEADER_ID: z.string().min(1),
  // Cloudflare Workers AI (기본 AI)
  CF_ACCOUNT_ID: z.string().min(1),
  CF_API_TOKEN: z.string().min(1),
  CF_MODEL: z.string().default("@cf/google/gemma-4-26b-a4b-it"),
  // Groq (선택, 있으면 Workers AI 실패 시 대체)
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("qwen/qwen3.8-27b"),
  DATABASE_PATH: z.string().default("data/pacer.db"),
  // 근무 시간 (KST, HH:MM). 이 밖에 생긴 알림 DM은 소리 없이(@silent) 보낸다.
  WORK_START: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  WORK_END: z.string().regex(/^\d{2}:\d{2}$/).default("18:00"),
});

export const config = schema.parse(process.env);
