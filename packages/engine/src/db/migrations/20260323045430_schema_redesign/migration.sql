-- Schema redesign: rename tables, add columns, create new tables
-- See .scratchpad/research/sqlite-schema-redesign.md for full spec

-- Rename source_catalog → catalog
ALTER TABLE `source_catalog` RENAME TO `catalog`;--> statement-breakpoint

-- Rename source_catalog_revision → catalog_revision
ALTER TABLE `source_catalog_revision` RENAME TO `catalog_revision`;--> statement-breakpoint

-- Add snapshot_json column to catalog_revision (nullable for migration)
ALTER TABLE `catalog_revision` ADD COLUMN `snapshot_json` text;--> statement-breakpoint

-- Add capability_json and executable_json columns to catalog_tool (nullable for migration)
ALTER TABLE `catalog_tool` ADD COLUMN `capability_json` text;--> statement-breakpoint
ALTER TABLE `catalog_tool` ADD COLUMN `executable_json` text;--> statement-breakpoint

-- Create catalog_document table
CREATE TABLE `catalog_document` (
	`id` text PRIMARY KEY,
	`revision_id` text NOT NULL,
	`document_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_catalog_document_revision_id_catalog_revision_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `catalog_revision`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_document_revision_document_idx` ON `catalog_document` (`revision_id`,`document_id`);--> statement-breakpoint

-- Create workspace_state table
CREATE TABLE `workspace_state` (
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `key`)
);
