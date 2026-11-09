ALTER TABLE `checkins` ADD `leader_seen_at` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `draft_edits` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `tasks` ADD `completed_at` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `risk_warned_at` text;