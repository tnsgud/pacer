import { describe, expect, it } from "vitest";

Object.assign(process.env, {
  DISCORD_TOKEN: "x",
  DISCORD_APP_ID: "x",
  DISCORD_GUILD_ID: "x",
  LEADER_ID: "x",
  CF_ACCOUNT_ID: "acc",
  CF_API_TOKEN: "x",
});
delete process.env.GROQ_API_KEY;
const { extractJson, providers } = await import("./ai.js");

describe("extractJson", () => {
  it("코드블록·앞뒤 설명이 붙어도 JSON만 꺼낸다", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":{"b":2}}\n```')).toEqual({ a: { b: 2 } });
    expect(extractJson('결과입니다: {"a":1} 끝')).toEqual({ a: 1 });
  });
  it("JSON이 없으면 에러", () => {
    expect(() => extractJson("죄송합니다")).toThrow();
  });
});

describe("providers", () => {
  it("Groq 키가 없으면 Workers AI만 쓴다", () => {
    const list = providers();
    expect(list.map((p) => p.name)).toEqual(["Workers AI"]);
    expect(list[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/v1/chat/completions");
  });
});
