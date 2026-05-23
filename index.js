require('dotenv').config();
const { Client, GatewayIntentBits, WebhookClient } = require('discord.js');
const express = require('express');

// ================= RENDER HTTP SERVER =================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: client.user?.tag || 'starting',
    uptime: Math.floor(process.uptime()),
    protectedChannels: CONFIG.protectedChannels.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP] Health endpoint live on port ${PORT}`);
});

// ================= CONFIG =================
const CONFIG = {
  rotationInterval: 5 * 60 * 1000, // 5 minutes
  spamThreshold: parseInt(process.env.SPAM_THRESHOLD) || 10,
  spamWindow: parseInt(process.env.SPAM_WINDOW) || 5000,
  protectedChannels: (process.env.PROTECTED_CHANNELS || '').split(',').filter(Boolean),
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

// ================= WEBHOOK MANAGEMENT =================
async function createProtectedWebhook(channel, name = 'Protected-Webhook', avatar = null) {
  try {
    const existing = await channel.fetchWebhooks();
    for (const [_, wh] of existing) {
      if (wh.name.startsWith('Protected-')) {
        await wh.delete('Cleanup before recreate').catch(() => {});
      }
    }

    const webhook = await channel.createWebhook({
      name: name,
      avatar: avatar,
      reason: 'Protected webhook provisioning'
    });

    webhookRegistry.set(channel.id, {
      id: webhook.id,
      token: webhook.token,
      url: webhook.url,
      name: webhook.name,
      avatar: webhook.avatarURL(),
      messageTimes: [],
      createdAt: Date.now()
    });

    console.log(`[+] Webhook ${webhook.id} active in #${channel.name}`);
    return webhook;
  } catch (err) {
    console.error(`[!] Create failed in #${channel.name}:`, err.message);
    return null;
  }
}

async function rotateWebhook(channelId) {
  const registry = webhookRegistry.get(channelId);
  if (!registry) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  console.log(`[↻] Rotating webhook for #${channel.name}`);

  try {
    const old = await client.fetchWebhook(registry.id, registry.token).catch(() => null);
    if (old) await old.delete('Scheduled security rotation');
    await createProtectedWebhook(channel, registry.name, registry.avatar);
  } catch (err) {
    console.error('[!] Rotation failed:', err);
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
  for (const channelId of CONFIG.protectedChannels) {
    const reg = webhookRegistry.get(channelId);
    if (!reg) continue;

    try {
      await client.fetchWebhook(reg.id, reg.token);
    } catch (err) {
      if (err.code === 10015) {
        console.log(`[!] Webhook deleted! Recreating...`);
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) await createProtectedWebhook(channel, reg.name, reg.avatar);
      }
    }
  }
}

// ================= EVENTS =================
client.on('messageCreate', async (message) => {
  if (!message.webhookId || !CONFIG.protectedChannels.includes(message.channel.id)) return;
  
  const reg = webhookRegistry.get(message.channel.id);
  if (!reg || reg.id !== message.webhookId) return;

  reg.messageTimes.push(Date.now());
  if (isSpamming(message.channel.id)) await handleSpam(message.channel.id);
});

client.on('webhooksUpdate', async (channel) => {
  if (!CONFIG.protectedChannels.includes(channel.id)) return;
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

// ================= STARTUP =================
client.once('ready', async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);

  for (const channelId of CONFIG.protectedChannels) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.error(`[!] Channel ${channelId} not found`);
      continue;
    }
    await createProtectedWebhook(channel, 'Protected-Webhook');
  }

  setInterval(checkIntegrity, 30000);
  setInterval(() => {
    for (const id of CONFIG.protectedChannels) rotateWebhook(id);
  }, CONFIG.rotationInterval);
});

client.login(process.env.DISCORD_TOKEN);
