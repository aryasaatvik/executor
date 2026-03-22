CREATE TABLE `source_catalog` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`adapter_key` text NOT NULL,
	`provider_key` text NOT NULL,
	`name` text NOT NULL,
	`summary` text,
	`visibility` text DEFAULT 'private' NOT NULL,
	`latest_revision_id` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_catalog_revision` (
	`id` text PRIMARY KEY,
	`catalog_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`source_config_json` text,
	`import_metadata_json` text,
	`import_metadata_hash` text,
	`snapshot_hash` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_source_catalog_revision_catalog_id_source_catalog_id_fk` FOREIGN KEY (`catalog_id`) REFERENCES `source_catalog`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `source` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`catalog_id` text,
	`catalog_revision_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`endpoint` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`namespace` text,
	`icon_url` text,
	`import_auth_policy` text,
	`binding_config_json` text,
	`binding_version` integer,
	`source_hash` text,
	`last_error` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_catalog_tool` (
	`tool_id` text PRIMARY KEY,
	`path` text NOT NULL,
	`source_id` text NOT NULL,
	`source_key` text NOT NULL,
	`namespace` text NOT NULL,
	`title` text,
	`description` text,
	`search_text` text NOT NULL,
	`input_schema_json` text,
	`output_schema_json` text,
	`input_type_preview` text,
	`output_type_preview` text,
	`interaction` text DEFAULT 'auto',
	`provider_kind` text,
	`content_hash` text NOT NULL,
	`source_enabled` integer DEFAULT true NOT NULL,
	`source_status` text DEFAULT 'connected',
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_catalog_tool_source_id_source_id_fk` FOREIGN KEY (`source_id`) REFERENCES `source`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_catalog_tool`(`tool_id`, `path`, `source_id`, `source_key`, `namespace`, `title`, `description`, `search_text`, `input_schema_json`, `output_schema_json`, `input_type_preview`, `output_type_preview`, `interaction`, `provider_kind`, `content_hash`, `source_enabled`, `source_status`, `time_created`, `time_updated`) SELECT `tool_id`, `path`, `source_id`, `source_key`, `namespace`, `title`, `description`, `search_text`, `input_schema_json`, `output_schema_json`, `input_type_preview`, `output_type_preview`, `interaction`, `provider_kind`, `content_hash`, `source_enabled`, `source_status`, `time_created`, `time_updated` FROM `catalog_tool`;--> statement-breakpoint
DROP TABLE `catalog_tool`;--> statement-breakpoint
ALTER TABLE `__new_catalog_tool` RENAME TO `catalog_tool`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_tool_source` ON `catalog_tool` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_tool_namespace` ON `catalog_tool` (`namespace`);--> statement-breakpoint
CREATE INDEX `idx_tool_path` ON `catalog_tool` (`path`);--> statement-breakpoint
CREATE INDEX `catalog_revision_catalog_idx` ON `source_catalog_revision` (`catalog_id`);--> statement-breakpoint
CREATE INDEX `source_workspace_idx` ON `source` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `source_status_idx` ON `source` (`workspace_id`,`status`);