import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

const createdAt = () =>
  text("created_at").notNull().default(sql`(datetime('now'))`);

export const members = sqliteTable("members", {
  id: text("id").primaryKey(), // Discord user ID
  name: text("name").notNull(),
  role: text("role", { enum: ["leader", "member"] }).notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  rawText: text("raw_text").notNull(), // 팀 리더가 쓴 원문 (초안 검증용)
  assigneeId: text("assignee_id").notNull().references(() => members.id),
  dueDate: text("due_date").notNull(), // YYYY-MM-DD
  // 초안일 때만 쓰는 추가 담당자 ID(쉼표 구분). [이대로 전달] 때 사람마다 과제를 복사하고 비운다.
  extraAssigneeIds: text("extra_assignee_ids"),
  status: text("status", { enum: ["draft", "approved", "done"] })
    .notNull()
    .default("draft"),
  createdAt: createdAt(),
});

export const steps = sqliteTable("steps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id").notNull().references(() => tasks.id),
  position: integer("position").notNull(),
  title: text("title").notNull(),
  dueDate: text("due_date").notNull(),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
});

// 원문은 저장하지 않고 상태와 요약만 남긴다.
export const checkins = sqliteTable(
  "checkins",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull().references(() => tasks.id),
    memberId: text("member_id").notNull().references(() => members.id),
    date: text("date").notNull(), // YYYY-MM-DD (KST)
    status: text("status", { enum: ["done", "doing", "blocked"] }).notNull(),
    summary: text("summary"),
    // 담당자가 "팀 리더님께 전달"에 동의했을 때만 true. true일 때만 summary를 리더에게 보여 준다.
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique().on(t.taskId, t.memberId, t.date)],
);
