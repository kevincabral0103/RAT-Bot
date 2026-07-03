require("dotenv").config();

const { Client, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");
const Database = require("better-sqlite3");

// ==========================
// ENV
// ==========================
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

// ==========================
// CONSTANTS
// ==========================
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

// ==========================
// DISCORD CLIENT
// ==========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ==========================
// DATABASE
// ==========================
const db = new Database("rat.sqlite");

db.exec(`
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  log_channel_id TEXT,
  last_weekly_report_at INTEGER,
  alert_channel_id TEXT,
  roster_role_id TEXT,
  threshold_days INTEGER NOT NULL DEFAULT 7,
  min_words INTEGER NOT NULL DEFAULT 50,
  min_chars INTEGER NOT NULL DEFAULT 250,
  min_paragraphs INTEGER NOT NULL DEFAULT 1,
  require_link INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tracked_channels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS last_valid_posts_global (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_post_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS excuses (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  excused_until INTEGER NOT NULL,
  reason TEXT,
  PRIMARY KEY (guild_id, user_id)
);
`);
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();

  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`✅ Added column ${column}`);
  }
}

addColumnIfMissing("guild_config", "log_channel_id", "TEXT");
addColumnIfMissing("guild_config", "last_weekly_report_at", "INTEGER");

const ensureConfig = db.prepare(`
INSERT INTO guild_config (guild_id) VALUES (?)
ON CONFLICT(guild_id) DO NOTHING
`);
const getConfig = db.prepare(`SELECT * FROM guild_config WHERE guild_id = ?`);
const setConfigField = (field) => db.prepare(`UPDATE guild_config SET ${field} = ? WHERE guild_id = ?`);

const addTracked = db.prepare(`INSERT OR IGNORE INTO tracked_channels (guild_id, channel_id) VALUES (?, ?)`);
const removeTracked = db.prepare(`DELETE FROM tracked_channels WHERE guild_id = ? AND channel_id = ?`);
const listTracked = db.prepare(`SELECT channel_id FROM tracked_channels WHERE guild_id = ? ORDER BY channel_id`);
const isTracked = db.prepare(`SELECT 1 FROM tracked_channels WHERE guild_id = ? AND channel_id = ?`);
const countTracked = db.prepare(`SELECT COUNT(*) AS c FROM tracked_channels WHERE guild_id = ?`);

const upsertLastGlobal = db.prepare(`
INSERT INTO last_valid_posts_global (guild_id, user_id, last_post_at)
VALUES (?, ?, ?)
ON CONFLICT(guild_id, user_id)
DO UPDATE SET last_post_at = excluded.last_post_at
`);
const getAllLastGlobal = db.prepare(`SELECT user_id, last_post_at FROM last_valid_posts_global WHERE guild_id = ?`);
const getLastForUser = db.prepare(`SELECT last_post_at FROM last_valid_posts_global WHERE guild_id = ? AND user_id = ?`);
const clearActivityAll = db.prepare(`DELETE FROM last_valid_posts_global WHERE guild_id = ?`);

const upsertExcuse = db.prepare(`
INSERT INTO excuses (guild_id, user_id, excused_until, reason)
VALUES (?, ?, ?, ?)
ON CONFLICT(guild_id, user_id)
DO UPDATE SET excused_until = excluded.excused_until, reason = excluded.reason
`);
const getExcuse = db.prepare(`SELECT excused_until, reason FROM excuses WHERE guild_id = ? AND user_id = ?`);
const deleteExcuse = db.prepare(`DELETE FROM excuses WHERE guild_id = ? AND user_id = ?`);
const deleteExpiredExcuses = db.prepare(`DELETE FROM excuses WHERE guild_id = ? AND excused_until <= ?`);
const listExcused = db.prepare(`
SELECT user_id, excused_until, reason
FROM excuses
WHERE guild_id = ? AND excused_until > ?
ORDER BY excused_until ASC
`);
const clearExcuses = db.prepare(`DELETE FROM excuses WHERE guild_id = ?`);

const clearTrackedChannels = db.prepare(`DELETE FROM tracked_channels WHERE guild_id = ?`);

const resetGuildConfig = db.prepare(`
UPDATE guild_config
SET
  alert_channel_id = NULL,
  roster_role_id = NULL,
  threshold_days = 7,
  min_words = 50,
  min_chars = 250,
  min_paragraphs = 1,
  require_link = 0
WHERE guild_id = ?
`);

// ==========================
// HELPERS
// ==========================
async function sendLog(guild, text) {
  ensureConfig.run(guild.id);
  const cfg = getConfig.get(guild.id);

  if (!cfg.log_channel_id) return;

  const ch = guild.channels.cache.get(cfg.log_channel_id);
  if (!ch || !ch.isTextBased()) return;

  await ch.send(`📝 **RAT Log**\n${text}`);
}

function hasManageGuild(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countParagraphs(text) {
  if (!text || !text.trim()) return 0;
  const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return Math.max(1, parts.length);
}

function hasLink(text) {
  return /(https?:\/\/\S+)/i.test(text);
}

function isValidPost(message, cfg) {
  const content = message.content ?? "";
  const words = countWords(content);
  const paragraphs = countParagraphs(content);
  const attachmentsCount = message.attachments?.size ?? 0;

  if (content.length < cfg.min_chars) return false;
  if (words < cfg.min_words) return false;
  if (paragraphs < cfg.min_paragraphs) return false;

  if (cfg.require_link) {
    if (!hasLink(content) && attachmentsCount === 0) return false;
  }

  return true;
}

function daysBetween(nowMs, pastMs) {
  return Math.floor((nowMs - pastMs) / (1000 * 60 * 60 * 24));
}

function formatDate(ms) {
  return new Date(ms).toLocaleString();
}

function msFromDays(days) {
  return days * 24 * 60 * 60 * 1000;
}

function getRosterRole(guild, cfg) {
  if (!cfg.roster_role_id) return null;
  return guild.roles.cache.get(cfg.roster_role_id) ?? null;
}

// ==========================
// INACTIVITY CHECK
// ==========================
async function postWeeklyReport(guild, manual = false) {
  ensureConfig.run(guild.id);
  const cfg = getConfig.get(guild.id);
  const now = Date.now();

  if (!cfg.alert_channel_id) return { ok: false, reason: "No alerts channel set." };

  const alertsChannel = guild.channels.cache.get(cfg.alert_channel_id);
  if (!alertsChannel || !alertsChannel.isTextBased()) {
    return { ok: false, reason: "Alerts channel missing." };
  }

  await guild.members.fetch();

  const rosterRole = getRosterRole(guild, cfg);
  if (!rosterRole) return { ok: false, reason: "No roster role set." };

  const rows = getAllLastGlobal.all(guild.id);
  const lastMap = new Map(rows.map(r => [r.user_id, r.last_post_at]));

  let active = 0;
  let overdue = 0;
  let never = 0;
  let excused = 0;

  const recentLines = [];

  for (const member of rosterRole.members.values()) {
    if (member.user.bot) continue;

    const excuse = getExcuse.get(guild.id, member.id);
    if (excuse && now < excuse.excused_until) {
      excused++;
      continue;
    }

    const last = lastMap.get(member.id);

    if (!last) {
      never++;
      continue;
    }

    const daysAgo = daysBetween(now, last);

    if (daysAgo <= cfg.threshold_days) active++;
    else overdue++;

    recentLines.push({
      id: member.id,
      daysAgo,
      last
    });
  }

  recentLines.sort((a, b) => a.daysAgo - b.daysAgo);

  const topRecent = recentLines
    .slice(0, 10)
    .map((u, i) => `${i + 1}. <@${u.id}> — **${u.daysAgo} days ago**`)
    .join("\n") || "No recent activity.";

  const report =
    `📊 **RAT Weekly Activity Report**\n\n` +
    `**Roster Role:** ${cfg.roster_role_id ? `<@&${cfg.roster_role_id}>` : "Not set"}\n` +
    `**Threshold:** ${cfg.threshold_days} days\n\n` +
    `**Active:** ${active}\n` +
    `**Overdue:** ${overdue}\n` +
    `**Never Posted:** ${never}\n` +
    `**Excused:** ${excused}\n\n` +
    `🏆 **Most Recent Activity**\n${topRecent}`;

  await alertsChannel.send(report);

  setConfigField("last_weekly_report_at").run(now, guild.id);

  await sendLog(guild, `Weekly report posted${manual ? " manually" : " automatically"}.`);

  return { ok: true, reason: "Weekly report posted." };
}

async function runInactivityCheck(guild) {
  ensureConfig.run(guild.id);
  const cfg = getConfig.get(guild.id);
  const now = Date.now();

  deleteExpiredExcuses.run(guild.id, now);

  if (!cfg.alert_channel_id) return { sent: false, reason: "No alert channel set." };
  const alertsChannel = guild.channels.cache.get(cfg.alert_channel_id);
  if (!alertsChannel || !alertsChannel.isTextBased()) return { sent: false, reason: "Alert channel missing or not text-based." };

  await guild.members.fetch();

  const rosterRole = getRosterRole(guild, cfg);
  if (!rosterRole) {
    await alertsChannel.send(`⚠️ RAT: No roster role set. Use \`/rat set-roster-role\`.`);
    return { sent: true, reason: "Roster role not set." };
  }

  const rows = getAllLastGlobal.all(guild.id);
  const lastMap = new Map(rows.map((r) => [r.user_id, r.last_post_at]));

  const overdue = [];

  for (const member of rosterRole.members.values()) {
    if (member.user.bot) continue;

    const excuse = getExcuse.get(guild.id, member.id);
    if (excuse && now < excuse.excused_until) continue;

    const last = lastMap.get(member.id);
    if (!last) {
      overdue.push(`• <@${member.id}> has **NO valid tracked posts yet** (limit ${cfg.threshold_days} days)`);
      continue;
    }

    const diff = daysBetween(now, last);
    if (diff > cfg.threshold_days) {
      overdue.push(`• <@${member.id}> inactive — **${diff}** days since last valid post (limit ${cfg.threshold_days})`);
    }
  }

  if (overdue.length) {
    await alertsChannel.send(`⏰ **RAT Activity Alert (Global Timer)**\n${overdue.join("\n")}`);
  }

  return { sent: true, reason: overdue.length ? "Alerts sent." : "No overdue players." };
}

// ==========================
// MESSAGE TRACKING (GLOBAL TIMER)
// ==========================
client.on("messageCreate", (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;

  ensureConfig.run(message.guild.id);
  const cfg = getConfig.get(message.guild.id);

  const trackedRow = isTracked.get(message.guild.id, message.channel.id);
  if (!trackedRow) return;

  if (!isValidPost(message, cfg)) return;

  upsertLastGlobal.run(message.guild.id, message.author.id, Date.now());
});

// ==========================
// SLASH COMMANDS
// ==========================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "rat") return;

  // prevent timeouts
  await interaction.deferReply({ ephemeral: true });

  if (!hasManageGuild(interaction)) {
    await interaction.editReply("❌ You need **Manage Server** to use RAT commands.");
    return;
  }

  ensureConfig.run(interaction.guildId);
  const cfg = getConfig.get(interaction.guildId);
  const sub = interaction.options.getSubcommand();
  
  console.log("SUBCOMMAND RECEIVED:", sub);
try {

      if (sub === "set-log-channel") {
     const ch = interaction.options.getChannel("channel", true);
     setConfigField("log_channel_id").run(ch.id, interaction.guildId);

     await sendLog(interaction.guild, `Log channel set to <#${ch.id}> by <@${interaction.user.id}>.`);
      return interaction.editReply(`✅ Logs will be sent to <#${ch.id}>`);
    }
     if (sub === "weekly-report") {
     const res = await postWeeklyReport(interaction.guild, true);
     return interaction.editReply(res.ok ? `✅ ${res.reason}` : `❌ ${res.reason}`);
    }
    // show-config
    if (sub === "show-config") {
      const trackedCount = countTracked.get(interaction.guildId).c;

      const lines = [];
      lines.push(`**Roster role:** ${cfg.roster_role_id ? `<@&${cfg.roster_role_id}>` : "❌ Not set"}`);
      lines.push(`**Alerts channel:** ${cfg.alert_channel_id ? `<#${cfg.alert_channel_id}>` : "❌ Not set"}`);
      lines.push(`**Threshold:** ${cfg.threshold_days} days`);
      lines.push(`**Minimums:** ${cfg.min_words} words • ${cfg.min_chars} chars • ${cfg.min_paragraphs} paragraphs`);
      lines.push(`**Require link/attachment:** ${cfg.require_link ? "ON" : "OFF"}`);
      lines.push(`**Tracked channels:** ${trackedCount} (use /rat list-channels)`);

      return interaction.editReply(`⚙️ **RAT Server Config**\n${lines.join("\n")}`);
    }

    // reset-config
    if (sub === "reset-config") {
      const confirm = interaction.options.getBoolean("confirm", true);
      if (!confirm) {
        return interaction.editReply("❌ Reset cancelled. To reset, run `/rat reset-config confirm:true`.");
      }

      // Ensure config row exists then reset + wipe all server data
      ensureConfig.run(interaction.guildId);

      resetGuildConfig.run(interaction.guildId);
      clearTrackedChannels.run(interaction.guildId);
      clearExcuses.run(interaction.guildId);
      clearActivityAll.run(interaction.guildId);

      return interaction.editReply(
        "✅ **RAT reset complete.**\n" +
        "• Config restored to defaults\n" +
        "• Tracked channels cleared\n" +
        "• Excuses cleared\n" +
        "• Activity history cleared\n\n" +
        "Next steps:\n" +
        "1) `/rat set-roster-role role:@YourRole`\n" +
        "2) `/rat set-alert-channel #your-alerts`\n" +
        "3) `/rat add-channel #news` (repeat for each channel)"
      );
    }

    // set-roster-role
    if (sub === "set-roster-role") {
      const role = interaction.options.getRole("role", true);
      setConfigField("roster_role_id").run(role.id, interaction.guildId);
      return interaction.editReply(`✅ Roster role set to **${role.name}** (${role}).`);
    }

    // add-channel
    if (sub === "add-channel") {
      const ch = interaction.options.getChannel("channel", true);
      addTracked.run(interaction.guildId, ch.id);
      return interaction.editReply(`✅ Now tracking <#${ch.id}>`);
    }

    // remove-channel
    if (sub === "remove-channel") {
      const ch = interaction.options.getChannel("channel", true);
      removeTracked.run(interaction.guildId, ch.id);
      return interaction.editReply(`✅ Removed <#${ch.id}> from tracking`);
    }

    // list-channels
    if (sub === "list-channels") {
      const rows = listTracked.all(interaction.guildId);
      if (!rows.length) return interaction.editReply("No tracked channels yet. Use `/rat add-channel`.");
      return interaction.editReply(`📌 **Tracked Channels**\n${rows.map((r) => `• <#${r.channel_id}>`).join("\n")}`);
    }

    // set-alert-channel
    if (sub === "set-alert-channel") {
      const ch = interaction.options.getChannel("channel", true);
      setConfigField("alert_channel_id").run(ch.id, interaction.guildId);
      return interaction.editReply(`✅ Alerts will be sent to <#${ch.id}>`);
    }

    // set-threshold
    if (sub === "set-threshold") {
      const days = interaction.options.getInteger("days", true);
      setConfigField("threshold_days").run(days, interaction.guildId);
      return interaction.editReply(`✅ Threshold set to **${days} days** (global timer)`);
    }

    // set-min-words
    if (sub === "set-min-words") {
      const words = interaction.options.getInteger("words", true);
      setConfigField("min_words").run(words, interaction.guildId);
      return interaction.editReply(`✅ Minimum words set to **${words}**`);
    }

    // set-min-chars
    if (sub === "set-min-chars") {
      const chars = interaction.options.getInteger("chars", true);
      setConfigField("min_chars").run(chars, interaction.guildId);
      return interaction.editReply(`✅ Minimum characters set to **${chars}**`);
    }

    // set-min-paragraphs
    if (sub === "set-min-paragraphs") {
      const paragraphs = interaction.options.getInteger("paragraphs", true);
      setConfigField("min_paragraphs").run(paragraphs, interaction.guildId);
      return interaction.editReply(`✅ Minimum paragraphs set to **${paragraphs}**`);
    }

    // toggle-require-link
    if (sub === "toggle-require-link") {
      const enabled = interaction.options.getBoolean("enabled", true);
      setConfigField("require_link").run(enabled ? 1 : 0, interaction.guildId);
      return interaction.editReply(`✅ Require link/attachment: **${enabled ? "ON" : "OFF"}**`);
    }

    // leaderboard
    if (sub === "leaderboard") {
      const limit = interaction.options.getInteger("limit") ?? 10;
      const guild = interaction.guild;
      if (!guild) return interaction.editReply("Guild not found.");

      await guild.members.fetch();

      const liveCfg = getConfig.get(guild.id);
      const rosterRole = getRosterRole(guild, liveCfg);
      if (!rosterRole) return interaction.editReply(`⚠️ No roster role set. Use \`/rat set-roster-role\`.`);

      const rows = getAllLastGlobal.all(guild.id);
      const lastMap = new Map(rows.map((r) => [r.user_id, r.last_post_at]));
      const now = Date.now();

      const list = [];
      for (const member of rosterRole.members.values()) {
        if (member.user.bot) continue;
        list.push({ id: member.id, last: lastMap.get(member.id) ?? null });
      }

      list.sort((a, b) => {
        if (a.last === null && b.last === null) return 0;
        if (a.last === null) return 1;
        if (b.last === null) return -1;
        return b.last - a.last;
      });

      const top = list.slice(0, limit);
      const lines = top.map((u, i) => {
        if (u.last === null) return `${i + 1}. <@${u.id}> — **never**`;
        return `${i + 1}. <@${u.id}> — **${daysBetween(now, u.last)} days ago**`;
      });

      return interaction.editReply(`🏆 **RAT Activity Leaderboard (Most Recent)**\n${lines.join("\n")}`);
    }

    // status
    if (sub === "status") {
      const user = interaction.options.getUser("user", true);
      const now = Date.now();
      const liveCfg = getConfig.get(interaction.guildId);

      const lastRow = getLastForUser.get(interaction.guildId, user.id);
      const excuseRow = getExcuse.get(interaction.guildId, user.id);

      const lines = [];
      lines.push(`**Player:** <@${user.id}>`);
      lines.push(`**Threshold:** ${liveCfg.threshold_days} days`);
      lines.push(`**Roster role:** ${liveCfg.roster_role_id ? `<@&${liveCfg.roster_role_id}>` : "❌ Not set"}`);
      lines.push(`**Requirements:** ${liveCfg.min_words} words • ${liveCfg.min_chars} chars • ${liveCfg.min_paragraphs} paragraphs • require link/attachment: ${liveCfg.require_link ? "ON" : "OFF"}`);

      if (excuseRow && now < excuseRow.excused_until) {
        lines.push(`**Excused until:** ${formatDate(excuseRow.excused_until)}${excuseRow.reason ? ` (Reason: ${excuseRow.reason})` : ""}`);
      } else {
        lines.push(`**Excused until:** (not excused)`);
      }

      if (!lastRow) {
        lines.push(`**Last valid tracked post:** never`);
        lines.push(`**Status:** ${excuseRow && now < excuseRow.excused_until ? "Excused" : "Overdue / No posts yet"}`);
      } else {
        const last = lastRow.last_post_at;
        const daysAgo = daysBetween(now, last);
        const remaining = liveCfg.threshold_days - daysAgo;

        lines.push(`**Last valid tracked post:** ${formatDate(last)} (**${daysAgo} days ago**)`);

        if (excuseRow && now < excuseRow.excused_until) {
          lines.push(`**Status:** Excused`);
        } else if (remaining >= 0) {
          lines.push(`**Status:** Active — **${remaining} day(s)** remaining`);
        } else {
          lines.push(`**Status:** Inactive — overdue by **${Math.abs(remaining)} day(s)**`);
        }
      }

      return interaction.editReply(`📄 **RAT Status**\n${lines.join("\n")}`);
    }

    // check
    if (sub === "check") {
      const guild = interaction.guild;
      if (!guild) return interaction.editReply("Guild not found.");
      const res = await runInactivityCheck(guild);
      return interaction.editReply(`✅ Check complete. ${res.reason}`);
    }

    // excuse
    if (sub === "excuse") {
      const user = interaction.options.getUser("user", true);
      const days = interaction.options.getInteger("days", true);
      const reason = interaction.options.getString("reason") ?? null;

      const until = Date.now() + msFromDays(days);
      upsertExcuse.run(interaction.guildId, user.id, until, reason);

      return interaction.editReply(
        `✅ Excused <@${user.id}> until **${formatDate(until)}** (${days} days).` +
        (reason ? `\nReason: ${reason}` : "")
      );
    }

    // unexcuse
    if (sub === "unexcuse") {
      const user = interaction.options.getUser("user", true);
      const before = getExcuse.get(interaction.guildId, user.id);
      if (!before) return interaction.editReply(`ℹ️ <@${user.id}> is not currently excused.`);
      deleteExcuse.run(interaction.guildId, user.id);
      return interaction.editReply(`✅ Removed excuse for <@${user.id}>.`);
    }

    // list-excused
    if (sub === "list-excused") {
      const now = Date.now();
      deleteExpiredExcuses.run(interaction.guildId, now);

      const rows = listExcused.all(interaction.guildId, now);
      if (!rows.length) return interaction.editReply("No one is currently excused.");

      const lines = rows.slice(0, 25).map((r, idx) => {
        const reason = r.reason ? ` — ${r.reason}` : "";
        return `${idx + 1}. <@${r.user_id}> until **${formatDate(r.excused_until)}**${reason}`;
      });

      let msg = `📋 **Currently Excused Players**\n${lines.join("\n")}`;
      if (rows.length > 25) msg += `\n…plus ${rows.length - 25} more.`;

      return interaction.editReply(msg);
    }

    // excuse-role
    if (sub === "excuse-role") {
      const role = interaction.options.getRole("role", true);
      const days = interaction.options.getInteger("days", true);
      const reason = interaction.options.getString("reason") ?? null;

      const guild = interaction.guild;
      if (!guild) return interaction.editReply("Guild not found.");

      await guild.members.fetch();

      const until = Date.now() + msFromDays(days);

      let count = 0;
      for (const member of role.members.values()) {
        if (member.user.bot) continue;
        upsertExcuse.run(interaction.guildId, member.id, until, reason);
        count++;
      }

      return interaction.editReply(
        `✅ Excused **${count}** member(s) with role **${role.name}** until **${formatDate(until)}** (${days} days).` +
        (reason ? `\nReason: ${reason}` : "")
      );
    }

    // clear-excuses
    if (sub === "clear-excuses") {
      clearExcuses.run(interaction.guildId);
      return interaction.editReply("✅ Cleared **all** excuses for this server.");
    }

    return interaction.editReply("Unknown subcommand.");
  } catch (err) {
    console.error(err);
    return interaction.editReply("❌ Something went wrong. Check console logs.");
  }
});

// ==========================
// STARTUP + SCHEDULER
// ==========================
client.once("ready", async () => {
  console.log(`🐀 RAT online as ${client.user.tag}`);

  // Run once on startup (optional), then daily
  for (const guild of client.guilds.cache.values()) {
    try {
      await runInactivityCheck(guild);
    } catch (e) {
      console.error(e);
    }
  }

  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        await runInactivityCheck(guild);
        const cfg = getConfig.get(guild.id);
const now = Date.now();
const weekMs = 7 * 24 * 60 * 60 * 1000;

if (!cfg.last_weekly_report_at || now - cfg.last_weekly_report_at >= weekMs) {
  await postWeeklyReport(guild, false);
}
      } catch (e) {
        console.error(e);
      }
    }
  }, CHECK_INTERVAL_MS);
});

client.login(TOKEN);