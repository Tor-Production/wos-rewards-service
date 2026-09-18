import { request } from "node:https";
import { ENDPOINT, ExperimentStop, type WireRequest, type WireResponse } from "./probe.js";

// Native HTTPS performs no redirect handling, SDK retry, cookie persistence, or authentication.
export function onePost(input: WireRequest): Promise<WireResponse> {
  if (input.url !== ENDPOINT || input.method !== "POST" || input.redirect !== "error")
    return Promise.reject(new ExperimentStop("transport_guard"));
  return new Promise((resolve, reject) => {
    const req = request(
      ENDPOINT,
      {
        method: "POST",
        agent: false,
        signal: input.signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(input.body),
          Accept: "application/json, text/plain, */*",
          Origin: "https://wos-giftcode.centurygame.com",
          Referer: "https://wos-giftcode.centurygame.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          resolve({ status, body: {} });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) {
            res.destroy();
            reject(new ExperimentStop("response_too_large"));
          } else chunks.push(chunk);
        });
        res.on("error", () => reject(new ExperimentStop("transport_unresolved")));
        res.on("end", () => {
          try {
            resolve({
              status,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
            });
          } catch {
            resolve({ status, body: null });
          }
        });
      },
    );
    req.on("error", () => reject(new ExperimentStop("transport_unresolved")));
    req.end(input.body);
  });
}
