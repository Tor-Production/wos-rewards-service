/** Counts attempted statements (including failed batches), not binding API calls. */
export function budgetDatabase(database: D1Database, limit: number): D1Database {
  let used = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const charge = (n: number) => {
    if (used + n > limit) throw new Error("handler_budget_exceeded");
    used += n;
  };
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, key) {
        if (key === "bind")
          return (...args: Parameters<D1PreparedStatement["bind"]>) => {
            if (args.length > 100) throw new Error("binding_budget_exceeded");
            return wrap(target.bind(...args));
          };
        if (["run", "all", "first", "raw"].includes(String(key)))
          return (...args: unknown[]) => {
            charge(1);
            return Reflect.apply(
              Reflect.get(target, key) as (...args: unknown[]) => unknown,
              target,
              args,
            );
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, stmt);
    return proxy;
  };
  return new Proxy(database, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          charge(statements.length);
          return target.batch(statements.map((s) => originals.get(s) ?? s));
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export const terminalStatuses =
  "'success','already_redeemed','permanent_failure','retry_exhausted'";
export const mutableOperation =
  "o.summary_state='none' AND o.state NOT IN ('summarized','stale_closed') AND (o.type<>'repair_run' OR o.repair_authorized_at IS NOT NULL)";
export function progress(
  db: D1Database,
  lane: string,
  cursor: string,
  turn = 0,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO scheduler_progress(lane,cursor,turn) VALUES (?1,?2,?3)
    ON CONFLICT(lane) DO UPDATE SET cursor=excluded.cursor,turn=excluded.turn`,
    )
    .bind(lane, cursor, turn);
}
export function rotation(lane: string, column = "o.operation_id"): string {
  // lane is always a private literal, never user input.
  return `CASE WHEN ${column}>COALESCE((SELECT cursor FROM scheduler_progress WHERE lane='${lane}'),'') THEN 0 ELSE 1 END, ${column}`;
}
export function freeze(db: D1Database, now: string, operationId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE operations AS o SET summary_state='sealing',state='awaiting_summary',
    frozen_at=?1,updated_at=?1 WHERE operation_id=?2 AND ${mutableOperation} AND deadline_at>?1
    AND expansion_state='expanded' AND expected_count=(SELECT COUNT(*) FROM operation_items i WHERE i.operation_id=o.operation_id)
    AND NOT EXISTS (SELECT 1 FROM operation_items i WHERE i.operation_id=o.operation_id AND i.status NOT IN (${terminalStatuses}))`,
    )
    .bind(now, operationId);
}
