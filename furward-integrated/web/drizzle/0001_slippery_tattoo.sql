CREATE TABLE `admin_login_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`failures` integer NOT NULL,
	`reset_at` integer NOT NULL
);
