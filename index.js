require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  PermissionFlagsBits,
  EmbedBuilder
} = require('discord.js');
const express = require('express');
const fs = require('fs').promises;

// ================= RENDER HTTP SERVER =================
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '8mb' }));

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: client.user?.tag || 'starting',
    uptime: Math.floor(process.uptime()),
    protectedChannels: webhookRegistry.size,
    proxyEndpoint: `${process.env.BASE_URL}/webhook/:channelId`,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

// Simple per-channel rate limit (no API key needed)
const proxyRateLimits = new Map();
function checkProxyRateLimit(channelId) {
  const now = Date.now();
  const limit = proxyRateLimits.get(channelId);
  if (!limit || now > limit.resetTime) {
    proxyRateLimits.set(channelId, { count: 1, resetTime: now + 60000 });
    return { allowed: true };
  }
  if (limit.count >= 120) {
    return { allowed: false, retryAfter: Math.ceil((limit.resetTime - now) / 1000) };
  }
  limit.count++;
  return { allowed: true };
}

// STABLE PROXY ENDPOINT — this is the only URL you ever need
app.post('/webhook/:channelId', async (req, res) => {
  const { channelId } = req.params;
  
  const rateLimit = checkProxyRateLimit(channelId);
  if (!rateLimit.allowed) {
    return res.status(429).json({ error: 'Rate limited', retryAfter: rateLimit.retryAfter });
  }

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const result = await proxyToWebhook(channelId, req.body);
  
  if (result.success) {
    res.status(200).json({ success: true, messageId: result.messageId });
  } else {
    res.status(result.status || 500).json({ error: result.error, detail: result.detail });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP] Proxy live on port ${PORT}`);
});

// ================= CONFIG =================
const CONFIG = {
  rotationInterval: 5 * 60 * 1000,
  spamThreshold: parseInt(process.env.SPAM_THRESHOLD) || 10,
  spamWindow: parseInt(process.env.SPAM_WINDOW) || 5000,
  configPath: './webhook-configs.json'
};

// ================= BOT SETUP =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const webhookRegistry = new Map();
const spamCooldowns = new Set();
const rotationLocks = new Set();

// ================= PERSISTENCE =================
// Saves webhook configs so they survive bot restarts
async function saveConfig() {
  const data = {};
  for (const [channelId, reg] of webhookRegistry) {
    data[channelId] = {
      name: reg.name,
      avatar: reg.avatar,
      guildId: reg.guildId,
      webhookId: reg.id,
      webhookToken: reg.token
    };
  }
  await fs.writeFile(CONFIG.configPath, JSON.stringify(data, null, 2)).catch(() => {});
}

async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG.configPath, 'utf8');
    const data = JSON.parse(raw);
    console.log(`[CONFIG] Loading ${Object.keys(data).length} saved webhooks...`);

    for (const [channelId, cfg] of Object.entries(data)) {
      try {
        // Try to connect to existing webhook
        const wh = await client.fetchWebhook(cfg.webhookId, cfg.webhookToken);
        webhookRegistry.set(channelId, {
          id: wh.id,
          token: wh.token,
          url: wh.url,
          name: cfg.name,
          avatar: cfg.avatar,
          messageTimes: [],
          createdAt: Date.now(),
          guildId: cfg.guildId
        });
        console.log(`[CONFIG] Restored ${wh.id} in channel ${channelId}`);
      } catch {
        // Webhook gone — recreate with saved name/avatar
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          console.log(`[CONFIG] Recreating webhook in channel ${channelId}`);
          await createProtectedWebhook(channel, cfg.name, cfg.avatar);
        }
      }
    }
  } catch {
    console.log('[CONFIG] No saved config found (first boot?)');
  }
}

// ================= SLASH COMMANDS =================
const commands = [
  new SlashCommandBuilder()
    .setName('webhook-create')
    .setDescription('Protect an existing webhook — provide its URL and I will guard it')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageWebhooks)
    .addStringOption(opt => 
      opt.setName('url')
        .setDescription('The Discord webhook URL to protect')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('webhook-delete')
    .setDescription('Remove protection and delete the guarded webhook')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageWebhooks),

  new SlashCommandBuilder()
    .setName('webhook-info')
    .setDescription('Show protected webhook status for this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageWebhooks),

  new SlashCommandBuilder()
    .setName('webhook-rotate')
    .setDescription('Manually rotate the webhook now')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageWebhooks),

  new SlashCommandBuilder()
    .setName('webhook-list')
    .setDescription('List all guarded webhooks')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageWebhooks),

  new SlashCommandBuilder()
    .setName('webhook-url')
    .setDescription('Resend the stable webhook URL to your DMs')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageWebhooks),
];

// ================= WEBHOOK MANAGEMENT =================
async function createProtectedWebhook(channel, name, avatar) {
  try {
    const webhook = await channel.createWebhook({
      name: name,
      avatar: avatar,
      reason: 'Webhook Guard'
    });

    webhookRegistry.set(channel.id, {
      id: webhook.id,
      token: webhook.token,
      url: webhook.url,
      name: name,
      avatar: avatar,
      messageTimes: [],
      createdAt: Date.now(),
      guildId: channel.guild.id
    });

    await saveConfig();
    console.log(`[+] Webhook ${webhook.id} active in #${channel.name}`);
    return webhook;
  } catch (err) {
    console.error(`[!] Create failed in #${channel.name}:`, err.message);
    return null;
  }
}

async function deleteProtectedWebhook(channelId) {
  const reg = webhookRegistry.get(channelId);
  if (!reg) return false;

  try {
    const wh = await client.fetchWebhook(reg.id, reg.token).catch(() => null);
    if (wh) await wh.delete('Webhook Guard removal');
    webhookRegistry.delete(channelId);
    await saveConfig();
    return true;
  } catch (err) {
    console.error('[!] Delete failed:', err);
    return false;
  }
}

async function rotateWebhook(channelId, manual = false) {
  if (rotationLocks.has(channelId)) return null;
  rotationLocks.add(channelId);

  const reg = webhookRegistry.get(channelId);
  if (!reg) { rotationLocks.delete(channelId); return null; }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) { rotationLocks.delete(channelId); return null; }

  console.log(`[↻] Rotating webhook for #${channel.name}`);

  try {
    const old = await client.fetchWebhook(reg.id, reg.token).catch(() => null);
    if (old) await old.delete(manual ? 'Manual rotation' : 'Scheduled rotation');
    const newWh = await createProtectedWebhook(channel, reg.name, reg.avatar);
    rotationLocks.delete(channelId);
    return newWh;
  } catch (err) {
    console.error('[!] Rotation failed:', err);
    rotationLocks.delete(channelId);
    return null;
  }
}

// ================= PROXY TO DISCORD =================
async function proxyToWebhook(channelId, payload, attempt = 1) {
  const reg = webhookRegistry.get(channelId);
  if (!reg) {
    return { success: false, status: 404, error: 'No protected webhook for this channel. Run /webhook-create first.' };
  }

  try {
    const discordRes = await fetch(`${reg.url}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (discordRes.ok) {
      const data = await discordRes.json();
      return { success: true, messageId: data.id };
    }

    // Webhook deleted or invalid — recreate and retry once
    if ((discordRes.status === 404 || discordRes.status === 401) && attempt === 1) {
      console.log(`[!] Webhook ${reg.id} invalid during proxy. Recreating...`);
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel) {
        const newWh = await createProtectedWebhook(channel, reg.name, reg.avatar);
        if (newWh) return proxyToWebhook(channelId, payload, attempt + 1);
      }
      return { success: false, status: 502, error: 'Webhook was deleted and could not be recreated' };
    }

    if (discordRes.status === 429) {
      const retryAfter = discordRes.headers.get('retry-after') || 5;
      return { success: false, status: 429, error: 'Discord rate limit', retryAfter };
    }

    const errorText = await discordRes.text();
    return { success: false, status: 502, error: `Discord error ${discordRes.status}`, detail: errorText };

  } catch (err) {
    console.error('[!] Proxy error:', err);
    return { success: false, status: 500, error: 'Internal proxy error', detail: err.message };
  }
}

// ================= ANTI-SPAM =================
function isSpamming(channelId) {
  const reg = webhookRegistry.get(channelId);
  if (!reg) return false;
  const now = Date.now();
  reg.messageTimes = reg.messageTimes.filter(t => now - t < CONFIG.spamWindow);
  return reg.messageTimes.length >= CONFIG.spamThreshold;
}

async function handleSpam(channelId) {
  const reg = webhookRegistry.get(channelId);
  if (!reg || spamCooldowns.has(reg.id)) return;

  spamCooldowns.add(reg.id);
  console.log(`[!] Spam detected! Nuking webhook ${reg.id}`);

  try {
    const wh = await client.fetchWebhook(reg.id, reg.token);
    await wh.delete('Anti-spam: rate limit exceeded');

    const channel = await client.channels.fetch(channelId);
    const messages = await channel.messages.fetch({ limit: 50 });
    const spam = messages.filter(m => m.author?.id === reg.id);
    if (spam.size > 0) await channel.bulkDelete(spam).catch(() => {});

    await createProtectedWebhook(channel, reg.name, reg.avatar);
  } catch (err) {
    console.error('[!] Spam remediation failed:', err);
  } finally {
    setTimeout(() => spamCooldowns.delete(reg.id), 10000);
  }
}

// ================= INTEGRITY CHECK =================
async function checkIntegrity() {
  for (const [channelId, reg] of webhookRegistry) {
    try {
      await client.fetchWebhook(reg.id, reg.token);
    } catch (err) {
      if (err.code === 10015) {
        console.log(`[!] Webhook ${reg.id} deleted! Recreating...`);
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) await createProtectedWebhook(channel, reg.name, reg.avatar);
      }
    }
  }
}

// ================= EVENTS =================
client.on('messageCreate', async (message) => {
  if (!message.webhookId || !webhookRegistry.has(message.channel.id)) return;
  
  const reg = webhookRegistry.get(message.channel.id);
  if (reg.id !== message.webhookId) return;

  reg.messageTimes.push(Date.now());
  if (isSpamming(message.channel.id)) await handleSpam(message.channel.id);
});

client.on('webhooksUpdate', async (channel) => {
  if (!webhookRegistry.has(channel.id)) return;
  if (rotationLocks.has(channel.id)) return; // Rotation in progress, ignore

  setTimeout(async () => {
    const reg = webhookRegistry.get(channel.id);
    if (!reg) return;
    try {
      await client.fetchWebhook(reg.id, reg.token);
    } catch {
      console.log(`[!] webhooksUpdate: missing webhook in #${channel.name}`);
      await createProtectedWebhook(channel, reg.name, reg.avatar);
    }
  }, 1000);
});

// ================= SLASH COMMAND HANDLER =================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, channel, user } = interaction;

  await interaction.deferReply({ ephemeral: true });

  try {
    switch (commandName) {
      case 'webhook-create': {
        const url = interaction.options.getString('url');
        
        // Parse Discord webhook URL
        const match = url.match(/https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/(\d+)\/([\w-]+)/);
        if (!match) {
          return interaction.editReply('❌ Invalid Discord webhook URL.\nFormat: `https://discord.com/api/webhooks/123/abc`');
        }

        const [, providedId, providedToken] = match;

        // Fetch the webhook to verify it exists and get its identity
        let webhook;
        try {
          webhook = await client.fetchWebhook(providedId, providedToken);
        } catch {
          return interaction.editReply('❌ Could not fetch that webhook. Is the URL correct? Does the bot share a server with it?');
        }

        const targetChannel = await client.channels.fetch(webhook.channelId);
        if (!targetChannel) {
          return interaction.editReply('❌ Could not find the channel for that webhook.');
        }

        // Check bot permissions
        const perms = targetChannel.permissionsFor(client.user);
        if (!perms?.has(PermissionFlagsBits.ManageWebhooks)) {
          return interaction.editReply('❌ I need **Manage Webhooks** permission in that channel.');
        }

        // Save the original identity
        const savedName = webhook.name;
        const savedAvatar = webhook.avatarURL({ extension: 'png', size: 4096 });

        // If this channel already has a protected webhook, delete it first
        if (webhookRegistry.has(targetChannel.id)) {
          await deleteProtectedWebhook(targetChannel.id);
        }

        // Delete the user's original webhook (so they must use the stable URL)
        await webhook.delete('Adopted by Webhook Guard');

        // Create fresh webhook with the exact same name and avatar
        const newWebhook = await createProtectedWebhook(targetChannel, savedName, savedAvatar);
        if (!newWebhook) {
          return interaction.editReply('❌ Failed to recreate the webhook. Check my permissions.');
        }

        const stableUrl = `${process.env.BASE_URL}/webhook/${targetChannel.id}`;

        const embed = new EmbedBuilder()
          .setTitle('🔒 Webhook Protected')
          .setDescription(`Adopted **${savedName}** from <#${targetChannel.id}>`)
          .addFields(
            { name: 'Original Webhook', value: '✅ Deleted (raw URL is now dead)', inline: true },
            { name: 'Auto-Rotation', value: 'Every 5 minutes', inline: true },
            { name: 'Anti-Spam', value: `${CONFIG.spamThreshold} msgs / ${CONFIG.spamWindow}ms`, inline: true }
          )
          .setColor(0x00FF00)
          .setThumbnail(savedAvatar)
          .setTimestamp();

        await interaction.editReply({
          content: `🔒 **Your stable webhook URL (never changes):**\n\`\`\`\nPOST ${stableUrl}\nContent-Type: application/json\n\`\`\`\nSend any JSON payload you'd normally send to Discord. I handle rotation and recreation automatically.`,
          embeds: [embed]
        });
        break;
      }

      case 'webhook-delete': {
        if (!channel) return interaction.editReply('❌ Run this in a server channel.');
        const success = await deleteProtectedWebhook(channel.id);
        await interaction.editReply(success 
          ? '🗑️ Protection removed. The stable URL will now return 404.' 
          : '❌ No protected webhook in this channel.');
        break;
      }

      case 'webhook-info': {
        if (!channel) return interaction.editReply('❌ Run this in a server channel.');
        const reg = webhookRegistry.get(channel.id);
        if (!reg) return interaction.editReply('❌ Nothing here. Use `/webhook-create` with a webhook URL.');

        const embed = new EmbedBuilder()
          .setTitle('🔒 Webhook Status')
          .addFields(
            { name: 'Name', value: reg.name, inline: true },
            { name: 'ID', value: reg.id, inline: true },
            { name: 'Created', value: `<t:${Math.floor(reg.createdAt / 1000)}:R>`, inline: true },
            { name: 'Stable URL', value: `\`${process.env.BASE_URL}/webhook/${channel.id}\``, inline: false },
            { name: 'Status', value: '✅ Active', inline: true }
          )
          .setColor(0x0099FF);

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'webhook-rotate': {
        if (!channel) return interaction.editReply('❌ Run this in a server channel.');
        if (!webhookRegistry.has(channel.id)) return interaction.editReply('❌ Nothing to rotate.');
        
        await interaction.editReply('🔄 Rotating...');
        const newWh = await rotateWebhook(channel.id, true);
        await interaction.editReply(newWh 
          ? `✅ Rotated! New internal ID: \`${newWh.id}\`\nStable URL unchanged.` 
          : '❌ Rotation failed.');
        break;
      }

      case 'webhook-list': {
        if (webhookRegistry.size === 0) return interaction.editReply('📭 No protected webhooks.');

        const embed = new EmbedBuilder()
          .setTitle('🔒 Protected Webhooks')
          .setDescription(`Total: **${webhookRegistry.size}**`)
          .setColor(0x0099FF);

        for (const [channelId, reg] of webhookRegistry) {
          const ch = await client.channels.fetch(channelId).catch(() => null);
          const g = await client.guilds.fetch(reg.guildId).catch(() => null);
          embed.addFields({
            name: `${ch ? `#${ch.name}` : 'Unknown'} (${g?.name || 'Unknown'})`,
            value: `Stable: \`${process.env.BASE_URL}/webhook/${channelId}\``,
            inline: false
          });
        }
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'webhook-url': {
        if (!channel) return interaction.editReply('❌ Run this in a server channel.');
        if (!webhookRegistry.has(channel.id)) return interaction.editReply('❌ No webhook here. Run `/webhook-create` first.');

        const stableUrl = `${process.env.BASE_URL}/webhook/${channel.id}`;

        try {
          await user.send({
            content: `🔒 **Stable Webhook URL for <#${channel.id}>**\nThis URL **never changes** — I handle rotation internally.\n\`\`\`\nPOST ${stableUrl}\nContent-Type: application/json\n\`\`\`\n**Example body:**\n\`\`\`json\n{\n  "content": "Hello via protected webhook!",\n  "username": "Custom Name",\n  "avatar_url": "https://example.com/avatar.png"\n}\n\`\`\``
          });
          await interaction.editReply('📩 Sent to your DMs!');
        } catch {
          await interaction.editReply('❌ Could not DM you. Enable DMs from server members.');
        }
        break;
      }
    }
  } catch (err) {
    console.error(`[!] Command error (${commandName}):`, err);
    await interaction.editReply('❌ An error occurred.');
  }
});

// ================= STARTUP =================
client.once('ready', async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);

  // Register slash commands globally
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('[CMD] Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands.map(cmd => cmd.toJSON()) }
    );
    console.log(`[CMD] Registered ${commands.length} commands`);
  } catch (err) {
    console.error('[CMD] Registration failed:', err);
  }

  // Restore webhooks from disk (or recreate if they were deleted while bot was down)
  await loadConfig();

  // Start monitoring
  setInterval(checkIntegrity, 30000);
  setInterval(() => {
    for (const [id] of webhookRegistry) rotateWebhook(id);
  }, CONFIG.rotationInterval);

  console.log('[BOT] Operational. Proxy ready.');
});

client.login(process.env.DISCORD_TOKEN);
