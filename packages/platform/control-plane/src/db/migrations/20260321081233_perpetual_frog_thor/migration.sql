CREATE TABLE `catalog_tool` (
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
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tool_source` ON `catalog_tool` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_tool_namespace` ON `catalog_tool` (`namespace`);--> statement-breakpoint
CREATE INDEX `idx_tool_path` ON `catalog_tool` (`path`);