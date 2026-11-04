import { z } from "zod";
import { config } from "./config.js";

const draftSchema = z.object({
  title: z.string().min(1),
  steps: z
    .array(z.object({ title: z.string().min(1), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .min(1)
    .max(8),
});
export type TaskDraft = z.infer<typeof draftSchema>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 호출부는 이 함수 하나뿐이라 Groq ↔ 다른 업체 교체는 여기서만 한다.
// 429·5xx(과부하)면 1s·2s 간격으로 재시도하고, 그래도 안 되면 대체 모델로 넘어간다.
async function chatJson(system: string, user: string): Promise<unknown> {
  const models = [config.GROQ_MODEL, config.GROQ_FALLBACK_MODEL].filter(Boolean);
  let lastError = "";
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.GROQ_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { choices: { message: { content: string } }[] };
        return JSON.parse(data.choices[0].message.content);
      }
      lastError = `Groq ${res.status} (${model}): ${await res.text()}`;
      console.warn(lastError);
      if (res.status !== 429 && res.status < 500) break; // 404 등은 재시도해도 같다 → 다음 모델
    }
  }
  throw new Error(lastError);
}

export async function draftSteps(rawText: string, today: string, due: string): Promise<TaskDraft> {
  const json = await chatJson(
    `신입 개발자에게 줄 과제를 3~6개의 작은 단계로 나누고 단계마다 중간 마감일(YYYY-MM-DD)을 정한다. ` +
      `마지막 단계의 마감일은 최종 마감일과 같아야 하고, 모든 날짜는 오늘(${today}) 이후, 평일이어야 한다. ` +
      `title과 단계 title은 모두 자연스러운 한국어로, 짧게(30자 이내) 쓴다. 컴포넌트·도구 이름(Storybook 등)만 원문 그대로 둔다. ` +
      `JSON만 출력: {"title": string, "steps": [{"title": string, "dueDate": string}]}`,
    `과제: ${rawText}\n최종 마감일: ${due}`,
  );
  return draftSchema.parse(json);
}
