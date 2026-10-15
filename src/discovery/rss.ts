import { GIFT_CODE_MAX_LENGTH } from "../limits";
import { deterministicUuid } from "../ingest/identity";

/** This source is the maintainer-selected public RSS endpoint; item links are never fetched. */
export const RSS_ENDPOINT = "https://wosgiftcodes.com/rss.php";
export const RSS_SOURCE = "wosgiftcodes-rss-staging";
export const RSS_MAX_BODY_BYTES = 64 * 1024;
export const RSS_MAX_ITEMS = 100;
export const RSS_TIMEOUT_MS = 10_000;
export const RSS_MIN_POLL_SECONDS = 30 * 60;

const XML_NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  quot: '"',
});

export interface RssSourceConfig {
  readonly endpoint: typeof RSS_ENDPOINT;
  readonly timeoutMs: number;
  readonly minPollSeconds: number;
}

export interface RssCodeCandidate {
  /** A stable, non-reversible key derived from the feed's opaque item GUID. */
  readonly itemId: string;
  readonly code: string;
  readonly sourcePublishedAt: string;
}

type RetryInfo = {
  readonly retryAfterSeconds: number | null;
  readonly retryAfterInvalid: boolean;
};

type ParsedRetryAfter = {
  readonly seconds: number | null;
  readonly invalid: boolean;
};

export type RssFetchResult =
  | ({ readonly kind: "ok"; readonly candidates: readonly RssCodeCandidate[] } & RetryInfo)
  | ({ readonly kind: "access_denied" } & RetryInfo)
  | ({ readonly kind: "rate_limited" } & RetryInfo)
  | ({
      readonly kind: "transient_failure";
      readonly reason:
        "http_5xx" | "http_other" | "timeout" | "transport_error" | "body_read_error";
    } & RetryInfo)
  | ({
      readonly kind: "invalid_payload";
      readonly reason:
        | "content_length_invalid"
        | "content_length_oversize"
        | "body_oversize"
        | "content_type_invalid"
        | "xml_invalid"
        | "schema_invalid";
    } & RetryInfo);

export function loadRssSource(
  source: Readonly<Record<string, unknown>>,
  issues: string[],
): RssSourceConfig | null {
  const enabled = source.RSS_SOURCE_ENABLED;
  if (enabled === undefined || enabled === false || enabled === "false") return null;
  if (enabled !== true && enabled !== "true") {
    issues.push("RSS_SOURCE_ENABLED must be true or false");
    return null;
  }
  if (source.ENVIRONMENT !== "staging" || source.PROVIDER_MODE !== "mock")
    issues.push("RSS source requires staging and mock mode");
  return {
    endpoint: RSS_ENDPOINT,
    timeoutMs: RSS_TIMEOUT_MS,
    minPollSeconds: RSS_MIN_POLL_SECONDS,
  };
}

export async function fetchRss(
  config: RssSourceConfig,
  fetcher: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
): Promise<RssFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let readingBody = false;
  let retry: ParsedRetryAfter = { seconds: null, invalid: false };
  try {
    const response = await fetcher(config.endpoint, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/rss+xml" },
      signal: controller.signal,
    });
    // Use response receipt as the lower bound for Retry-After date headers. The runtime
    // applies any delay from its later post-body clock, so slow bodies can only extend it.
    retry = readRetryAfter(response.headers.get("retry-after"), clock().getTime());
    const withRetry = <const T extends object>(result: T): T & RetryInfo => ({
      ...result,
      retryAfterSeconds: retry.seconds,
      retryAfterInvalid: retry.invalid,
    });

    if (response.status === 401 || response.status === 403)
      return withRetry({ kind: "access_denied" });
    if (response.status === 429) return withRetry({ kind: "rate_limited" });
    if (response.status >= 300 && response.status < 400)
      return withRetry({ kind: "transient_failure", reason: "http_other" });
    if (response.status !== 200)
      return withRetry({
        kind: "transient_failure",
        reason: response.status >= 500 ? "http_5xx" : "http_other",
      });

    const contentType = response.headers.get("content-type");
    if (!contentType || !/^application\/rss\+xml(?:\s*;|\s*$)/i.test(contentType))
      return withRetry({ kind: "invalid_payload", reason: "content_type_invalid" });

    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && !/^\d+$/.test(contentLength))
      return withRetry({ kind: "invalid_payload", reason: "content_length_invalid" });
    if (contentLength !== null && Number(contentLength) > RSS_MAX_BODY_BYTES)
      return withRetry({ kind: "invalid_payload", reason: "content_length_oversize" });

    readingBody = true;
    const body = await readBoundedBody(response, RSS_MAX_BODY_BYTES);
    if (body === null) return withRetry({ kind: "invalid_payload", reason: "body_oversize" });
    let xml: string;
    try {
      xml = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      return withRetry({ kind: "invalid_payload", reason: "xml_invalid" });
    } finally {
      body.fill(0);
    }

    const candidates = await parseRssFeed(xml);
    return candidates === null
      ? withRetry({ kind: "invalid_payload", reason: "schema_invalid" })
      : withRetry({ kind: "ok", candidates });
  } catch {
    return {
      kind: "transient_failure",
      reason: controller.signal.aborted
        ? "timeout"
        : readingBody
          ? "body_read_error"
          : "transport_error",
      retryAfterSeconds: retry.seconds,
      retryAfterInvalid: retry.invalid,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Parses only the observed RSS 2.0 shape. No DTD or external-entity resolution is available. */
export async function parseRssFeed(xml: string): Promise<readonly RssCodeCandidate[] | null> {
  if (new TextEncoder().encode(xml).byteLength > RSS_MAX_BODY_BYTES) return null;
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return null;
  const root = parseXml(xml);
  if (!root || root.name !== "rss" || root.attributes.version !== "2.0") return null;
  if (
    Object.keys(root.attributes).some(
      (name) => name !== "version" && name !== "xmlns" && !name.startsWith("xmlns:"),
    ) ||
    root.children.length !== 1 ||
    root.children[0]?.name !== "channel" ||
    root.text.trim() !== ""
  )
    return null;

  const channel = root.children[0];
  if (Object.keys(channel.attributes).length !== 0 || channel.text.trim() !== "") return null;
  const allowedChannel = new Set([
    "title",
    "link",
    "description",
    "language",
    "lastBuildDate",
    "atom:link",
    "item",
  ]);
  if (channel.children.some((node) => !allowedChannel.has(node.name))) return null;
  for (const required of ["title", "link", "description", "language", "lastBuildDate"])
    if (channel.children.filter((node) => node.name === required).length !== 1) return null;
  if (channel.children.filter((node) => node.name === "atom:link").length > 1) return null;

  for (const node of channel.children.filter((child) => child.name !== "item")) {
    if (node.name === "atom:link") {
      if (
        node.children.length !== 0 ||
        node.text.trim() !== "" ||
        Object.keys(node.attributes).some((name) => !["href", "rel", "type"].includes(name)) ||
        typeof node.attributes.href !== "string" ||
        !isHttpUrl(node.attributes.href)
      )
        return null;
    } else if (!plainText(node, 2_048)) return null;
  }
  if (!parseRssDate(textOf(channel, "lastBuildDate"))) return null;

  const items = channel.children.filter((node) => node.name === "item");
  if (items.length > RSS_MAX_ITEMS) return null;
  const seenItems = new Map<string, { code: string; sourcePublishedAt: string }>();
  const candidates: RssCodeCandidate[] = [];
  for (const item of items) {
    if (Object.keys(item.attributes).length !== 0 || item.text.trim() !== "") return null;
    const fields = new Map<string, XmlNode>();
    for (const node of item.children) {
      if (!["title", "link", "guid", "pubDate"].includes(node.name) || fields.has(node.name))
        return null;
      fields.set(node.name, node);
    }
    if (fields.size !== 4) return null;
    const title = fields.get("title");
    const link = fields.get("link");
    const guid = fields.get("guid");
    const date = fields.get("pubDate");
    if (
      !title ||
      !link ||
      !guid ||
      !date ||
      !plainText(title, GIFT_CODE_MAX_LENGTH) ||
      !plainText(link, 2_048) ||
      !plainText(guid, 256) ||
      !plainText(date, 128) ||
      Object.keys(title.attributes).length !== 0 ||
      Object.keys(link.attributes).length !== 0 ||
      Object.keys(date.attributes).length !== 0 ||
      Object.keys(guid.attributes).some((name) => name !== "isPermaLink") ||
      (guid.attributes.isPermaLink !== undefined &&
        guid.attributes.isPermaLink !== "true" &&
        guid.attributes.isPermaLink !== "false")
    )
      return null;

    const code = title.text.trim();
    const itemGuid = guid.text.trim();
    const publishedAt = parseRssDate(date.text.trim());
    if (
      !/^[A-Za-z0-9_-]+$/.test(code) ||
      code.length === 0 ||
      code.length > GIFT_CODE_MAX_LENGTH ||
      itemGuid.length === 0 ||
      /[\u0000-\u001f\u007f]/.test(itemGuid) ||
      !isHttpUrl(link.text.trim()) ||
      publishedAt === null
    )
      return null;

    const itemId = await deterministicUuid(`wosgiftcodes-rss:item:${itemGuid}`);
    const existing = seenItems.get(itemId);
    if (existing) {
      if (existing.code !== code || existing.sourcePublishedAt !== publishedAt) return null;
      continue;
    }
    seenItems.set(itemId, { code, sourcePublishedAt: publishedAt });
    candidates.push({ itemId, code, sourcePublishedAt: publishedAt });
  }
  return candidates;
}

interface XmlNode {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlNode[];
  text: string;
}

function parseXml(xml: string): XmlNode | null {
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let nodes = 0;
  let index = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const appendText = (text: string, cdata = false): boolean => {
    const value = cdata ? text : decodeEntities(text);
    if (value === null) return false;
    const current = stack.at(-1);
    if (!current) return value.trim() === "";
    current.text += value;
    return current.text.length <= RSS_MAX_BODY_BYTES;
  };

  while (index < xml.length) {
    if (xml[index] !== "<") {
      const end = xml.indexOf("<", index);
      const next = end < 0 ? xml.length : end;
      if (!appendText(xml.slice(index, next))) return null;
      index = next;
      continue;
    }
    if (xml.startsWith("<!--", index)) {
      const end = xml.indexOf("-->", index + 4);
      if (end < 0) return null;
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", index)) {
      const end = xml.indexOf("]]>", index + 9);
      if (end < 0 || stack.length === 0 || !appendText(xml.slice(index + 9, end), true))
        return null;
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<?", index)) {
      const end = xml.indexOf("?>", index + 2);
      if (end < 0) return null;
      index = end + 2;
      continue;
    }
    if (xml.startsWith("<!", index)) return null;
    if (xml.startsWith("</", index)) {
      const end = xml.indexOf(">", index + 2);
      if (end < 0) return null;
      const name = xml.slice(index + 2, end).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name) || stack.at(-1)?.name !== name) return null;
      stack.pop();
      index = end + 1;
      continue;
    }

    let cursor = index + 1;
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(xml.slice(cursor));
    if (!nameMatch) return null;
    const name = nameMatch[0];
    cursor += name.length;
    const attributes: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      while (/\s/.test(xml[cursor] ?? "")) cursor++;
      if (xml[cursor] === ">") {
        cursor++;
        break;
      }
      if (xml[cursor] === "/" && xml[cursor + 1] === ">") {
        selfClosing = true;
        cursor += 2;
        break;
      }
      const attributeMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(xml.slice(cursor));
      if (!attributeMatch || Object.keys(attributes).length >= 8) return null;
      const attribute = attributeMatch[0];
      cursor += attribute.length;
      while (/\s/.test(xml[cursor] ?? "")) cursor++;
      if (xml[cursor] !== "=") return null;
      cursor++;
      while (/\s/.test(xml[cursor] ?? "")) cursor++;
      const quote = xml[cursor];
      if (quote !== "'" && quote !== '"') return null;
      const valueStart = ++cursor;
      const valueEnd = xml.indexOf(quote, valueStart);
      if (valueEnd < 0 || valueEnd - valueStart > 2_048 || Object.hasOwn(attributes, attribute))
        return null;
      const value = decodeEntities(xml.slice(valueStart, valueEnd));
      if (value === null) return null;
      attributes[attribute] = value;
      cursor = valueEnd + 1;
    }
    const node: XmlNode = { name, attributes, children: [], text: "" };
    if (++nodes > 2_048 || stack.length >= 16) return null;
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (root === null) root = node;
    else return null;
    if (!selfClosing) stack.push(node);
    index = cursor;
  }
  return stack.length === 0 ? root : null;
}

function decodeEntities(value: string): string | null {
  let decoded = "";
  for (let index = 0; index < value.length;) {
    if (value[index] !== "&") {
      decoded += value[index];
      index++;
      continue;
    }
    const end = value.indexOf(";", index + 1);
    if (end < 0 || end - index > 12) return null;
    const entity = value.slice(index + 1, end);
    let replacement = Object.hasOwn(XML_NAMED_ENTITIES, entity)
      ? XML_NAMED_ENTITIES[entity]
      : undefined;
    if (replacement === undefined) {
      const numeric = /^#(?:x([\da-f]{1,6})|(\d{1,7}))$/i.exec(entity);
      if (!numeric) return null;
      const point = numeric[1] ? Number.parseInt(numeric[1], 16) : Number.parseInt(numeric[2]!, 10);
      if (!isXmlCodePoint(point)) return null;
      replacement = String.fromCodePoint(point);
    }
    decoded += replacement;
    index = end + 1;
  }
  return decoded;
}

function isXmlCodePoint(point: number): boolean {
  return (
    point === 0x9 ||
    point === 0xa ||
    point === 0xd ||
    (point >= 0x20 && point <= 0xd7ff) ||
    (point >= 0xe000 && point <= 0xfffd) ||
    (point >= 0x10000 && point <= 0x10ffff)
  );
}

function plainText(node: XmlNode, maxLength: number): boolean {
  return (
    node.children.length === 0 &&
    node.text.trim().length > 0 &&
    node.text.length <= maxLength &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(node.text)
  );
}

function textOf(parent: XmlNode, name: string): string {
  return parent.children.find((child) => child.name === name)?.text.trim() ?? "";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseRssDate(value: string): string | null {
  const match =
    /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(GMT|UTC|UT|[+-]\d{4})$/i.exec(
      value.trim(),
    );
  if (!match) return null;
  const day = Number(match[2]);
  const month = MONTHS.indexOf(match[3]!.toLowerCase());
  const year = Number(match[4]);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = Number(match[7] ?? "0");
  const zone = match[8]!.toUpperCase();
  const daysInMonth = month >= 0 ? new Date(Date.UTC(year, month + 1, 0)).getUTCDate() : 0;
  if (
    month < 0 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (match[1] &&
      WEEKDAYS[new Date(Date.UTC(year, month, day)).getUTCDay()] !== match[1].toLowerCase())
  )
    return null;
  if (/^[+-]/.test(zone) && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(3, 5)) > 59))
    return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function isHttpUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function readRetryAfter(value: string | null, now: number): ParsedRetryAfter {
  if (value === null) return { seconds: null, invalid: false };
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds)
      ? { seconds, invalid: false }
      : { seconds: null, invalid: true };
  }
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now
    ? { seconds: Math.ceil((at - now) / 1_000), invalid: false }
    : { seconds: null, invalid: true };
}
