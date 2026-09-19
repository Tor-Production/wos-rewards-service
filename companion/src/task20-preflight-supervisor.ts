import type { Worker } from "node:worker_threads";

type IsolatedWorker = Pick<Worker, "once" | "removeListener" | "terminate">;

/** An operation deadline plus a cleanup reserve form one hard total deadline. */
export async function runBoundedPreflight(
  worker: IsolatedWorker,
  operationMs: number,
  cleanupMs: number,
  hardStop: () => never,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const outcome = await new Promise<boolean>((resolve) => {
    const finish = (passed: boolean) => {
      clearTimeout(timer);
      worker.removeListener("message", onMessage);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);
      resolve(passed);
    };
    const onMessage = (message: unknown) => finish(message === "ready");
    const onError = () => finish(false);
    const onExit = () => finish(false);
    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    timer = setTimeout(() => finish(false), operationMs);
  });

  // terminate() stops a pending gateway-information fetch as well as any late
  // login completion. Never report the result until termination is complete.
  let cleanupTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      worker.terminate(),
      new Promise<never>((_resolve, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error("cleanup deadline")), cleanupMs);
      }),
    ]);
  } catch {
    // This is a dedicated one-shot process. If thread termination fails, stop
    // the process itself so no Discord work can continue past the total bound.
    hardStop();
  } finally {
    clearTimeout(cleanupTimer);
  }
  return outcome;
}
