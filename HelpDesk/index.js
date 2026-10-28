
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  UserSelectMenuBuilder,
} = require("discord.js");

// ============================================================
// HELPDESK
// Support made simple.
// Components V2 ticket system
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID || null;

if (!TOKEN || !CLIENT_ID) {
  throw new Error(
    "Please configure DISCORD_TOKEN and DISCORD_CLIENT_ID."
  );
}

const DEFAULT_COLOUR = 0x1c1c1c;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "helpdesk.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

const initialData = {
  guilds: {},
  tickets: {},
  blacklists: {},
};

let db;

try {
  db = fs.existsSync(DATA_FILE)
    ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
    : structuredClone(initialData);
} catch {
  throw new Error(
    "Could not read data/helpdesk.json. Check the file contents."
  );
}

db.guilds ||= {};
db.tickets ||= {};
db.blacklists ||= {};

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function configFor(guildId) {
  db.guilds[guildId] ||= {
    staffRole: null,
    category: null,
    logChannel: null,
    ticketLimit: 1,
    autoCloseMinutes: 0,
    language: "en",
    panelTitle: "HelpDesk Support",
    panelDescription:
      "Need help? Open a ticket and our support team will assist you.",
    panelButton: "Open a Ticket",
    welcomeMessage:
      "Thank you for contacting support. A member of our team will be with you shortly.",
    panelColour: DEFAULT_COLOUR,
    panelChannel: null,
    panelMessage: null,
    supportRoles: [],
    admins: [],
    blacklisted: [],
    panels: {},
    premium: false,
  };

  const config = db.guilds[guildId];
  config.supportRoles ||= [];
  config.admins ||= [];
  config.blacklisted ||= [];
  config.panels ||= {};

  return config;
}

function isAdmin(member, config) {
  return Boolean(
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
      config.admins.includes(member?.id) ||
      member?.roles?.cache?.some((role) =>
        config.admins.includes(role.id)
      )
  );
}

function isSupport(member, config) {
  if (!member) return false;

  return Boolean(
    isAdmin(member, config) ||
      (config.staffRole &&
        member.roles.cache.has(config.staffRole)) ||
      config.supportRoles.some((roleId) =>
        member.roles.cache.has(roleId)
      )
  );
}

function isBlacklisted(guildId, userId) {
  return configFor(guildId).blacklisted.includes(userId);
}

function container(config, ...components) {
  const result = new ContainerBuilder().setAccentColor(
    config?.panelColour ?? DEFAULT_COLOUR
  );

  for (const component of components) {
    result.addTextDisplayComponents(component);
  }

  return result;
}

function text(content) {
  return new TextDisplayBuilder().setContent(content);
}

function row(...components) {
  return new ActionRowBuilder().addComponents(...components);
}

function btn(label, customId, style = ButtonStyle.Secondary) {
  return new ButtonBuilder()
    .setLabel(label)
    .setCustomId(customId)
    .setStyle(style);
}

function privateReply(interaction, content, config) {
  return interaction.reply({
    components: [container(config, text(content))],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  });
}

function privateUpdate(interaction, content, config) {
  return interaction.update({
    components: [container(config, text(content))],
    flags: MessageFlags.IsComponentsV2,
  });
}

function ticketFor(channelId) {
  return db.tickets[channelId] || null;
}

function openTicket(ticket) {
  return ticket?.status === "open";
}

async function sendLog(guild, config, message) {
  if (!config.logChannel) return;

  const channel = guild.channels.cache.get(config.logChannel);
  if (!channel?.isTextBased()) return;

  await channel.send({
    components: [container(config, text(`## HelpDesk Log\n${message}`))],
    flags: MessageFlags.IsComponentsV2,
  }).catch(() => {});
}

async function sendTicketMessage(channel, ticket, config) {
  const claimed = ticket.claimedBy
    ? `<@${ticket.claimedBy}>`
    : "Unclaimed";

  const content = [
    "## HelpDesk Ticket",
    `**Opened by:** <@${ticket.owner}>`,
    `**Status:** ${ticket.status === "open" ? "Open" : "Closed"}`,
    `**Assigned staff:** ${claimed}`,
    "",
    config.welcomeMessage,
  ].join("\n");

  const components = [
    container(config, text(content)),
    row(
      btn(
        ticket.claimedBy ? "Unclaim" : "Claim",
        "ticket_claim",
        ButtonStyle.Secondary
      ),
      btn(
        "Add Member",
        "ticket_add",
        ButtonStyle.Secondary
      ),
      btn(
        "Close",
        "ticket_close",
        ButtonStyle.Danger
      )
    ),
  ];

  const message = await channel.send({
    components,
    flags: MessageFlags.IsComponentsV2,
  });

  ticket.message = message.id;
  save();
}

async function createTicket(guild, user, config, panelName = "Support") {
  const existing = Object.entries(db.tickets).filter(
    ([, ticket]) =>
      ticket.guild === guild.id &&
      ticket.owner === user.id &&
      ticket.status === "open"
  );

  if (existing.length >= config.ticketLimit) {
    return {
      error: `You have reached the limit of ${config.ticketLimit} open ticket(s).`,
    };
  }

  const category = config.category
    ? guild.channels.cache.get(config.category)
    : null;

  const permissions = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];

  if (config.staffRole) {
    permissions.push({
      id: config.staffRole,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  for (const roleId of config.supportRoles) {
    permissions.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  const channel = await guild.channels.create({
    name: `ticket-${user.username}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 90),
    type: ChannelType.GuildText,
    parent:
      category?.type === ChannelType.GuildCategory
        ? category.id
        : undefined,
    permissionOverwrites: permissions,
    topic: `HelpDesk support conversation for ${user.username}`,
    reason: "HelpDesk ticket created",
  });

  db.tickets[channel.id] = {
    guild: guild.id,
    owner: user.id,
    status: "open",
    claimedBy: null,
    panel: panelName,
    createdAt: Date.now(),
    message: null,
    transcript: [],
  };

  save();

  const staffPing = config.staffRole
    ? `<@&${config.staffRole}>`
    : "";

  if (staffPing) {
    await channel.send({
      content: staffPing,
      allowedMentions: { roles: [config.staffRole] },
    });
  }

  await sendTicketMessage(channel, db.tickets[channel.id], config);

  await sendLog(
    guild,
    config,
    `A ticket was opened by <@${user.id}> in ${channel}.`
  );

  return { channel };
}

async function getTicket(interaction) {
  const ticket = ticketFor(interaction.channelId);

  if (!ticket || ticket.guild !== interaction.guildId) {
    await privateReply(
      interaction,
      "This channel is not a HelpDesk ticket.",
      configFor(interaction.guildId)
    );
    return null;
  }

  return ticket;
}

async function refreshTicket(interaction, ticket, config) {
  const channel = interaction.channel;
  if (!channel) return;

  const message = ticket.message
    ? await channel.messages.fetch(ticket.message).catch(() => null)
    : null;

  if (!message) return;

  const claimed = ticket.claimedBy
    ? `<@${ticket.claimedBy}>`
    : "Unclaimed";

  const components = [
    container(
      config,
      text(
        [
          "## HelpDesk Ticket",
          `**Opened by:** <@${ticket.owner}>`,
          `**Status:** ${ticket.status === "open" ? "Open" : "Closed"}`,
          `**Assigned staff:** ${claimed}`,
          "",
          config.welcomeMessage,
        ].join("\n")
      )
    ),
  ];

  if (ticket.status === "open") {
    components.push(
      row(
        btn(
          ticket.claimedBy ? "Unclaim" : "Claim",
          "ticket_claim",
          ButtonStyle.Secondary
        ),
        btn("Add Member", "ticket_add", ButtonStyle.Secondary),
        btn("Close", "ticket_close", ButtonStyle.Danger)
      )
    );
  } else {
    components.push(
      row(btn("Reopen", "ticket_reopen", ButtonStyle.Success))
    );
  }

  await message.edit({
    components,
    flags: MessageFlags.IsComponentsV2,
  }).catch(() => {});
}

// ============================================================
// SLASH COMMANDS
// ============================================================

const commands = [];

const helpdesk = new SlashCommandBuilder()
  .setName("helpdesk")
  .setDescription("HelpDesk support system");

helpdesk.addSubcommand((sub) =>
  sub.setName("help").setDescription("View HelpDesk commands")
);

helpdesk.addSubcommand((sub) =>
  sub.setName("about").setDescription("About HelpDesk")
);

helpdesk.addSubcommand((sub) =>
  sub.setName("ping").setDescription("Check bot latency")
);

helpdesk.addSubcommand((sub) =>
  sub.setName("setup").setDescription("Set up HelpDesk")
);

helpdesk.addSubcommand((sub) =>
  sub.setName("config").setDescription("Configure HelpDesk")
);

helpdesk.addSubcommand((sub) =>
  sub.setName("panel")
    .setDescription("Post the ticket panel")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel where the panel will be posted")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
);

helpdesk.addSubcommand((sub) =>
  sub.setName("adds​​upport".replace(/\u200b/g, ""))
    .setDescription("Add a support role")
    .addRoleOption((option) =>
      option.setName("role").setDescription("Support role").setRequired(true)
    )
);

helpdesk.addSubcommand((sub) =>
  sub.setName("removesupport")
    .setDescription("Remove a support role")
    .addRoleOption((option) =>
      option.setName("role").setDescription("Support role").setRequired(true)
    )
);

helpdesk.addSubcommand((sub) =>
  sub.setName("addadmin")
    .setDescription("Grant HelpDesk admin privileges")
    .addUserOption((option) =>
      option.setName("user").setDescription("Member").setRequired(true)
    )
);

helpdesk.addSubcommand((sub) =>
  sub.setName("removeadmin")
    .setDescription("Revoke HelpDesk admin privileges")
    .addUserOption((option) =>
      option.setName("user").setDescription("Member").setRequired(true)
    )
);

helpdesk.addSubcommand((sub) =>
  sub.setName("viewstaff").setDescription("List support staff and roles")
);

helpdesk.addSubcommand((sub) =>
  sub.setName("blacklist")
    .setDescription("Toggle a member's access to HelpDesk")
    .addUserOption((option) =>
      option.setName("user").setDescription("Member").setRequired(true)
    )
);

helpdesk.addSubcommand((sub) =>
  sub.setName("autoclose")
    .setDescription("Configure automatic ticket closure")
    .addIntegerOption((option) =>
      option
        .setName("minutes")
        .setDescription("Minutes of inactivity; 0 disables it")
        .setMinValue(0)
        .setMaxValue(10080)
        .setRequired(true)
    )
);

helpdesk.addSubcommand((sub) =>
  sub.setName("language")
    .setDescription("Set HelpDesk's language")
    .addStringOption((option) =>
      option
        .setName("language")
        .setDescription("Language")
        .addChoices(
          { name: "English", value: "en" },
          { name: "Spanish", value: "es" },
          { name: "French", value: "fr" }
        )
        .setRequired(true)
    )
);

helpdesk.addSubcommand((sub) =>
  sub.setName("premium").setDescription("Check premium activation")
);

commands.push(helpdesk);

const ticket = new SlashCommandBuilder()
  .setName("ticket")
  .setDescription("Manage support tickets");

ticket.addSubcommand((sub) =>
  sub.setName("open").setDescription("Open a support ticket")
);

ticket.addSubcommand((sub) =>
  sub.setName("close").setDescription("Close this ticket")
);

ticket.addSubcommand((sub) =>
  sub.setName("closerequest").setDescription("Request ticket closure")
);

ticket.addSubcommand((sub) =>
  sub.setName("reopen").setDescription("Reopen a closed ticket")
);

ticket.addSubcommand((sub) =>
  sub.setName("claim").setDescription("Claim this ticket")
);

ticket.addSubcommand((sub) =>
  sub.setName("unclaim").setDescription("Unclaim this ticket")
);

ticket.addSubcommand((sub) =>
  sub.setName("add")
    .setDescription("Add a member to this ticket")
    .addUserOption((option) =>
      option.setName("user").setDescription("Member").setRequired(true)
    )
);

ticket.addSubcommand((sub) =>
  sub.setName("remove")
    .setDescription("Remove a member from this ticket")
    .addUserOption((option) =>
      option.setName("user").setDescription("Member").setRequired(true)
    )
);

ticket.addSubcommand((sub) =>
  sub.setName("rename")
    .setDescription("Rename this ticket")
    .addStringOption((option) =>
      option.setName("name").setDescription("New channel name").setRequired(true)
    )
);

ticket.addSubcommand((sub) =>
  sub.setName("transfer")
    .setDescription("Transfer a claimed ticket")
    .addUserOption((option) =>
      option.setName("user").setDescription("New assigned staff member").setRequired(true)
    )
);

ticket.addSubcommand((sub) =>
  sub.setName("edit").setDescription("Edit this ticket's settings")
);

ticket.addSubcommand((sub) =>
  sub.setName("notes").setDescription("Create a private staff discussion")
);

ticket.addSubcommand((sub) =>
  sub.setName("switchpanel")
    .setDescription("Switch the ticket's support team")
    .addRoleOption((option) =>
      option.setName("role").setDescription("New support role").setRequired(true)
    )
);

ticket.addSubcommand((sub) =>
  sub.setName("transcript").setDescription("Generate a text transcript")
);

commands.push(ticket);

// ============================================================
// REGISTER COMMANDS
// ============================================================

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);

  await rest.put(route, { body: commands.map((command) => command.toJSON()) });
  console.log("HelpDesk slash commands registered.");
}

// ============================================================
// BOT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("ready", () => {
  console.log(`HelpDesk is online as ${client.user.tag}.`);
});

// ============================================================
// INTERACTIONS
// ============================================================

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.guild) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: "Please use HelpDesk inside a server.",
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      return;
    }

    const config = configFor(interaction.guildId);

    if (interaction.isChatInputCommand()) {
      if (isBlacklisted(interaction.guildId, interaction.user.id)) {
        return privateReply(
          interaction,
          "You cannot use HelpDesk in this server.",
          config
        );
      }

      const command = interaction.commandName;
      const sub = interaction.options.getSubcommand();

      // --------------------------------------------------------
      // GENERAL HELPDESK COMMANDS
      // --------------------------------------------------------

      if (command === "helpdesk") {
        if (sub === "ping") {
          return privateReply(
            interaction,
            `## HelpDesk\nPong! Latency: ${client.ws.ping} ms.`,
            config
          );
        }

        if (sub === "about") {
          return privateReply(
            interaction,
            "## HelpDesk\nSupport made simple. A Components V2 ticket system for Discord communities.",
            config
          );
        }

        if (sub === "help") {
          return privateReply(
            interaction,
            [
              "## HelpDesk Commands",
              "`/helpdesk setup` — initial setup",
              "`/helpdesk config` — configuration panel",
              "`/helpdesk panel` — post a ticket panel",
              "`/ticket open` — open a ticket",
              "`/ticket claim` — claim a ticket",
              "`/ticket close` — close a ticket",
              "`/ticket reopen` — reopen a ticket",
              "`/ticket add` and `/ticket remove` — manage members",
              "`/ticket transcript` — create a transcript",
            ].join("\n"),
            config
          );
        }

        if (sub === "premium") {
          return privateReply(
            interaction,
            "## HelpDesk Premium\nPremium activation is not connected to a payment provider yet.",
            config
          );
        }

        if (sub === "setup") {
          if (!isAdmin(interaction.member, config)) {
            return privateReply(interaction, "Only server administrators can set up HelpDesk.", config);
          }

          return privateReply(
            interaction,
            "## Welcome to HelpDesk\nUse `/helpdesk config` to configure your support role, category, logs and panel text. Then use `/helpdesk panel` to post your ticket panel.",
            config
          );
        }

        if (sub === "config") {
          if (!isAdmin(interaction.member, config)) {
            return privateReply(interaction, "Only server administrators can configure HelpDesk.", config);
          }

          return interaction.reply({
            components: [
              container(
                config,
                text(
                  [
                    "## HelpDesk Config",
                    "Configure the ticket system for this server.",
                    "",
                    `**Support role:** ${config.staffRole ? `<@&${config.staffRole}>` : "Not set"}`,
                    `**Ticket category:** ${config.category ? `<#${config.category}>` : "Not set"}`,
                    `**Log channel:** ${config.logChannel ? `<#${config.logChannel}>` : "Not set"}`,
                    `**Open ticket limit:** ${config.ticketLimit}`,
                    "",
                    "Choose a setting below to update it.",
                  ].join("\n")
                ),
                text("**Panel content**\nEdit the title, description, button text and welcome message.")
              ),
              row(
                btn("Panel Text", "config_text", ButtonStyle.Primary),
                btn("Support Role", "config_role"),
                btn("Category", "config_category")
              ),
              row(
                btn("Log Channel", "config_logs"),
                btn("Ticket Limit", "config_limit"),
                btn("Reset", "config_reset", ButtonStyle.Danger)
              ),
            ],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          });
        }

        if (!isAdmin(interaction.member, config)) {
          return privateReply(interaction, "Only server administrators can change these settings.", config);
        }

        if (sub === "panel") {
          const channel = interaction.options.getChannel("channel", true);

          const panel = container(
            config,
            text(
              [
                `## ${config.panelTitle}`,
                config.panelDescription,
              ].join("\n")
            )
          );

          const message = await channel.send({
            components: [
              panel,
              row(
                btn(config.panelButton, "open_ticket", ButtonStyle.Primary)
              ),
            ],
            flags: MessageFlags.IsComponentsV2,
          });

          config.panelChannel = channel.id;
          config.panelMessage = message.id;
          save();

          return privateReply(interaction, "Your ticket panel has been posted.", config);
        }

        if (sub === "addsupport") {
          const role = interaction.options.getRole("role", true);

          if (!config.supportRoles.includes(role.id)) {
            config.supportRoles.push(role.id);
          }

          save();
          return privateReply(interaction, "The support role has been added.", config);
        }

        if (sub === "removesupport") {
          const role = interaction.options.getRole("role", true);
          config.supportRoles = config.supportRoles.filter((id) => id !== role.id);
          save();

          return privateReply(interaction, "The support role has been removed.", config);
        }

        if (sub === "addadmin") {
          const user = interaction.options.getUser("user", true);
          if (!config.admins.includes(user.id)) config.admins.push(user.id);
          save();

          return privateReply(interaction, "HelpDesk administrator access has been granted.", config);
        }

        if (sub === "removeadmin") {
          const user = interaction.options.getUser("user", true);
          config.admins = config.admins.filter((id) => id !== user.id);
          save();

          return privateReply(interaction, "HelpDesk administrator access has been revoked.", config);
        }

        if (sub === "viewstaff") {
          const roles = [...new Set([
            ...(config.staffRole ? [config.staffRole] : []),
            ...config.supportRoles,
          ])];

          return privateReply(
            interaction,
            `## HelpDesk Support Staff\n${roles.length ? roles.map((id) => `<@&${id}>`).join("\n") : "No support roles have been configured."}`,
            config
          );
        }

        if (sub === "blacklist") {
          const user = interaction.options.getUser("user", true);

          if (config.blacklisted.includes(user.id)) {
            config.blacklisted = config.blacklisted.filter((id) => id !== user.id);
          } else {
            config.blacklisted.push(user.id);
          }

          save();
          return privateReply(interaction, "The member's HelpDesk access setting has been updated.", config);
        }

        if (sub === "autoclose") {
          config.autoCloseMinutes = interaction.options.getInteger("minutes", true);
          save();

          return privateReply(
            interaction,
            config.autoCloseMinutes
              ? `Automatic closure is configured for ${config.autoCloseMinutes} minutes of inactivity. A background scheduler still needs to be added to enforce it.`
              : "Automatic closure has been disabled.",
            config
          );
        }

        if (sub === "language") {
          config.language = interaction.options.getString("language", true);
          save();

          return privateReply(interaction, "The language preference has been saved. Translations need to be added before other languages take effect.", config);
        }
      }

      // --------------------------------------------------------
      // TICKET COMMANDS
      // --------------------------------------------------------

      if (command === "ticket") {
        if (sub === "open") {
          const result = await createTicket(
            interaction.guild,
            interaction.user,
            config
          );

          if (result.error) {
            return privateReply(interaction, result.error, config);
          }

          return privateReply(
            interaction,
            `Your ticket has been created: ${result.channel}`,
            config
          );
        }

        const current = await getTicket(interaction);
        if (!current) return;

        if (sub === "claim" || sub === "unclaim") {
          if (!isSupport(interaction.member, config)) {
            return privateReply(interaction, "Only support staff can manage ticket assignments.", config);
          }

          if (!openTicket(current)) {
            return privateReply(interaction, "This ticket is closed.", config);
          }

          if (sub === "claim") {
            if (current.claimedBy && current.claimedBy !== interaction.user.id) {
              return privateReply(interaction, "This ticket is already claimed by another staff member.", config);
            }

            current.claimedBy = interaction.user.id;
          } else {
            if (current.claimedBy && current.claimedBy !== interaction.user.id && !isAdmin(interaction.member, config)) {
              return privateReply(interaction, "Only the assigned staff member or an administrator can unclaim this ticket.", config);
            }

            current.claimedBy = null;
          }

          save();
          await refreshTicket(interaction, current, config);

          return privateReply(
            interaction,
            sub === "claim" ? "You have claimed this ticket." : "The ticket is now unclaimed.",
            config
          );
        }

        if (sub === "close" || sub === "closerequest") {
          if (!ticketCanBeManaged(interaction, current, config)) {
            return privateReply(interaction, "You do not have permission to close this ticket.", config);
          }

          if (!openTicket(current)) {
            return privateReply(interaction, "This ticket is already closed.", config);
          }

          if (sub === "closerequest") {
            await interaction.channel.send({
              components: [
                container(
                  config,
                  text("## Close Ticket?\nPlease confirm whether this ticket can be closed."),
                  text("Close the ticket only if the support request has been resolved.")
                ),
                row(
                  btn("Confirm Close", "ticket_close", ButtonStyle.Danger),
                  btn("Keep Open", "ticket_keepopen", ButtonStyle.Secondary)
                ),
              ],
              flags: MessageFlags.IsComponentsV2,
            });

            return privateReply(interaction, "A closure confirmation has been posted in this ticket.", config);
          }

          current.status = "closed";
          current.closedAt = Date.now();
          save();

          await interaction.channel.permissionOverwrites.edit(current.owner, {
            SendMessages: false,
            ViewChannel: true,
          }).catch(() => {});

          await refreshTicket(interaction, current, config);
          await sendLog(interaction.guild, config, `A ticket was closed by <@${interaction.user.id}>.`);

          return privateReply(interaction, "The ticket has been closed.", config);
        }

        if (sub === "reopen") {
          if (!ticketCanBeManaged(interaction, current, config)) {
            return privateReply(interaction, "You do not have permission to reopen this ticket.", config);
          }

          if (openTicket(current)) {
            return privateReply(interaction, "This ticket is already open.", config);
          }

          current.status = "open";
          current.reopenedAt = Date.now();
          save();

          await interaction.channel.permissionOverwrites.edit(current.owner, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          }).catch(() => {});

          await refreshTicket(interaction, current, config);
          return privateReply(interaction, "The ticket has been reopened.", config);
        }

        if (sub === "add" || sub === "remove") {
          if (!isSupport(interaction.member, config)) {
            return privateReply(interaction, "Only support staff can change ticket participants.", config);
          }

          const user = interaction.options.getUser("user", true);

          if (sub === "add") {
            await interaction.channel.permissionOverwrites.edit(user.id, {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true,
              AttachFiles: true,
            });
          } else {
            if (user.id === current.owner) {
              return privateReply(interaction, "The ticket opener cannot be removed from their own ticket.", config);
            }

            await interaction.channel.permissionOverwrites.delete(user.id).catch(() => {});
          }

          return privateReply(
            interaction,
            sub === "add" ? "The member has been added to this ticket." : "The member has been removed from this ticket.",
            config
          );
        }

        if (sub === "rename") {
          if (!isSupport(interaction.member, config)) {
            return privateReply(interaction, "Only support staff can rename tickets.", config);
          }

          const name = interaction.options.getString("name", true)
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-")
            .slice(0, 90);

          await interaction.channel.setName(name);
          return privateReply(interaction, "The ticket channel has been renamed.", config);
        }

        if (sub === "transfer") {
          if (!isSupport(interaction.member, config)) {
            return privateReply(interaction, "Only support staff can transfer tickets.", config);
          }

          const user = interaction.options.getUser("user", true);
          const member = await interaction.guild.members.fetch(user.id).catch(() => null);

          if (!member || !isSupport(member, config)) {
            return privateReply(interaction, "The selected member must be part of the support team.", config);
          }

          current.claimedBy = user.id;
          save();
          await refreshTicket(interaction, current, config);

          return privateReply(interaction, "The ticket has been transferred.", config);
        }

        if (sub === "edit") {
          if (!isSupport(interaction.member, config)) {
            return privateReply(interaction, "Only support staff can edit tickets.", config);
          }

          const modal = new ModalBuilder()
            .setCustomId("ticket_edit_modal")
            .setTitle("Edit Ticket");

          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("ticket_welcome")
                .setLabel("Ticket welcome message")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(1000)
                .setValue(config.welcomeMessage)
            )
          );

          return interaction.showModal(modal);
        }

        if (sub === "notes") {
          if (!isSupport(interaction.member, config)) {
            return privateReply(interaction, "Only support staff can create staff notes.", config);
          }

          const thread = await interaction.channel.threads.create({
            name: "Staff Discussion",
            autoArchiveDuration: 1440,
            reason: "HelpDesk private staff discussion",
            type: ChannelType.PrivateThread,
          }).catch(() => null);

          if (!thread) {
            return privateReply(interaction, "A private staff thread could not be created. Check the bot's thread permissions.", config);
          }

          await thread.members.add(interaction.user.id).catch(() => {});

          if (config.staffRole) {
            const staff = await interaction.guild.members.fetch({
              force: false,
            }).catch(() => null);

            if (staff) {
              for (const member of staff.values()) {
                if (member.roles.cache.has(config.staffRole)) {
                  await thread.members.add(member.id).catch(() => {});
                }
              }
            }
          }

          return privateReply(interaction, "A staff discussion thread has been created.", config);
        }

        if (sub === "switchpanel") {
          if (!isSupport(interaction.member, config)) {
            return privateReply(interaction, "Only support staff can change a ticket's support team.", config);
          }

          const role = interaction.options.getRole("role", true);

          await interaction.channel.permissionOverwrites.edit(role.id, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          });

          current.panel = role.name;
          save();

          return privateReply(interaction, "The ticket's support team has been updated.", config);
        }

        if (sub === "transcript") {
          if (!isSupport(interaction.member, config)) {
            return privateReply(interaction, "Only support staff can generate transcripts.", config);
          }

          const messages = await interaction.channel.messages.fetch({ limit: 100 });
          const transcript = [...messages.values()]
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map((message) => {
              const time = new Date(message.createdTimestamp).toISOString();
              const content = message.content || "[No text content]";
              return `[${time}] ${message.author.tag}: ${content}`;
            })
            .join("\n");

          const safeTranscript = Buffer.from(transcript, "utf8");

          await sendLog(
            interaction.guild,
            config,
            `A ticket transcript was generated by <@${interaction.user.id}>.`
          );

          return interaction.reply({
            content: "Here is the ticket transcript.",
            files: [
              {
                attachment: safeTranscript,
                name: "ticket-transcript.txt",
              },
            ],
            flags: MessageFlags.Ephemeral,
          });
        }
      }
    }

    // ----------------------------------------------------------
    // BUTTONS AND SELECT MENUS
    // ----------------------------------------------------------

    if (interaction.isButton()) {
      if (isBlacklisted(interaction.guildId, interaction.user.id)) {
        return privateReply(interaction, "You cannot use HelpDesk in this server.", config);
      }

      const id = interaction.customId;

      if (id === "open_ticket") {
        const result = await createTicket(
          interaction.guild,
          interaction.user,
          config
        );

        if (result.error) {
          return privateReply(interaction, result.error, config);
        }

        return privateReply(
          interaction,
          `Your ticket has been created: ${result.channel}`,
          config
        );
      }

      if (id.startsWith("config_")) {
        if (!isAdmin(interaction.member, config)) {
          return privateReply(interaction, "Only server administrators can change HelpDesk settings.", config);
        }

        if (id === "config_text") {
          const modal = new ModalBuilder()
            .setCustomId("config_text_modal")
            .setTitle("Ticket Panel Text");

          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("panel_title")
                .setLabel("Panel title")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(100)
                .setValue(config.panelTitle)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("panel_description")
                .setLabel("Panel description")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(1500)
                .setValue(config.panelDescription)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("panel_button")
                .setLabel("Button text")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(80)
                .setValue(config.panelButton)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("welcome_message")
                .setLabel("Ticket welcome message")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(1000)
                .setValue(config.welcomeMessage)
            )
          );

          return interaction.showModal(modal);
        }

        if (id === "config_role") {
          return interaction.reply({
            components: [
              container(config, text("## Support Role\nChoose the role that should have access to support tickets.")),
              row(
                new RoleSelectMenuBuilder()
                  .setCustomId("config_role_select")
                  .setPlaceholder("Choose a support role")
                  .setMinValues(1)
                  .setMaxValues(1)
              ),
            ],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          });
        }

        if (id === "config_category") {
          return interaction.reply({
            components: [
              container(config, text("## Ticket Category\nChoose the category where new tickets should be created.")),
              row(
                new ChannelSelectMenuBuilder()
                  .setCustomId("config_category_select")
                  .setPlaceholder("Choose a category")
                  .setChannelTypes(ChannelType.GuildCategory)
                  .setMinValues(1)
                  .setMaxValues(1)
              ),
            ],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          });
        }

        if (id === "config_logs") {
          return interaction.reply({
            components: [
              container(config, text("## Ticket Logs\nChoose the channel where ticket actions should be logged.")),
              row(
                new ChannelSelectMenuBuilder()
                  .setCustomId("config_log_select")
                  .setPlaceholder("Choose a log channel")
                  .setChannelTypes(ChannelType.GuildText)
                  .setMinValues(1)
                  .setMaxValues(1)
              ),
            ],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          });
        }

        if (id === "config_limit") {
          const modal = new ModalBuilder()
            .setCustomId("config_limit_modal")
            .setTitle("Ticket Limit");

          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("ticket_limit")
                .setLabel("Maximum open tickets per member (1–10)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(2)
                .setValue(String(config.ticketLimit))
            )
          );

          return interaction.showModal(modal);
        }

        if (id === "config_reset") {
          Object.assign(config, {
            staffRole: null,
            category: null,
            logChannel: null,
            ticketLimit: 1,
            autoCloseMinutes: 0,
            language: "en",
            panelTitle: "HelpDesk Support",
            panelDescription: "Need help? Open a ticket and our support team will assist you.",
            panelButton: "Open a Ticket",
            welcomeMessage: "Thank you for contacting support. A member of our team will be with you shortly.",
            panelColour: DEFAULT_COLOUR,
          });

          save();
          return privateUpdate(interaction, "HelpDesk settings have been reset.", config);
        }
      }

      const current = ticketFor(interaction.channelId);

      if (id === "ticket_keepopen") {
        return privateReply(interaction, "The ticket will remain open.", config);
      }

      if (id === "ticket_close" || id === "ticket_reopen" || id === "ticket_claim" || id === "ticket_add") {
        if (!current || current.guild !== interaction.guildId) {
          return privateReply(interaction, "This channel is not a HelpDesk ticket.", config);
        }

        if (id === "ticket_add") {
          if (!isSupport(interaction.member, config)) {
            return privateReply(interaction, "Only support staff can add members.", config);
          }

          return interaction.reply({
            components: [
              container(config, text("## Add Member\nChoose the member who should be added to this ticket.")),
              row(
                new UserSelectMenuBuilder()
                  .setCustomId("ticket_add_user")
                  .setPlaceholder("Choose a member")
                  .setMinValues(1)
                  .setMaxValues(1)
              ),
            ],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
          });
        }

        if (!ticketCanBeManaged(interaction, current, config)) {
          return privateReply(interaction, "You do not have permission to manage this ticket.", config);
        }

        if (id === "ticket_claim") {
          if (!isSupport(interaction.member, config)) {
            return privateReply(interaction, "Only support staff can claim tickets.", config);
          }

          if (current.claimedBy && current.claimedBy !== interaction.user.id) {
            if (!isAdmin(interaction.member, config)) {
              return privateReply(interaction, "This ticket is already claimed by another staff member.", config);
            }
          }

          current.claimedBy =
            current.claimedBy === interaction.user.id
              ? null
              : interaction.user.id;

          save();
          await refreshTicket(interaction, current, config);

          return privateReply(
            interaction,
            current.claimedBy ? "You have claimed this ticket." : "The ticket is now unclaimed.",
            config
          );
        }

        if (id === "ticket_close") {
          current.status = "closed";
          current.closedAt = Date.now();
          save();

          await interaction.channel.permissionOverwrites.edit(current.owner, {
            ViewChannel: true,
            SendMessages: false,
          }).catch(() => {});

          await refreshTicket(interaction, current, config);
          await sendLog(interaction.guild, config, `A ticket was closed by <@${interaction.user.id}>.`);

          return privateReply(interaction, "The ticket has been closed.", config);
        }

        if (id === "ticket_reopen") {
          current.status = "open";
          current.reopenedAt = Date.now();
          save();

          await interaction.channel.permissionOverwrites.edit(current.owner, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          }).catch(() => {});

          await refreshTicket(interaction, current, config);
          return privateReply(interaction, "The ticket has been reopened.", config);
        }
      }
    }

    if (interaction.isRoleSelectMenu() && interaction.customId === "config_role_select") {
      if (!isAdmin(interaction.member, config)) {
        return privateReply(interaction, "Only server administrators can configure HelpDesk.", config);
      }

      config.staffRole = interaction.values[0];
      save();

      return privateUpdate(interaction, "The support role has been saved.", config);
    }

    if (interaction.isChannelSelectMenu()) {
      if (!isAdmin(interaction.member, config)) {
        return privateReply(interaction, "Only server administrators can configure HelpDesk.", config);
      }

      if (interaction.customId === "config_category_select") {
        config.category = interaction.values[0];
        save();

        return privateUpdate(interaction, "The ticket category has been saved.", config);
      }

      if (interaction.customId === "config_log_select") {
        config.logChannel = interaction.values[0];
        save();

        return privateUpdate(interaction, "The log channel has been saved.", config);
      }
    }

    if (interaction.isUserSelectMenu() && interaction.customId === "ticket_add_user") {
      const current = ticketFor(interaction.channelId);

      if (!current || !isSupport(interaction.member, config)) {
        return privateReply(interaction, "Only support staff can add ticket participants.", config);
      }

      const userId = interaction.values[0];

      await interaction.channel.permissionOverwrites.edit(userId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
      });

      return privateReply(interaction, "The member has been added to the ticket.", config);
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === "config_text_modal") {
        if (!isAdmin(interaction.member, config)) {
          return privateReply(interaction, "Only server administrators can configure HelpDesk.", config);
        }

        config.panelTitle = interaction.fields.getTextInputValue("panel_title");
        config.panelDescription = interaction.fields.getTextInputValue("panel_description");
        config.panelButton = interaction.fields.getTextInputValue("panel_button");
        config.welcomeMessage = interaction.fields.getTextInputValue("welcome_message");

        save();

        return privateReply(
          interaction,
          "Your panel text has been saved. Run `/helpdesk panel` again to publish the updated panel.",
          config
        );
      }

      if (interaction.customId === "config_limit_modal") {
        if (!isAdmin(interaction.member, config)) {
          return privateReply(interaction, "Only server administrators can configure HelpDesk.", config);
        }

        const value = Number(interaction.fields.getTextInputValue("ticket_limit"));

        if (!Number.isInteger(value) || value < 1 || value > 10) {
          return privateReply(interaction, "Enter a whole number between 1 and 10.", config);
        }

        config.ticketLimit = value;
        save();

        return privateReply(interaction, "The ticket limit has been saved.", config);
      }

      if (interaction.customId === "ticket_edit_modal") {
        const current = ticketFor(interaction.channelId);

        if (!current || !isSupport(interaction.member, config)) {
          return privateReply(interaction, "Only support staff can edit this ticket.", config);
        }

        config.welcomeMessage = interaction.fields.getTextInputValue("ticket_welcome");
        save();

        await refreshTicket(interaction, current, config);
        return privateReply(interaction, "The ticket welcome message has been updated.", config);
      }
    }
  } catch (error) {
    console.error("HelpDesk interaction error:", error);

    const config = interaction.guildId
      ? configFor(interaction.guildId)
      : null;

    const response = {
      components: [
        container(config, text("Something went wrong while processing that action. Please try again.")),
      ],
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    };

    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(response).catch(() => {});
      } else {
        await interaction.reply(response).catch(() => {});
      }
    }
  }
});

// ============================================================
// START
// ============================================================

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();

