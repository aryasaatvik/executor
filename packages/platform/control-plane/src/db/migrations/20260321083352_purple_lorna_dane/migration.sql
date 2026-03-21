CREATE TABLE `account` (
	`id` text PRIMARY KEY,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`display_name` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
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
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
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
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
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
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_auth_lease_auth_artifact_id_auth_artifact_id_fk` FOREIGN KEY (`auth_artifact_id`) REFERENCES `auth_artifact`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `execution` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`created_by_account_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`code` text NOT NULL,
	`result_json` text,
	`error_text` text,
	`logs_json` text,
	`started_at` integer,
	`completed_at` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
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
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
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
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
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
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
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
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
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
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `policy` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL,
	`workspace_id` text NOT NULL,
	`resource_pattern` text NOT NULL,
	`effect` text NOT NULL,
	`approval_mode` text NOT NULL,
	`priority` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secret_material` (
	`id` text PRIMARY KEY,
	`name` text,
	`purpose` text NOT NULL,
	`provider_id` text NOT NULL,
	`handle` text NOT NULL,
	`value` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_session_source_idx` ON `source_auth_session` (`workspace_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `auth_session_status_idx` ON `source_auth_session` (`status`);--> statement-breakpoint
CREATE INDEX `auth_artifact_source_idx` ON `auth_artifact` (`workspace_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `auth_artifact_slot_idx` ON `auth_artifact` (`workspace_id`,`source_id`,`slot`);--> statement-breakpoint
CREATE INDEX `auth_lease_artifact_idx` ON `auth_lease` (`auth_artifact_id`);--> statement-breakpoint
CREATE INDEX `auth_lease_source_idx` ON `auth_lease` (`workspace_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `execution_workspace_idx` ON `execution` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `execution_status_idx` ON `execution` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `interaction_execution_idx` ON `execution_interaction` (`execution_id`);--> statement-breakpoint
CREATE INDEX `step_execution_idx` ON `execution_step` (`execution_id`);--> statement-breakpoint
CREATE INDEX `step_execution_seq_idx` ON `execution_step` (`execution_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `provider_grant_client_idx` ON `provider_auth_grant` (`oauth_client_id`);--> statement-breakpoint
CREATE INDEX `provider_grant_workspace_idx` ON `provider_auth_grant` (`workspace_id`,`provider_key`);--> statement-breakpoint
CREATE INDEX `source_oauth_client_source_idx` ON `source_oauth_client` (`workspace_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `policy_workspace_idx` ON `policy` (`workspace_id`);