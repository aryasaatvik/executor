-- Custom SQL migration file, put your code below! --
ALTER TABLE `catalog_tool` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `catalog_tool` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `source` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `source` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `source_catalog` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `source_catalog` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `source_catalog_revision` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `source_catalog_revision` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `account` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `account` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `auth_artifact` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `auth_artifact` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `auth_lease` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `auth_lease` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `source_oauth_client` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `source_oauth_client` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `workspace_oauth_client` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `workspace_oauth_client` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `provider_auth_grant` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `provider_auth_grant` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `source_auth_session` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `source_auth_session` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `execution` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `execution` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `execution_interaction` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `execution_interaction` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `execution_step` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `execution_step` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `secret_material` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `secret_material` RENAME COLUMN `time_updated` TO `updated_at`;
--> statement-breakpoint
ALTER TABLE `policy` RENAME COLUMN `time_created` TO `created_at`;
--> statement-breakpoint
ALTER TABLE `policy` RENAME COLUMN `time_updated` TO `updated_at`;
