import { Client, Events, GatewayIntentBits, type Message } from "discord.js";

import { loadCompanionConfig } from "./config.js";
import { routeMessage } from "./message-router.js";
import { forwardToWorker } from "./worker-client.js";

const config = loadCompanionConfig(process.env);
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
let stopping = false;

client.once(Events.ClientReady, (readyClient) => {
  if (readyClient.application?.id !== config.discordApplicationId) {
    log("companion_configuration_mismatch");
    process.exitCode = 1;
    shutdown();
    return;
  }
  log("companion_ready");
});

client.on(Events.MessageCreate, (message) => {
  const routed = routeMessage(toView(message), config);
  if (!routed) return;
  void forwardToWorker(config, routed)
    .then((status) => {
      log(`companion_${routed.kind}_${status}`);
    })
    .catch(() => log(`companion_${routed.kind}_unavailable`));
});
client.on(Events.Error, () => log("companion_client_error"));
client.on(Events.Warn, () => log("companion_client_warning"));
client.on(Events.ShardError, () => log("companion_shard_error"));

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await client.login(config.discordBotToken);
} catch {
  log("companion_login_failed");
  process.exitCode = 1;
  shutdown();
}

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  log("companion_stopping");
  client.destroy();
}

function toView(message: Message) {
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author.id,
    authorIsBot: message.author.bot,
    authorIsSystem: message.author.system,
    messageIsSystem: message.system,
    webhookId: message.webhookId,
    applicationId: message.applicationId,
    content: message.content,
    createdAt: message.createdAt,
    messageType: message.type,
    flags: message.flags.bitfield,
    reference: message.reference
      ? { ...message.reference, type: message.reference.type ?? 0 }
      : null,
  };
}

function log(event: string): void {
  console.info(JSON.stringify({ event }));
}
