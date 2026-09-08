CREATE TABLE `recorded_exercise_index` (
	`sessionId` text NOT NULL,
	`exerciseIndex` integer NOT NULL,
	`movementKey` text NOT NULL,
	`progressionKey` text NOT NULL,
	`latestTime` real NOT NULL,
	PRIMARY KEY(`sessionId`, `exerciseIndex`),
	FOREIGN KEY (`sessionId`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `exercise_progression_time_index` ON `recorded_exercise_index` (`progressionKey`,"latestTime" DESC,`sessionId`,`exerciseIndex`);--> statement-breakpoint
CREATE INDEX `exercise_movement_time_index` ON `recorded_exercise_index` (`movementKey`,"latestTime" DESC,`sessionId`,`exerciseIndex`);--> statement-breakpoint
ALTER TABLE `session` ADD `date` text;--> statement-breakpoint
ALTER TABLE `session` ADD `referenceTime` real;--> statement-breakpoint
ALTER TABLE `session` ADD `workoutName` text;--> statement-breakpoint
ALTER TABLE `session` ADD `searchVersion` integer;--> statement-breakpoint
ALTER TABLE `session` ADD `activity` text;--> statement-breakpoint
CREATE INDEX `session_date_index` ON `session` (`date`);--> statement-breakpoint
CREATE INDEX `session_reference_time_index` ON `session` ("referenceTime" DESC,`id`);--> statement-breakpoint
CREATE INDEX `session_workout_name_index` ON `session` (`workoutName`,`referenceTime`);--> statement-breakpoint
CREATE INDEX `session_search_version_index` ON `session` (`searchVersion`);