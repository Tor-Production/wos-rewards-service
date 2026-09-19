/** Temporary staging cutover version. It never opens D1 or calls a provider. */
export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 503 });
  },
  async scheduled(): Promise<void> {},
  async queue(batch: MessageBatch<unknown>): Promise<void> {
    for (const message of batch.messages) message.retry({ delaySeconds: 60 });
  },
} satisfies ExportedHandler<Env>;
