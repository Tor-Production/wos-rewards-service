import { DurableObject } from "cloudflare:workers";
import { GatewayDurableAdapter } from "./durable-adapter";
import type {
  GatewayAdapterDependencies,
  GatewayAdapterInspection,
  GatewayAdapterStorage,
} from "./durable-adapter-types";

class CloudflareGatewayAdapterStorage implements GatewayAdapterStorage {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.#storage.get<T>(key);
  }

  put<T>(key: string, value: T): Promise<void> {
    return this.#storage.put(key, value);
  }

  delete(key: string): Promise<boolean> {
    return this.#storage.delete(key);
  }

  getAlarm(): Promise<number | null> {
    return this.#storage.getAlarm();
  }

  setAlarm(scheduledTimeMs: number): Promise<void> {
    return this.#storage.setAlarm(scheduledTimeMs);
  }

  deleteAlarm(): Promise<void> {
    return this.#storage.deleteAlarm();
  }
}

/**
 * A real Durable Object class exported solely so the Workers Vitest runtime can bind it.
 * `wrangler.jsonc` deliberately contains no namespace, migration, route or start trigger.
 */
export class LocalDiscordGatewayAdapter extends DurableObject<Env> {
  readonly #adapter: GatewayDurableAdapter;
  readonly #ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#adapter = new GatewayDurableAdapter(
      new CloudflareGatewayAdapterStorage(ctx.storage),
      env,
    );
    this.#ready = ctx.blockConcurrencyWhile(() => this.#adapter.hydrate());
  }

  /** In-isolate test seam; intentionally unreachable from the public Worker. */
  async configureForLocalTest(dependencies: GatewayAdapterDependencies): Promise<void> {
    await this.#ready;
    await this.#adapter.configure(dependencies);
  }

  /** In-isolate test seam; the deployed Worker has no binding or route capable of calling it. */
  async startForLocalTest(): Promise<void> {
    await this.#ready;
    await this.#adapter.start();
  }

  /** Redacted local inspection surface used by deterministic tests. */
  async inspectForLocalTest(): Promise<GatewayAdapterInspection> {
    await this.#ready;
    return this.#adapter.inspect();
  }

  override async alarm(): Promise<void> {
    await this.#ready;
    await this.#adapter.alarm();
  }

  override fetch(): Response {
    return new Response(null, { status: 404 });
  }
}
