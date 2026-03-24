CREATE TABLE `account` (
	`id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`display_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_auth_session` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`source_id` text NOT NULL,
	`actor_account_id` text,
	`credential_slot` text NOT NULL,
	`execution_id` text,
	`interaction_id` text,
	`provider_kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`state` text NOT NULL,
	`session_data_json` text NOT NULL,
	`error_text` text,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_artifact` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`source_id` text NOT NULL,
	`actor_account_id` text,
	`slot` text NOT NULL,
	`artifact_kind` text NOT NULL,
	`config_json` text NOT NULL,
	`grant_set_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_lease` (
	`id` text PRIMARY KEY,
	`auth_artifact_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`source_id` text NOT NULL,
	`actor_account_id` text,
	`slot` text NOT NULL,
	`placements_template_json` text NOT NULL,
	`expires_at` integer,
	`refresh_after` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_auth_lease_auth_artifact_id_auth_artifact_id_fk` FOREIGN KEY (`auth_artifact_id`) REFERENCES `auth_artifact`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `catalog_document` (
	`id` text PRIMARY KEY,
	`revision_id` text NOT NULL,
	`document_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_catalog_document_revision_id_catalog_revision_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `catalog_revision`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
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
	`capability_json` text,
	`executable_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_catalog_tool_source_id_source_id_fk` FOREIGN KEY (`source_id`) REFERENCES `source`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `execution` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`created_by_account_id` text NOT NULL,
	`execution_session_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`code` text NOT NULL,
	`result_json` text,
	`error_text` text,
	`logs_json` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `execution_interaction` (
	`id` text PRIMARY KEY,
	`execution_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`kind` text NOT NULL,
	`purpose` text NOT NULL,
	`payload_json` text NOT NULL,
	`response_json` text,
	`response_private_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_execution_interaction_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `execution_step` (
	`id` text PRIMARY KEY,
	`execution_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`path` text NOT NULL,
	`args_json` text NOT NULL,
	`result_json` text,
	`error_text` text,
	`interaction_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_execution_step_execution_id_execution_id_fk` FOREIGN KEY (`execution_id`) REFERENCES `execution`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `provider_auth_grant` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`actor_account_id` text,
	`provider_key` text NOT NULL,
	`oauth_client_id` text NOT NULL,
	`token_endpoint` text NOT NULL,
	`client_authentication` text NOT NULL,
	`header_name` text NOT NULL,
	`prefix` text NOT NULL,
	`refresh_token_ref` text NOT NULL,
	`granted_scopes` text NOT NULL,
	`last_refreshed_at` integer,
	`orphaned_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_provider_auth_grant_oauth_client_id_workspace_oauth_client_id_fk` FOREIGN KEY (`oauth_client_id`) REFERENCES `workspace_oauth_client`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `source_oauth_client` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`source_id` text NOT NULL,
	`provider_key` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_provider_id` text,
	`client_secret_handle` text,
	`client_metadata_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_oauth_client` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`provider_key` text NOT NULL,
	`label` text,
	`client_id` text NOT NULL,
	`client_secret_provider_id` text,
	`client_secret_handle` text,
	`client_metadata_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `policy` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL,
	`workspace_id` text NOT NULL,
	`resource_pattern` text NOT NULL,
	`effect` text NOT NULL,
	`approval_mode` text NOT NULL,
	`priority` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secret_material` (
	`id` text PRIMARY KEY,
	`name` text,
	`purpose` text NOT NULL,
	`provider_id` text NOT NULL,
	`handle` text NOT NULL,
	`value` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `catalog` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`adapter_key` text NOT NULL,
	`provider_key` text NOT NULL,
	`name` text NOT NULL,
	`summary` text,
	`visibility` text DEFAULT 'private' NOT NULL,
	`latest_revision_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `catalog_revision` (
	`id` text PRIMARY KEY,
	`catalog_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`source_config_json` text,
	`import_metadata_json` text,
	`import_metadata_hash` text,
	`snapshot_hash` text,
	`snapshot_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_catalog_revision_catalog_id_catalog_id_fk` FOREIGN KEY (`catalog_id`) REFERENCES `catalog`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `source` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`catalog_id` text,
	`catalog_revision_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`source_hash` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_state` (
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`updated_at` integer NOT NULL,
	CONSTRAINT `workspace_state_pk` PRIMARY KEY(`workspace_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `auth_session_source_idx` ON `source_auth_session` (`workspace_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `auth_session_status_idx` ON `source_auth_session` (`status`);--> statement-breakpoint
CREATE INDEX `auth_artifact_source_idx` ON `auth_artifact` (`workspace_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `auth_artifact_slot_idx` ON `auth_artifact` (`workspace_id`,`source_id`,`slot`);--> statement-breakpoint
CREATE INDEX `auth_lease_artifact_idx` ON `auth_lease` (`auth_artifact_id`);--> statement-breakpoint
CREATE INDEX `auth_lease_source_idx` ON `auth_lease` (`workspace_id`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_document_revision_document_idx` ON `catalog_document` (`revision_id`,`document_id`);--> statement-breakpoint
CREATE INDEX `idx_tool_source` ON `catalog_tool` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_tool_namespace` ON `catalog_tool` (`namespace`);--> statement-breakpoint
CREATE INDEX `idx_tool_path` ON `catalog_tool` (`path`);--> statement-breakpoint
CREATE INDEX `execution_workspace_idx` ON `execution` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `execution_status_idx` ON `execution` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `interaction_execution_idx` ON `execution_interaction` (`execution_id`);--> statement-breakpoint
CREATE INDEX `step_execution_idx` ON `execution_step` (`execution_id`);--> statement-breakpoint
CREATE INDEX `step_execution_seq_idx` ON `execution_step` (`execution_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `provider_grant_client_idx` ON `provider_auth_grant` (`oauth_client_id`);--> statement-breakpoint
CREATE INDEX `provider_grant_workspace_idx` ON `provider_auth_grant` (`workspace_id`,`provider_key`);--> statement-breakpoint
CREATE INDEX `source_oauth_client_source_idx` ON `source_oauth_client` (`workspace_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `policy_workspace_idx` ON `policy` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `policy_workspace_slug_idx` ON `policy` (`workspace_id`,`slug`);--> statement-breakpoint
CREATE INDEX `catalog_revision_catalog_idx` ON `catalog_revision` (`catalog_id`);--> statement-breakpoint
CREATE INDEX `source_workspace_idx` ON `source` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `source_status_idx` ON `source` (`workspace_id`,`status`);