require("dotenv").config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env");
  process.exit(1);
}

const rat = new SlashCommandBuilder()
  .setName("rat")
  .setDescription("RAT moderator tools")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

  // Show + reset config
  .addSubcommand(sc =>
    sc.setName("show-config")
      .setDescription("Show current RAT configuration for this server")
  )
  .addSubcommand(sc =>
    sc.setName("reset-config")
      .setDescription("RESET RAT to defaults (clears tracked channels, excuses, and activity data)")
      .addBooleanOption(o =>
        o.setName("confirm")
          .setDescription("Must be TRUE to confirm reset")
          .setRequired(true)
      )
  )

  // Roster role
  .addSubcommand(sc =>
    sc.setName("set-roster-role")
      .setDescription("Set the role RAT uses as the 'tracked players' roster")
      .addRoleOption(o => o.setName("role").setDescription("Roster role").setRequired(true))
  )

  // Channel tracking
  .addSubcommand(sc =>
    sc.setName("add-channel")
      .setDescription("Add a channel for activity tracking")
      .addChannelOption(o => o.setName("channel").setDescription("Channel to track").setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("remove-channel")
      .setDescription("Remove a channel from activity tracking")
      .addChannelOption(o => o.setName("channel").setDescription("Channel to stop tracking").setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("list-channels")
      .setDescription("List tracked channels")
  )

  // Alerts + rules
  .addSubcommand(sc =>
    sc.setName("set-alert-channel")
      .setDescription("Set the channel RAT sends alerts to")
      .addChannelOption(o => o.setName("channel").setDescription("Alerts channel").setRequired(true))
  )
  .addSubcommand(sc =>
  sc.setName("set-log-channel")
    .setDescription("Set the channel RAT sends logs to")
    .addChannelOption(o => o.setName("channel").setDescription("Log channel").setRequired(true))
  )
  .addSubcommand(sc =>
  sc.setName("weekly-report")
    .setDescription("Post a weekly activity report to the alerts channel now")
  )
  .addSubcommand(sc =>
    sc.setName("set-threshold")
      .setDescription("Set inactivity threshold in days (global timer)")
      .addIntegerOption(o => o.setName("days").setDescription("Days").setMinValue(1).setMaxValue(365).setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("set-min-words")
      .setDescription("Set minimum words required for a valid post")
      .addIntegerOption(o => o.setName("words").setDescription("Minimum words").setMinValue(1).setMaxValue(5000).setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("set-min-chars")
      .setDescription("Set minimum characters required for a valid post")
      .addIntegerOption(o => o.setName("chars").setDescription("Minimum characters").setMinValue(1).setMaxValue(20000).setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("set-min-paragraphs")
      .setDescription("Set minimum paragraphs required for a valid post")
      .addIntegerOption(o => o.setName("paragraphs").setDescription("Minimum paragraphs").setMinValue(1).setMaxValue(20).setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("toggle-require-link")
      .setDescription("Require a link OR attachment for posts to count")
      .addBooleanOption(o => o.setName("enabled").setDescription("True/False").setRequired(true))
  )

  // Checks + views
  .addSubcommand(sc =>
    sc.setName("leaderboard")
      .setDescription("Show most recently active players (global timer)")
      .addIntegerOption(o => o.setName("limit").setDescription("How many to show (default 10)").setMinValue(1).setMaxValue(25).setRequired(false))
  )
  .addSubcommand(sc =>
    sc.setName("status")
      .setDescription("View a player's activity status (last post, days remaining, excuses)")
      .addUserOption(o => o.setName("user").setDescription("Player").setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("check")
      .setDescription("Run an inactivity check now")
  )

  // Excuses
  .addSubcommand(sc =>
    sc.setName("excuse")
      .setDescription("Excuse a player from inactivity checks for X days")
      .addUserOption(o => o.setName("user").setDescription("Player to excuse").setRequired(true))
      .addIntegerOption(o => o.setName("days").setDescription("How many days").setMinValue(1).setMaxValue(365).setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Optional reason").setRequired(false))
  )
  .addSubcommand(sc =>
    sc.setName("unexcuse")
      .setDescription("Remove a player's excuse early")
      .addUserOption(o => o.setName("user").setDescription("Player").setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName("list-excused")
      .setDescription("List currently excused players")
  )
  .addSubcommand(sc =>
    sc.setName("excuse-role")
      .setDescription("Excuse everyone with a role for X days")
      .addRoleOption(o => o.setName("role").setDescription("Role to excuse").setRequired(true))
      .addIntegerOption(o => o.setName("days").setDescription("How many days").setMinValue(1).setMaxValue(365).setRequired(true))
      .addStringOption(o => o.setName("reason").setDescription("Optional reason").setRequired(false))
  )
  .addSubcommand(sc =>
    sc.setName("clear-excuses")
      .setDescription("Clear ALL excuses for this server")
  );

const commands = [rat.toJSON()];
const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();