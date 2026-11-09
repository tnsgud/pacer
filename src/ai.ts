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

type Provider = { name: string; url: string; key: string; model: string };

// 기본은 Cloudflare Workers AI(무료 하루 10,000 Neurons), Groq 키가 있으면 대체 업체로 쓴다.
// 둘 다 OpenAI 호환 /chat/completions 형식이라 주소·키·모델만 다르다.
export function providers(): Provider[] {
  const list: Provider[] = [
    {
      name: "Workers AI",
      url: `https://api.cloudflare.com/client/v4/accounts/${config.CF_ACCOUNT_ID}/ai/v1/chat/completions`,
      key: config.CF_API_TOKEN,
      model: config.CF_MODEL,
    },
  ];
  if (config.GROQ_API_KEY) {
    list.push({
      name: "Groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: config.GROQ_API_KEY,
      model: config.GROQ_MODEL,
    });
  }
  return list;
}

/** 모델이 ```json 코드블록이나 앞뒤 설명을 붙여도 JSON 객체만 꺼낸다. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`JSON 없음: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

// 호출부는 이 함수 하나뿐이라 업체 교체는 여기서만 한다.
// 429·5xx(과부하)면 1s·2s 간격으로 재시도하고, 그래도 안 되거나 JSON이 깨지면 다음 업체로 넘어간다.
async function chatJson(system: string, user: string): Promise<unknown> {
  let lastError = "";
  for (const p of providers()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      const res = await fetch(p.url, {
        method: "POST",
        headers: { authorization: `Bearer ${p.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: p.model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { choices: { message: { content: string } }[] };
        try {
          return extractJson(data.choices[0].message.content);
        } catch (err) {
          lastError = `${p.name} (${p.model}) JSON 파싱 실패: ${err}`;
          console.warn(lastError);
          break; // 같은 모델로 다시 해도 비슷하다 → 다음 업체
        }
      }
      lastError = `${p.name} ${res.status} (${p.model}): ${await res.text()}`;
      console.warn(lastError);
      if (res.status !== 429 && res.status < 500) break; // 400·403·404는 재시도해도 같다
    }
  }
  throw new Error(lastError);
}

const coachSchema = z.object({ reply: z.string().min(1), summary: z.string().min(1) });

/** 막힘 입력에 대한 힌트 답장과 팀 리더용 한 줄 요약. 원문은 저장·전달하지 않는다. */
export async function coachBlocked(taskTitle: string, stepTitle: string, detail: string) {
  const json = await chatJson(
    `너는 신입 프론트엔드 개발자를 돕는 다정한 코치다. 담당자가 막힌 상황을 적었다. ` +
      `reply: 3~5문장, 한국어 존댓말. 먼저 짧게 공감하고, 흔한 원인을 1~2개 조심스럽게 짚고, ` +
      `에러 메시지 첫 줄처럼 구체적인 정보를 보내 달라고 한다. 내용이 모호하면 어느 부분에서 막혔는지 되묻는다. ` +
      `확신이 없는 기술 내용은 추측하지 말고 팀 문서나 팀 리더에게 물어보라고 안내한다. ` +
      `마지막 문장은 "내일 오전까지 안 풀리면 팀 리더님께 물어보는 걸 추천해요."로 끝낸다. ` +
      `summary: 팀 리더에게 보여 줄 한 줄 상황 요약(40자 이내, 원문을 그대로 인용하지 않음). ` +
      `JSON만 출력: {"reply": string, "summary": string}`,
    `과제: ${taskTitle}\n지금 단계: ${stepTitle}\n담당자 메시지: ${detail}`,
  );
  return coachSchema.parse(json);
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
