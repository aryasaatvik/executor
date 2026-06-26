CREATE TABLE "tool_schema_manifest" (
	"integration" varchar(255) NOT NULL,
	"connection" varchar(255) NOT NULL,
	"plugin_id" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"path" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"descriptor_hash" text NOT NULL,
	"input_schema_hash" text NOT NULL,
	"output_schema_hash" text NOT NULL,
	"definition_set_hash" text NOT NULL,
	"index_fingerprint" text NOT NULL,
	"fingerprint_version" text NOT NULL,
	"source_revision" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"subject" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_schema_manifest_uidx" ON "tool_schema_manifest" USING btree ("tenant","owner","subject","integration","connection","name");