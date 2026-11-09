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
  // 성공 기준을 셀 운영 시작일 (YYYY-MM-DD). 비우면 전체 기간
  METRICS_SINCE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("").transform(() => undefined)),
});

export const config = schema.parse(process.env);
